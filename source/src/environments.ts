import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";
import { splitFullName, type Paths } from "./paths.js";

export interface EnvironmentManifest {
  version: 1;
  repo: string;
  profile: string;
  savedAt: string;
  files: EnvironmentFileEntry[];
}

export interface EnvironmentFileEntry {
  path: string;
  mode: string;
  size: number;
  sha256: string;
  savedAt: string;
  sourceCheckout: string | null;
}

export interface SaveEnvironmentOptions {
  paths: Paths;
  repo: string;
  profile: string;
  checkoutPath: string;
  filePaths: string[];
}

export interface SaveEnvironmentResult {
  manifest: EnvironmentManifest;
  saved: EnvironmentFileEntry[];
}

export interface RestoreEnvironmentOptions {
  paths: Paths;
  repo: string;
  profile: string;
  checkoutPath: string;
  filePaths?: string[];
  overwrite?: boolean;
}

export interface RestoreEnvironmentResult {
  manifest: EnvironmentManifest;
  restored: EnvironmentFileEntry[];
  unchanged: EnvironmentFileEntry[];
  refused: { path: string; reason: string }[];
}

export interface EnvironmentProfileSummary {
  repo: string;
  profile: string;
  path: string;
  savedAt: string | null;
  fileCount: number;
}

export interface EnvironmentRepoSummary {
  repo: string;
  path: string;
  updatedAt: string | null;
  fileCount: number;
}

interface StoredEnvironmentManifest {
  version: 2;
  repo: string;
  updatedAt: string;
  profiles: Record<string, StoredEnvironmentProfile>;
}

interface StoredEnvironmentProfile {
  savedAt: string;
  files: EnvironmentFileEntry[];
}

const DEFAULT_ENVIRONMENT_PROFILE = "default";

