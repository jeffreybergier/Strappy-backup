import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execa } from "execa";
import type { StrappyConfig } from "./config.js";
import { mirrorExists } from "./git.js";
import { mirrorPath, splitFullName, type Paths } from "./paths.js";
import type { CheckoutRecord, RepoRecord, Store, StrappyState } from "./state.js";

export interface CreateCheckoutOptions {
  store: Store;
  paths: Paths;
  config: StrappyConfig;
  repoArg: string;
  branch?: string;
  name?: string;
  targetPath?: string;
}

export interface CreateCheckoutResult {
  name: string;
  record: CheckoutRecord;
}

export interface CleanupResult {
  removed: string[];
  refused: { name: string; reason: string }[];
  missing: string[];
}

/**
 * Resolve the disposable checkout root. In this workspace, /repo/checkouts is
 * the intended shared location; elsewhere, fall back to STRAPPY_HOME/checkouts.
 */
export function resolveCheckoutRoot(paths: Paths, config: StrappyConfig): string {
  const env = process.env.STRAPPY_CHECKOUT_ROOT?.trim();
  if (env) return path.resolve(env);

  const configured = config.checkoutRoot?.trim();
  if (configured) return path.resolve(configured);

  if (fsSync.existsSync("/repo")) return "/repo/checkouts";
  return paths.checkouts;
}

export async function createCheckout(opts: CreateCheckoutOptions): Promise<CreateCheckoutResult> {
  const state = await opts.store.read();
  const repo = resolveRepo(Object.values(state.repos), opts.repoArg);
  if (repo.orphaned) throw new Error(`${repo.fullName} is orphaned; keeping mirror backup only.`);

  const mirror = mirrorPath(opts.paths.home, repo.fullName);
  if (!(await mirrorExists(mirror))) {
    throw new Error(`Mirror for ${repo.fullName} does not exist. Run \`strappy sync ${repo.fullName}\` first.`);
  }

  const checkoutRoot = resolveCheckoutRoot(opts.paths, opts.config);
  const name = opts.name?.trim() || defaultCheckoutName(Object.values(state.repos), repo);
  validateCheckoutName(name);

  const target = path.resolve(opts.targetPath?.trim() || path.join(checkoutRoot, name));
  if (state.checkouts[name]) throw new Error(`Checkout name "${name}" is already registered.`);
  await assertTargetAvailable(target);

  const requestedBranch = opts.branch?.trim();
  const baseBranch = requestedBranch || repo.defaultBranch;
  const checkoutBranch = requestedBranch || defaultCheckoutBranchName();
  const remoteUrl = githubRemoteUrl(repo);

  await fs.mkdir(path.dirname(target), { recursive: true });
  await execa("git", ["clone", "--branch", baseBranch, mirror, target]);
  await git(target, ["remote", "set-url", "origin", remoteUrl]);
  await git(target, ["config", "strappy.repo", repo.fullName]);
  await git(target, ["config", "strappy.checkoutName", name]);
  if (!requestedBranch) await git(target, ["switch", "-c", checkoutBranch]);
  await setUpstreamIfPossible(target, checkoutBranch);

  let record: CheckoutRecord = {
    repo: repo.fullName,
    path: target,
    createdAt: new Date().toISOString(),
    branch: checkoutBranch,
    mode: "github",
    remoteUrl,
    lastScan: null,
    exists: null,
    dirty: null,
    ahead: null,
    behind: null,
    currentBranch: null,
    headSha: null,
    upstream: null,
    scanError: null,
  };
  record = await scanCheckout(record);

  await opts.store.transaction(async (locked) => {
    if (locked.checkouts[name]) throw new Error(`Checkout name "${name}" is already registered.`);
    locked.checkouts[name] = record;
  });

  return { name, record };
}

