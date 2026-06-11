import fs from "node:fs/promises";
import { execa } from "execa";
import type { Paths } from "./paths.js";

export type TokenSource = "env:STRAPPY_GITHUB_TOKEN" | "env:GITHUB_TOKEN" | "file" | "gh-cli";

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

/**
 * Resolve a GitHub token, in priority order:
 *   1. STRAPPY_GITHUB_TOKEN env (from .env or the shell)
 *   2. GITHUB_TOKEN env (common fallback)
 *   3. STRAPPY_HOME/secrets/github-token (written by `strappy auth`)
 *   4. `gh auth token` if the GitHub CLI is installed
 */
export async function resolveToken(paths: Paths): Promise<ResolvedToken | null> {
  const fromEnv = process.env.STRAPPY_GITHUB_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "env:STRAPPY_GITHUB_TOKEN" };

  const fromGithubEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromGithubEnv) return { token: fromGithubEnv, source: "env:GITHUB_TOKEN" };

  const fromFile = await readTokenFile(paths);
  if (fromFile) return { token: fromFile, source: "file" };

  const fromGh = await importFromGh();
  if (fromGh) return { token: fromGh, source: "gh-cli" };

  return null;
}

async function readTokenFile(paths: Paths): Promise<string | null> {
  try {
    const raw = await fs.readFile(paths.tokenFile, "utf8");
    const token = raw.trim();
    return token || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function importFromGh(): Promise<string | null> {
  try {
    const { stdout } = await execa("gh", ["auth", "token"]);
    const token = stdout.trim();
    return token || null;
  } catch {
    return null; // gh not installed or not logged in — that's fine.
  }
}

/** Persist a token to STRAPPY_HOME/secrets/github-token with tight permissions. */
export async function saveToken(paths: Paths, token: string): Promise<void> {
  await fs.mkdir(paths.secrets, { recursive: true, mode: 0o700 });
  await fs.writeFile(paths.tokenFile, token.trim() + "\n", { mode: 0o600 });
  // mkdir's mode is subject to umask; enforce it explicitly.
  await fs.chmod(paths.secrets, 0o700);
  await fs.chmod(paths.tokenFile, 0o600);
}
