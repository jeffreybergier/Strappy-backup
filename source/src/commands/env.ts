import path from "node:path";
import { execa } from "execa";
import {
  listEnvironmentProfiles,
  listEnvironmentRepositories,
  restoreEnvironment,
  saveEnvironment,
} from "../environments.js";
import {
  assertEnvironmentCheckoutReady,
  discoverEnvironmentFilePaths,
  environmentCheckoutRoot,
} from "../environment-discovery.js";
import { openStore } from "../db.js";
import { getPaths, splitFullName } from "../paths.js";
import { resolveRepo } from "../checkouts.js";
import type { CheckoutRecord, RepoRecord } from "../state.js";

export interface EnvSaveOptions {
  from?: string;
  profile?: string;
  path?: string[];
}

export interface EnvRestoreOptions {
  to?: string;
  profile?: string;
  path?: string[];
  overwrite?: boolean;
}

export interface EnvListOptions {
  json?: boolean;
  profiles?: boolean;
}

export interface EnvUpdateOptions {
  from?: string;
  profile?: string;
  path?: string[];
}

export async function envSaveCommand(
  repoArg: string,
  pathArgs: string[],
  opts: EnvSaveOptions,
): Promise<void> {
  const paths = getPaths();
  const store = openStore(paths);
  const state = await store.read();
  const repo = resolveEnvironmentRepo(Object.values(state.repos), repoArg);
  const inputCheckoutPath = path.resolve(opts.from?.trim() || process.cwd());
  let checkoutPath = inputCheckoutPath;
  let filePaths = [...pathArgs, ...(opts.path ?? [])];
  const profile = opts.profile?.trim() || "default";

  if (filePaths.length === 0) {
    checkoutPath = await assertEnvironmentCheckoutReady(inputCheckoutPath);
    filePaths = await discoverEnvironmentFilePaths(checkoutPath);
  } else {
    checkoutPath = await nullableEnvironmentCheckoutRoot(inputCheckoutPath) ?? inputCheckoutPath;
  }

  const result = await saveEnvironment({
    paths,
    repo,
    profile,
    checkoutPath,
    filePaths,
  });

  console.log(`Saved ${result.saved.length} file(s) for ${result.manifest.repo} profile "${result.manifest.profile}".`);
  console.log(`Path ${path.join(paths.environments, ...result.manifest.repo.split("/"))}`);
  for (const entry of result.saved) console.log(`- ${entry.path}`);
}

export async function envRestoreCommand(
  repoArg: string,
  opts: EnvRestoreOptions,
): Promise<void> {
  const paths = getPaths();
  const store = openStore(paths);
  const state = await store.read();
  const repo = resolveEnvironmentRepo(Object.values(state.repos), repoArg);
  const checkoutPath = path.resolve(opts.to?.trim() || process.cwd());
  const profile = opts.profile?.trim() || "default";

  const result = await restoreEnvironment({
    paths,
    repo,
    profile,
    checkoutPath,
    filePaths: opts.path,
    overwrite: opts.overwrite,
  });

  console.log(`Restored ${result.restored.length} file(s) for ${result.manifest.repo} profile "${result.manifest.profile}".`);
  if (result.unchanged.length) console.log(`${result.unchanged.length} file(s) already matched.`);
  for (const entry of result.restored) console.log(`- ${entry.path}`);
  for (const refused of result.refused) console.log(`Refused ${refused.path}: ${refused.reason}`);
  if (result.refused.length) process.exitCode = 1;
}

export async function envListCommand(
  repoArg: string | undefined,
  opts: EnvListOptions,
): Promise<void> {
  const paths = getPaths();
  let repo: string | undefined;
  if (repoArg) {
    const store = openStore(paths);
    const state = await store.read();
    repo = resolveEnvironmentRepo(Object.values(state.repos), repoArg);
  }

  if (!opts.profiles) {
    const summaries = await listEnvironmentRepositories(paths, repo);
    if (opts.json) {
      console.log(JSON.stringify(summaries, null, 2));
      return;
    }

    if (summaries.length === 0) {
      console.log(repo ? `No saved environments for ${repo}.` : "No saved environments.");
      return;
    }

    const repoWidth = Math.min(48, Math.max(...summaries.map((summary) => summary.repo.length)));
    for (const summary of summaries) {
      console.log(`${summary.repo.padEnd(repoWidth)}  ${String(summary.fileCount).padStart(3)} secret(s)`);
    }
    console.log(`\n${summaries.length} repo(s).`);
    return;
  }

  const profiles = await listEnvironmentProfiles(paths, repo);
  if (opts.json) {
    console.log(JSON.stringify(profiles, null, 2));
    return;
  }

  if (profiles.length === 0) {
    console.log(repo ? `No saved environments for ${repo}.` : "No saved environments.");
    return;
  }

  const repoWidth = Math.min(48, Math.max(...profiles.map((profile) => profile.repo.length)));
  for (const profile of profiles) {
    console.log(
      `${profile.repo.padEnd(repoWidth)}  ${profile.profile.padEnd(16)}  ` +
        `${String(profile.fileCount).padStart(3)} file(s)  ${profile.savedAt ?? "unknown"}`,
    );
  }
  console.log(`\n${profiles.length} environment profile(s).`);
}