export async function scanCheckout(record: CheckoutRecord): Promise<CheckoutRecord> {
  const next: CheckoutRecord = {
    ...record,
    lastScan: new Date().toISOString(),
    scanError: null,
  };

  if (!(await pathExists(record.path))) {
    return {
      ...next,
      exists: false,
      dirty: false,
      ahead: null,
      behind: null,
      currentBranch: null,
      headSha: null,
      upstream: null,
    };
  }

  next.exists = true;

  try {
    const inside = await gitOut(record.path, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.trim() !== "true") throw new Error("not a git worktree");
  } catch {
    return { ...next, dirty: null, ahead: null, behind: null, scanError: "not a git worktree" };
  }

  const errors: string[] = [];
  try {
    await git(record.path, ["fetch", "--quiet", "--prune", "origin"], 20_000);
  } catch (err) {
    errors.push(`fetch failed: ${errorMessage(err)}`);
  }

  try {
    const status = await gitOut(record.path, ["status", "--porcelain=v1"]);
    next.dirty = status.trim().length > 0;
  } catch (err) {
    next.dirty = null;
    errors.push(`status failed: ${errorMessage(err)}`);
  }

  next.currentBranch = await nullableGitOut(record.path, ["branch", "--show-current"]);
  if (!next.currentBranch) next.currentBranch = await nullableGitOut(record.path, ["rev-parse", "--short", "HEAD"]);
  next.headSha = await nullableGitOut(record.path, ["rev-parse", "--verify", "HEAD"]);
  next.upstream = await nullableGitOut(record.path, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}",
  ]);

  next.ahead = await nullableGitCount(record.path, ["rev-list", "--count", "--branches", "--not", "--remotes"]);
  next.behind = next.upstream
    ? await nullableGitCount(record.path, ["rev-list", "--count", next.upstream, "--not", "HEAD"])
    : null;
  next.scanError = errors.length ? errors.join("; ") : null;
  return next;
}

export async function scanCheckouts(
  store: Store,
  names?: string[],
): Promise<Record<string, CheckoutRecord>> {
  const scanned: Record<string, CheckoutRecord> = {};
  await store.transaction(async (state, checkpoint) => {
    const wanted = names?.length ? new Set(names) : null;
    for (const [name, record] of Object.entries(state.checkouts)) {
      if (wanted && !wanted.has(name)) continue;
      const next = await scanCheckout(record);
      state.checkouts[name] = next;
      scanned[name] = next;
      await checkpoint();
    }
  });
  return scanned;
}

export async function cleanupCheckouts(
  store: Store,
  selector: { name?: string; all?: boolean; force?: boolean },
): Promise<CleanupResult> {
  const removed: string[] = [];
  const refused: { name: string; reason: string }[] = [];
  const missing: string[] = [];

  await store.transaction(async (state, checkpoint) => {
    const names = selectCheckoutNames(state, selector);
    for (const name of names) {
      const current = state.checkouts[name];
      if (!current) continue;
      const scanned = await scanCheckout(current);
      state.checkouts[name] = scanned;
      await checkpoint();

      if (scanned.exists === false) {
        delete state.checkouts[name];
        missing.push(name);
        await checkpoint();
        continue;
      }

      const unsafe = unsafeReason(scanned);
      if (unsafe && !selector.force) {
        refused.push({ name, reason: unsafe });
        continue;
      }

      await fs.rm(scanned.path, { recursive: true, force: true });
      delete state.checkouts[name];
      removed.push(name);
      await checkpoint();
    }
  });

  return { removed, refused, missing };
}

export function checkoutStatus(record: CheckoutRecord): string {
  if (record.exists === false) return "missing";
  const flags = [
    record.dirty ? "dirty" : null,
    record.ahead && record.ahead > 0 ? `${record.ahead} unpushed` : null,
    record.behind && record.behind > 0 ? `${record.behind} behind` : null,
    record.scanError ? "scan warning" : null,
  ].filter(Boolean);
  return flags.length ? flags.join(", ") : "clean";
}

export function checkoutBranch(record: CheckoutRecord): string {
  return record.currentBranch ?? record.branch;
}