export async function saveEnvironment(opts: SaveEnvironmentOptions): Promise<SaveEnvironmentResult> {
  const repo = validateRepo(opts.repo);
  const profile = validateProfile(opts.profile);
  const checkoutRoot = path.resolve(opts.checkoutPath);
  const relPaths = await expandSourceFilePaths(checkoutRoot, uniqueNormalizedPaths(opts.filePaths));
  if (relPaths.length === 0) throw new Error("Choose at least one environment file path to save.");

  const existing = await readEnvironmentManifest(opts.paths, repo, profile, { allowMissing: true });
  const entriesByPath = new Map((existing?.files ?? []).map((entry) => [entry.path, entry]));
  const savedAt = new Date().toISOString();
  const saved: EnvironmentFileEntry[] = [];
  const repoDir = environmentRepoPath(opts.paths, repo);

  for (const rel of relPaths) {
    const source = safeJoin(checkoutRoot, rel);
    const sourceStat = await checkedSourceFile(source, rel);
    const mode = restoreModeFromSource(sourceStat.mode);
    const sha256 = await hashFile(source);
    const dest = safeJoin(repoDir, rel);

    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(source, dest);
    await fs.chmod(dest, mode);

    const entry: EnvironmentFileEntry = {
      path: rel,
      mode: formatMode(mode),
      size: sourceStat.size,
      sha256,
      savedAt,
      sourceCheckout: checkoutRoot,
    };
    entriesByPath.set(rel, entry);
    saved.push(entry);
  }

  const manifest: EnvironmentManifest = {
    version: 1,
    repo,
    profile,
    savedAt,
    files: [...entriesByPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
  return { manifest, saved };
}

export async function restoreEnvironment(opts: RestoreEnvironmentOptions): Promise<RestoreEnvironmentResult> {
  const repo = validateRepo(opts.repo);
  const profile = validateProfile(opts.profile);
  const checkoutRoot = path.resolve(opts.checkoutPath);
  const manifest = await readEnvironmentManifest(opts.paths, repo, profile);
  const wanted = opts.filePaths?.length ? new Set(uniqueNormalizedPaths(opts.filePaths)) : null;
  const entries = wanted ? manifest.files.filter((entry) => wanted.has(entry.path)) : manifest.files;
  const missing = wanted ? [...wanted].filter((rel) => !manifest.files.some((entry) => entry.path === rel)) : [];
  const toRestore: { entry: EnvironmentFileEntry; source: string; target: string }[] = [];
  const unchanged: EnvironmentFileEntry[] = [];
  const refused: { path: string; reason: string }[] = missing.map((rel) => ({
    path: rel,
    reason: "not present in saved environment",
  }));

  for (const entry of entries) {
    const rel = validateRelativePath(entry.path);
    const source = safeJoin(environmentRepoPath(opts.paths, repo), rel);
    const target = safeJoin(checkoutRoot, rel);
    const sourceStat = await checkedStoredFile(source, rel);
    if (sourceStat.size !== entry.size || (await hashFile(source)) !== entry.sha256) {
      refused.push({ path: rel, reason: "stored file changed during restore" });
      continue;
    }
    const current = await existingTarget(target);

    if (current?.isSymbolicLink()) {
      refused.push({ path: rel, reason: "target is a symlink" });
      continue;
    }
    if (current && !current.isFile()) {
      refused.push({ path: rel, reason: "target exists and is not a file" });
      continue;
    }
    if (current && !opts.overwrite) {
      const currentHash = await hashFile(target);
      if (currentHash === entry.sha256) {
        unchanged.push(entry);
        continue;
      }
      refused.push({ path: rel, reason: "target exists and differs; pass --overwrite to replace it" });
      continue;
    }

    toRestore.push({ entry, source, target });
  }

  if (refused.length) return { manifest, restored: [], unchanged, refused };

  const restored: EnvironmentFileEntry[] = [];
  for (const item of toRestore) {
    await fs.mkdir(path.dirname(item.target), { recursive: true });
    await fs.copyFile(item.source, item.target);
    await fs.chmod(item.target, parseMode(item.entry.mode));
    restored.push(item.entry);
  }

  return { manifest, restored, unchanged, refused };
}

export async function listEnvironmentProfiles(
  paths: Paths,
  repo?: string,
): Promise<EnvironmentProfileSummary[]> {
  const manifests = repo
    ? [await readStoredManifest(paths, validateRepo(repo), { allowMissing: true })]
    : await listStoredManifests(paths);
  const summaries: EnvironmentProfileSummary[] = [];

  for (const stored of manifests) {
    if (!stored) continue;
    for (const [profile, profileManifest] of Object.entries(stored.profiles)) {
      summaries.push({
        repo: stored.repo,
        profile,
        path: environmentRepoPath(paths, stored.repo),
        savedAt: profileManifest.savedAt,
        fileCount: profileManifest.files.length,
      });
    }
  }

  return summaries.sort((a, b) => a.repo.localeCompare(b.repo) || a.profile.localeCompare(b.profile));
}

export async function listEnvironmentRepositories(
  paths: Paths,
  repo?: string,
): Promise<EnvironmentRepoSummary[]> {
  const manifests = repo
    ? [await readStoredManifest(paths, validateRepo(repo), { allowMissing: true })]
    : await listStoredManifests(paths);
  const summaries: EnvironmentRepoSummary[] = [];

  for (const stored of manifests) {
    if (!stored) continue;
    const filePaths = new Set<string>();
    for (const profile of Object.values(stored.profiles)) {
      for (const entry of profile.files) filePaths.add(entry.path);
    }
    summaries.push({
      repo: stored.repo,
      path: environmentRepoPath(paths, stored.repo),
      updatedAt: stored.updatedAt || null,
      fileCount: filePaths.size,
    });
  }

  return summaries.sort((a, b) => a.repo.localeCompare(b.repo));
}

export async function readEnvironmentManifest(
  paths: Paths,
  repo: string,
  profile: string,
  opts?: { allowMissing?: false },
): Promise<EnvironmentManifest>;
export async function readEnvironmentManifest(
  paths: Paths,
  repo: string,
  profile: string,
  opts: { allowMissing: true },
): Promise<EnvironmentManifest | null>;
export async function readEnvironmentManifest(
  paths: Paths,
  repo: string,
  profile: string,
  opts: { allowMissing?: boolean } = {},
): Promise<EnvironmentManifest | null> {
  const normalizedProfile = validateProfile(profile);
  const stored = await readStoredManifest(paths, repo, { allowMissing: opts.allowMissing ?? false });
  if (!stored) return null;
  const profileManifest = stored.profiles[normalizedProfile] ?? stored.profiles[DEFAULT_ENVIRONMENT_PROFILE];
  if (!profileManifest && opts.allowMissing) return null;
  if (!profileManifest) throw new Error(`No saved environment for ${repo} profile "${profile}".`);
  return {
    version: 1,
    repo: stored.repo,
    profile: normalizedProfile,
    savedAt: profileManifest.savedAt,
    files: profileManifest.files,
  };
}

async function listStoredManifests(paths: Paths): Promise<StoredEnvironmentManifest[]> {
  const root = paths.environments;
  const manifests: StoredEnvironmentManifest[] = [];
  let owners;
  try {
    owners = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  for (const owner of owners.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!owner.isDirectory() || owner.name.startsWith(".")) continue;
    const ownerRoot = path.join(root, owner.name);
    const entries = await fs.readdir(ownerRoot, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const stored = await readStoredManifest(paths, `${owner.name}/${entry.name}`, { allowMissing: true });
      if (stored) manifests.push(stored);
    }
  }

  return manifests.sort((a, b) => a.repo.localeCompare(b.repo));
}

async function readStoredManifest(
  paths: Paths,
  repo: string,
  opts: { allowMissing?: boolean } = {},
): Promise<StoredEnvironmentManifest | null> {
  const normalizedRepo = validateRepo(repo);
  const files = await scanStoredEnvironmentFiles(environmentRepoPath(paths, normalizedRepo));
  if (!files || files.length === 0) {
    if (opts.allowMissing) return null;
    throw new Error(`No saved environments for ${normalizedRepo}.`);
  }
  const updatedAt = latestEntrySavedAt(files);
  return {
    version: 2,
    repo: normalizedRepo,
    updatedAt,
    profiles: {
      [DEFAULT_ENVIRONMENT_PROFILE]: {
        savedAt: updatedAt,
        files,
      },
    },
  };
}

function environmentRepoPath(paths: Paths, repo: string): string {
  const [owner, name] = splitFullName(validateRepo(repo));
  return path.join(paths.environments, owner, name);
}

async function scanStoredEnvironmentFiles(repoDir: string): Promise<EnvironmentFileEntry[] | null> {
  let rootStat: Stats;
  try {
    rootStat = await fs.lstat(repoDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (rootStat.isSymbolicLink()) throw new Error(`Stored environment path is a symlink: ${repoDir}`);
  if (!rootStat.isDirectory()) throw new Error(`Stored environment path is not a directory: ${repoDir}`);
  return (await scanStoredEnvironmentFilesIn(repoDir, repoDir)).sort((a, b) => a.path.localeCompare(b.path));
}

async function scanStoredEnvironmentFilesIn(root: string, current: string): Promise<EnvironmentFileEntry[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: EnvironmentFileEntry[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    const rel = path.relative(root, absolute).split(path.sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`Stored environment path is a symlink: ${rel}`);
    if (entry.isDirectory()) {
      if (entry.name === ".git") throw new Error(`Stored environment path cannot target .git: ${rel}`);
      files.push(...(await scanStoredEnvironmentFilesIn(root, absolute)));
      continue;
    }
    if (!entry.isFile()) throw new Error(`Stored environment path is not a file: ${rel}`);
    files.push(await storedEnvironmentEntry(absolute, rel));
  }

  return files;
}

async function storedEnvironmentEntry(source: string, rel: string): Promise<EnvironmentFileEntry> {
  const sourceStat = await checkedStoredFile(source, rel);
  return {
    path: validateRelativePath(rel),
    mode: formatMode(restoreModeFromSource(sourceStat.mode)),
    size: sourceStat.size,
    sha256: await hashFile(source),
    savedAt: sourceStat.mtime.toISOString(),
    sourceCheckout: null,
  };
}

function latestEntrySavedAt(files: EnvironmentFileEntry[]): string {
  return files.reduce((latest, entry) => entry.savedAt > latest ? entry.savedAt : latest, "");
}

async function checkedSourceFile(source: string, rel: string): Promise<{ mode: number; size: number }> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Refusing to save symlink environment file: ${rel}`);
  if (!stat.isFile()) throw new Error(`Environment path is not a file: ${rel}`);
  return { mode: stat.mode, size: stat.size };
}

async function expandSourceFilePaths(checkoutRoot: string, relPaths: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const rel of relPaths) {
    const source = safeJoin(checkoutRoot, rel);
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink()) throw new Error(`Refusing to save symlink environment file: ${rel}`);
    if (stat.isFile()) {
      files.add(rel);
      continue;
    }
    if (!stat.isDirectory()) throw new Error(`Environment path is not a file or directory: ${rel}`);
    for (const file of await scanSourceDirectory(checkoutRoot, source)) files.add(file);
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

async function scanSourceDirectory(checkoutRoot: string, current: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(current, entry.name);
    const rel = path.relative(checkoutRoot, absolute).split(path.sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`Refusing to save symlink environment file: ${rel}`);
    if (entry.isDirectory()) {
      if (entry.name === ".git") throw new Error(`Environment path cannot target .git: ${rel}`);
      files.push(...(await scanSourceDirectory(checkoutRoot, absolute)));
      continue;
    }
    if (!entry.isFile()) throw new Error(`Environment path is not a file: ${rel}`);
    files.push(validateRelativePath(rel));
  }
  return files;
}

async function checkedStoredFile(source: string, rel: string): Promise<{ mode: number; size: number; mtime: Date }> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Stored environment file is a symlink: ${rel}`);
  if (!stat.isFile()) throw new Error(`Stored environment path is not a file: ${rel}`);
  return { mode: stat.mode, size: stat.size, mtime: stat.mtime };
}

async function existingTarget(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function uniqueNormalizedPaths(paths: string[]): string[] {
  return [...new Set(paths.map(validateRelativePath))].sort();
}

function validateRepo(repo: string): string {
  const trimmed = repo.trim();
  splitFullName(trimmed);
  return trimmed;
}

function validateProfile(profile: string): string {
  const trimmed = profile.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new Error(`Invalid environment profile "${profile}" (use letters, numbers, dot, underscore, or dash).`);
  }
  return trimmed;
}

function validateRelativePath(input: string): string {
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

function safeJoin(root: string, rel: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, validateRelativePath(rel));
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`Path escapes root: ${rel}`);
  }
  return target;
}

function restoreModeFromSource(mode: number): number {
  return mode & 0o111 ? 0o700 : 0o600;
}

function formatMode(mode: number): string {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

function parseMode(mode: string): number {
  if (!/^[0-7]{3,4}$/.test(mode)) throw new Error(`Invalid environment file mode "${mode}".`);
  return Number.parseInt(mode, 8) & 0o777;
}

async function hashFile(file: string): Promise<string> {
  const buf = await fs.readFile(file);
  return createHash("sha256").update(buf).digest("hex");
}
