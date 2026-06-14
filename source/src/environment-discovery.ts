import path from "node:path";
import { execa } from "execa";

const DISCOVERY_EXCLUDED_SEGMENTS = new Set([".git", "node_modules"]);
const DISCOVERY_EXCLUDED_PREFIXES = [".wrangler/tmp/"];
const DISCOVERY_EXCLUDED_BASENAMES = new Set([".DS_Store"]);

export async function environmentCheckoutRoot(checkoutPath: string): Promise<string> {
  try {
    const stdout = await gitOut(path.resolve(checkoutPath), ["rev-parse", "--show-toplevel"]);
    return path.resolve(stdout.trim());
  } catch (err) {
    throw new Error(`Checkout path is not a git worktree: ${checkoutPath}`, { cause: err });
  }
}

export async function assertEnvironmentCheckoutReady(checkoutPath: string): Promise<string> {
  const root = await environmentCheckoutRoot(checkoutPath);
  const status = await gitOut(root, ["status", "--porcelain=v1", "--untracked-files=no"]);
  if (status.trim().length > 0) throw new Error("Checkout has tracked uncommitted changes.");
  return root;
}

export async function discoverEnvironmentFilePaths(checkoutPath: string): Promise<string[]> {
  const root = await environmentCheckoutRoot(checkoutPath);
  const paths = new Set<string>();

  for (const rel of splitGitZ(await gitOut(root, ["ls-files", "-z", "--others", "--exclude-standard"]))) {
    addDiscoveredPath(paths, rel);
  }
  for (const rel of splitGitZ(await gitOut(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"]))) {
    addDiscoveredPath(paths, rel);
  }
  for (const rel of assumedOrSkippedTrackedPaths(await gitOut(root, ["ls-files", "-z", "-v"]))) {
    addDiscoveredPath(paths, rel);
  }

  return [...paths].sort((a, b) => a.localeCompare(b));
}

function addDiscoveredPath(paths: Set<string>, rel: string): void {
  const normalized = normalizeGitPath(rel);
  if (!normalized || isDiscoveryExcluded(normalized)) return;
  paths.add(normalized);
}

function assumedOrSkippedTrackedPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const record of splitGitZ(stdout)) {
    if (record.length < 3 || record[1] !== " ") continue;
    const flag = record[0];
    if (flag === "S" || flag === "s" || (flag >= "a" && flag <= "z")) paths.push(record.slice(2));
  }
  return paths;
}

function normalizeGitPath(input: string): string | null {
  if (!input) return null;
  const normalized = path.posix.normalize(input.replaceAll("\\", "/"));
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return normalized;
}

function isDiscoveryExcluded(rel: string): boolean {
  const parts = rel.split("/");
  if (parts.some((part) => DISCOVERY_EXCLUDED_SEGMENTS.has(part))) return true;
  if (DISCOVERY_EXCLUDED_BASENAMES.has(parts[parts.length - 1])) return true;
  return DISCOVERY_EXCLUDED_PREFIXES.some((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix));
}

function splitGitZ(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

async function gitOut(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execa("git", ["-C", repoPath, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout: 10_000,
  });
  return stdout;
}