export function isCheckoutSafe(record: CheckoutRecord): boolean {
  return unsafeReason(record) === null;
}

export function unsafeReason(record: CheckoutRecord): string | null {
  if (record.exists === false) return null;
  if (record.scanError && (record.dirty === null || record.ahead === null)) return record.scanError;
  if (record.dirty) return "working tree has uncommitted changes";
  if (record.ahead !== null && record.ahead > 0) return `${record.ahead} commit(s) are not on a remote`;
  return null;
}

export function resolveCheckoutName(state: StrappyState, arg: string): string {
  if (state.checkouts[arg]) return arg;
  const matches = Object.entries(state.checkouts).filter(
    ([, c]) => c.repo === arg || c.repo.split("/")[1] === arg,
  );
  if (matches.length === 1) return matches[0][0];
  if (matches.length > 1) throw new Error(`Ambiguous checkout "${arg}"; use one of: ${matches.map(([n]) => n).join(", ")}`);
  throw new Error(`Unknown checkout "${arg}". Run \`strappy checkouts\`.`);
}

export function resolveRepo(records: RepoRecord[], arg: string): RepoRecord {
  const exact = records.find((r) => r.fullName === arg);
  if (exact) return exact;
  const matches = records.filter((r) => r.fullName.split("/")[1] === arg);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Ambiguous repo "${arg}"; use one of: ${matches.map((r) => r.fullName).join(", ")}`);
  throw new Error(`Unknown repo "${arg}". Run \`strappy list\` to see the inventory.`);
}

function defaultCheckoutName(records: RepoRecord[], repo: RepoRecord): string {
  const [owner, name] = splitFullName(repo.fullName);
  const duplicateNames = records.filter((r) => r.fullName.split("/")[1] === name).length > 1;
  return duplicateNames ? `${owner}--${name}` : name;
}

function defaultCheckoutBranchName(date = new Date()): string {
  return `vibing/${formatLocalDate(date)}`;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function validateCheckoutName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`Invalid checkout name "${name}" (use letters, numbers, dot, underscore, or dash).`);
  }
}

async function assertTargetAvailable(target: string): Promise<void> {
  try {
    const entries = await fs.readdir(target);
    if (entries.length > 0) throw new Error(`Target directory is not empty: ${target}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

function githubRemoteUrl(repo: RepoRecord): string {
  const raw = repo.raw;
  if (typeof raw === "object" && raw !== null) {
    const cloneUrl = (raw as { clone_url?: unknown }).clone_url;
    if (typeof cloneUrl === "string" && cloneUrl) return cloneUrl;
  }
  return `https://github.com/${repo.fullName}.git`;
}

async function setUpstreamIfPossible(repoPath: string, branch: string): Promise<void> {
  try {
    await git(repoPath, ["branch", "--set-upstream-to", `origin/${branch}`, branch]);
  } catch {
    // New or unusual repos may not have the branch in remote-tracking refs.
  }
}

function selectCheckoutNames(
  state: StrappyState,
  selector: { name?: string; all?: boolean },
): string[] {
  if (selector.all) return Object.keys(state.checkouts);
  if (!selector.name) throw new Error("Choose a checkout name or pass --all.");
  return [resolveCheckoutName(state, selector.name)];
}

async function nullableGitOut(repoPath: string, args: string[]): Promise<string | null> {
  try {
    const stdout = await gitOut(repoPath, args);
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

async function nullableGitCount(repoPath: string, args: string[]): Promise<number | null> {
  const stdout = await nullableGitOut(repoPath, args);
  if (stdout === null) return null;
  const count = Number.parseInt(stdout, 10);
  return Number.isFinite(count) ? count : null;
}

async function gitOut(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await git(repoPath, args);
  return stdout;
}

async function git(repoPath: string, args: string[], timeout = 10_000): Promise<{ stdout: string }> {
  return execa("git", ["-C", repoPath, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout,
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message.split("\n", 1)[0] : String(err);
}