export async function envUpdateCommand(
  repoArg: string | undefined,
  opts: EnvUpdateOptions,
): Promise<void> {
  const paths = getPaths();
  const store = openStore(paths);
  const state = await store.read();
  const checkoutPath = await assertEnvironmentCheckoutReady(path.resolve(opts.from?.trim() || process.cwd()));
  const repo = repoArg
    ? resolveEnvironmentRepo(Object.values(state.repos), repoArg)
    : await resolveRepoFromCheckout(checkoutPath, state.checkouts, Object.values(state.repos));
  const profile = opts.profile?.trim() || "default";
  const filePaths = opts.path?.length
    ? opts.path.map(normalizeRepoPath)
    : await discoverEnvironmentFilePaths(checkoutPath);

  if (filePaths.length === 0) throw new Error(`No saved files to update for ${repo} profile "${profile}".`);

  const result = await saveEnvironment({
    paths,
    repo,
    profile,
    checkoutPath,
    filePaths,
  });

  console.log(`Updated ${result.saved.length} secret(s) for ${result.manifest.repo}.`);
  for (const entry of result.saved) console.log(`- ${entry.path}`);
}

function resolveEnvironmentRepo(records: RepoRecord[], repoArg: string): string {
  try {
    return resolveRepo(records, repoArg).fullName;
  } catch (err) {
    if (!repoArg.includes("/")) throw err;
    splitFullName(repoArg);
    return repoArg;
  }
}

async function resolveRepoFromCheckout(
  checkoutPath: string,
  checkouts: Record<string, CheckoutRecord>,
  records: RepoRecord[],
): Promise<string> {
  const resolved = path.resolve(checkoutPath);
  const registered = Object.values(checkouts).find((checkout) => path.resolve(checkout.path) === resolved);
  if (registered) return registered.repo;

  const configured = await nullableGitOut(resolved, ["config", "--get", "strappy.repo"]);
  if (configured) return resolveEnvironmentRepo(records, configured);

  const origin = await nullableGitOut(resolved, ["remote", "get-url", "origin"]);
  const github = parseGithubFullName(origin);
  if (github) return resolveEnvironmentRepo(records, github);

  throw new Error("Could not determine repo for checkout. Pass the repo name explicitly.");
}

async function nullableGitOut(repoPath: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["-C", repoPath, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 10_000,
    });
    const trimmed = stdout.trim();
    return trimmed || null;
  } catch {
    return null;
  }
}

async function nullableEnvironmentCheckoutRoot(checkoutPath: string): Promise<string | null> {
  try {
    return await environmentCheckoutRoot(checkoutPath);
  } catch {
    return null;
  }
}

function parseGithubFullName(url: string | null): string | null {
  if (!url) return null;
  let cleaned = url.trim();
  if (cleaned.startsWith("git@github.com:")) cleaned = cleaned.replace(/^git@github\.com:/, "https://github.com/");
  if (cleaned.startsWith("ssh://git@github.com/")) cleaned = cleaned.replace(/^ssh:\/\/git@github\.com\//, "https://github.com/");
  const m = cleaned.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/)?$/i);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/i, "")}`;
}

function normalizeRepoPath(input: string): string {
  const rel = input.trim().replaceAll("\\", "/");
  if (!rel || rel === ".") throw new Error("Environment file path cannot be empty.");
  if (path.posix.isAbsolute(rel)) throw new Error(`Environment file path must be repo-relative: ${input}`);
  const normalized = path.posix.normalize(rel);
  const parts = normalized.split("/");
  if (normalized.startsWith("../") || parts.includes("..")) {
    throw new Error(`Environment file path cannot escape the repo: ${input}`);
  }
  if (parts[0] === ".git" || parts.includes(".git")) {
    throw new Error(`Environment file path cannot target .git: ${input}`);
  }
  return normalized;
}
