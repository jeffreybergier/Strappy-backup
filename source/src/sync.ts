import pLimit from "p-limit";
import type { StrappyConfig } from "./config.js";
import { listRepos, makeOctokit, type RemoteRepo } from "./github.js";
import { cloneMirror, dirSizeKb, mirrorExists, moveMirror, updateMirror } from "./git.js";
import type { Logger } from "./logger.js";
import { mirrorPath, type Paths } from "./paths.js";
import type { RepoRecord, Store, StrappyState } from "./state.js";

export type SyncAction = "cloned" | "updated" | "failed";

export interface RepoResult {
  fullName: string;
  action: SyncAction;
  sizeKb: number | null;
  error: string | null;
}

export interface SyncSummary {
  inventoryCount: number;
  results: RepoResult[];
  orphaned: string[];
  renamed: { from: string; to: string }[];
  ok: number;
  failed: number;
}

export interface SyncOptions {
  store: Store;
  paths: Paths;
  config: StrappyConfig;
  token: string;
  logger: Logger;
  /** If set, only sync these repos (still refreshes the full inventory first). */
  only?: string[];
}

export async function sync(opts: SyncOptions): Promise<SyncSummary> {
  const { store, paths, config, token, logger, only } = opts;
  const octokit = makeOctokit(token);

  logger.info("Refreshing repo inventory from GitHub…");
  const remote = await listRepos(octokit, config);
  logger.info(`Inventory: ${remote.length} repo(s).`);

  // The whole run holds the state lock: a manual sync and the daemon's
  // scheduled sync cannot collide (plan §3), with no IPC server.
  return store.transaction(async (state, checkpoint) => {
    const renamed = reconcileInventory(state, remote, paths, logger);
    const orphaned = markOrphans(state, remote);
    state.lastInventoryAt = new Date().toISOString();
    await checkpoint();

    const targets = selectTargets(remote, only);
    const limit = pLimit(Math.max(1, config.concurrency));
    const results: RepoResult[] = [];

    await Promise.all(
      targets.map((repo) =>
        limit(async () => {
          const result = await syncOne(repo, token, paths, logger);
          results.push(result);
          applyResult(state.repos[repo.fullName], result);
          await checkpoint(); // flush progress while the lock is still held
        }),
      ),
    );

    const ok = results.filter((r) => r.action !== "failed").length;
    const failed = results.length - ok;
    logger.info(`Sync complete: ${ok} ok, ${failed} failed, ${orphaned.length} orphaned.`);

    return {
      inventoryCount: remote.length,
      results,
      orphaned,
      renamed,
      ok,
      failed,
    };
  });
}

/** Upsert inventory into state, detecting renames/transfers via stable githubId. */
function reconcileInventory(
  state: StrappyState,
  remote: RemoteRepo[],
  paths: Paths,
  logger: Logger,
): { from: string; to: string }[] {
  const renamed: { from: string; to: string }[] = [];
  const existingById = new Map<number, RepoRecord>();
  for (const rec of Object.values(state.repos)) existingById.set(rec.githubId, rec);

  for (const repo of remote) {
    const prior = existingById.get(repo.githubId);
    if (prior && prior.fullName !== repo.fullName) {
      // Repo was renamed/transferred: move the mirror, re-key the record.
      const from = mirrorPath(paths.home, prior.fullName);
      const to = mirrorPath(paths.home, repo.fullName);
      moveMirror(from, to).catch((err) =>
        logger.warn(`Could not move mirror ${prior.fullName} -> ${repo.fullName}: ${String(err)}`),
      );
      delete state.repos[prior.fullName];
      logger.info(`Detected rename: ${prior.fullName} -> ${repo.fullName}`);
      renamed.push({ from: prior.fullName, to: repo.fullName });
    }

    const current = state.repos[repo.fullName];
    state.repos[repo.fullName] = {
      githubId: repo.githubId,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      archived: repo.archived,
      private: repo.private,
      orphaned: false,
      lastSync: current?.lastSync ?? null,
      lastSyncOk: current?.lastSyncOk ?? null,
      lastError: current?.lastError ?? null,
      sizeKb: current?.sizeKb ?? null,
    };
  }

  return renamed;
}

/** Flag repos that vanished from the inventory. Mirrors are NEVER auto-deleted. */
function markOrphans(state: StrappyState, remote: RemoteRepo[]): string[] {
  const live = new Set(remote.map((r) => r.githubId));
  const orphaned: string[] = [];
  for (const rec of Object.values(state.repos)) {
    if (!live.has(rec.githubId)) {
      if (!rec.orphaned) rec.orphaned = true;
      orphaned.push(rec.fullName);
    }
  }
  return orphaned;
}

function selectTargets(remote: RemoteRepo[], only?: string[]): RemoteRepo[] {
  if (!only || only.length === 0) return remote;
  const wanted = new Set(only);
  return remote.filter((r) => wanted.has(r.fullName) || wanted.has(r.fullName.split("/")[1]));
}

async function syncOne(
  repo: RemoteRepo,
  token: string,
  paths: Paths,
  logger: Logger,
): Promise<RepoResult> {
  const dir = mirrorPath(paths.home, repo.fullName);
  try {
    let action: SyncAction;
    if (await mirrorExists(dir)) {
      await updateMirror(dir, repo.cloneUrl, token);
      action = "updated";
    } else {
      await cloneMirror(dir, repo.cloneUrl, token);
      action = "cloned";
    }
    const sizeKb = await dirSizeKb(dir);
    logger.info(`${action === "cloned" ? "Cloned" : "Updated"} ${repo.fullName}`);
    return { fullName: repo.fullName, action, sizeKb, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Failed ${repo.fullName}: ${message}`);
    return { fullName: repo.fullName, action: "failed", sizeKb: null, error: message };
  }
}

function applyResult(record: RepoRecord | undefined, result: RepoResult): void {
  if (!record) return;
  record.lastSync = new Date().toISOString();
  record.lastSyncOk = result.action !== "failed";
  record.lastError = result.error;
  if (result.sizeKb !== null) record.sizeKb = result.sizeKb;
}
