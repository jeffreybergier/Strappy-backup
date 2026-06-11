import os from "node:os";
import path from "node:path";

/** Absolute locations of everything strappy owns, derived from STRAPPY_HOME. */
export interface Paths {
  home: string;
  config: string;
  state: string;
  secrets: string;
  tokenFile: string;
  mirrors: string;
  checkouts: string;
  logs: string;
  logFile: string;
}

/**
 * STRAPPY_HOME is an env var (not hardcoded) because in the compose container
 * the host's ~/.strappy is mounted at /root, so STRAPPY_HOME=/root makes the
 * in-container process see the same store. Defaults to ~/.strappy otherwise.
 */
export function resolveHome(): string {
  const env = process.env.STRAPPY_HOME?.trim();
  if (env) return path.resolve(env);
  return path.join(os.homedir(), ".strappy");
}

export function getPaths(home: string = resolveHome()): Paths {
  return {
    home,
    config: path.join(home, "config.json"),
    state: path.join(home, "state.json"),
    secrets: path.join(home, "secrets"),
    tokenFile: path.join(home, "secrets", "github-token"),
    mirrors: path.join(home, "mirrors"),
    checkouts: path.join(home, "checkouts"),
    logs: path.join(home, "logs"),
    logFile: path.join(home, "logs", "strappy.log"),
  };
}

/** Mirror directory for "owner/repo" => <home>/mirrors/owner/repo.git */
export function mirrorPath(home: string, fullName: string): string {
  const [owner, repo] = splitFullName(fullName);
  return path.join(home, "mirrors", owner, `${repo}.git`);
}

export function splitFullName(fullName: string): [string, string] {
  const idx = fullName.indexOf("/");
  if (idx < 0) throw new Error(`Invalid repo name (expected "owner/repo"): ${fullName}`);
  return [fullName.slice(0, idx), fullName.slice(idx + 1)];
}
