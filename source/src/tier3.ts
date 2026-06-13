import pLimit from "p-limit";
import type { StrappyConfig } from "./config.js";
import { fetchTier3Metadata, makeOctokit } from "./github.js";
import type { Logger } from "./logger.js";
import type { RepoRecord, Store } from "./state.js";

export interface Tier3Result {
  fullName: string;
  ok: boolean;
  error: string | null;
}

export interface Tier3Summary {
  /** Archived repos are deliberately skipped to avoid spending calls on old repos. */
  skippedArchived: number;
  /** Orphaned repos are gone from GitHub, so their last fetched tier is retained. */
  skippedOrphaned: number;
  results: Tier3Result[];
  ok: number;
  failed: number;
}

export interface Tier3Options {
  store: Store;
  config: StrappyConfig;
  token: string;
  logger: Logger;
  /** If set, only refresh these repos (by full name or bare name). */
  only?: string[];
}

/** Fetch Tier-3 file bodies for known repos that are still active on GitHub. */
export async function refreshTier3(opts: Tier3Options): Promise<Tier3Summary> {
  const { store, config, token, logger, only } = opts;
  const octokit = makeOctokit(token);

  return store.transaction(async (state, checkpoint) => {
    const selected = selectTargets(Object.values(state.repos), only);
    const skippedOrphaned = selected.filter((r) => r.orphaned).length;
    const skippedArchived = selected.filter((r) => !r.orphaned && r.archived).length;
    const targets = selected.filter((r) => !r.archived && !r.orphaned);

    logger.info(
      `Refreshing Tier-3 files for ${targets.length} active repo(s)` +
        (skippedArchived > 0 || skippedOrphaned > 0
          ? ` (${skippedArchived} archived, ${skippedOrphaned} orphaned skipped)`
          : "") +
        "…",
    );

    const limit = pLimit(Math.max(1, config.concurrency));
    const results: Tier3Result[] = [];

    await Promise.all(
      targets.map((record) =>
        limit(async () => {
          try {
            record.tier3 = await fetchTier3Metadata(octokit, record.fullName, logger);
            logger.info(`Refreshed Tier-3 files for ${record.fullName}`);
            results.push({ fullName: record.fullName, ok: true, error: null });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`Failed to refresh Tier-3 files for ${record.fullName}: ${message}`);
            results.push({ fullName: record.fullName, ok: false, error: message });
          }
          await checkpoint();
        }),
      ),
    );

    const ok = results.filter((r) => r.ok).length;
    return { skippedArchived, skippedOrphaned, results, ok, failed: results.length - ok };
  });
}

function selectTargets(records: RepoRecord[], only?: string[]): RepoRecord[] {
  if (!only || only.length === 0) return records;
  const wanted = new Set(only);
  return records.filter(
    (r) => wanted.has(r.fullName) || wanted.has(r.fullName.split("/")[1]),
  );
}
