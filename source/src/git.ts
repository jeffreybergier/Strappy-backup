import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

/**
 * Build a one-shot authenticated clone URL. Used only as a git argument for the
 * network operation; it is NEVER written to a mirror's config (we scrub origin
 * back to the clean URL after cloning), so the token never lands on disk in the
 * mirror store.
 */
function authUrl(cleanUrl: string, token: string): string {
  const u = new URL(cleanUrl);
  // Only HTTP(S) remotes take a token. file:// and ssh remotes are left as-is.
  if (u.protocol !== "https:" && u.protocol !== "http:") return cleanUrl;
  if (!token) return cleanUrl;
  u.username = "x-access-token";
  u.password = token;
  return u.toString();
}

/** Redact a token so it never reaches the log when we describe a git command. */
function redact(text: string, token: string): string {
  return token ? text.split(token).join("***") : text;
}

export async function mirrorExists(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, "HEAD"));
    return true;
  } catch {
    return false;
  }
}

/** `git clone --mirror`, then strip the token from origin so disk stays clean. */
export async function cloneMirror(dir: string, cleanUrl: string, token: string): Promise<void> {
  await fs.mkdir(path.dirname(dir), { recursive: true });
  try {
    await execa("git", ["clone", "--mirror", authUrl(cleanUrl, token), dir]);
  } catch (err) {
    throw redactError(err, token);
  }
  await execa("git", ["-C", dir, "remote", "set-url", "origin", cleanUrl]);
}

/**
 * Update an existing mirror to match upstream exactly, including pruning deleted
 * branches/tags. We fetch from an explicit authenticated URL (not the stored
 * origin) so, again, the token is never persisted in the mirror config.
 */
export async function updateMirror(dir: string, cleanUrl: string, token: string): Promise<void> {
  try {
    await execa("git", [
      "-C",
      dir,
      "fetch",
      "--prune",
      "--tags",
      authUrl(cleanUrl, token),
      "+refs/*:refs/*",
    ]);
  } catch (err) {
    throw redactError(err, token);
  }
}

/** Move a mirror directory (used when a repo is renamed/transferred on GitHub). */
export async function moveMirror(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
}

/** On-disk size of a mirror in KiB. Returns null if it can't be measured. */
export async function dirSizeKb(dir: string): Promise<number | null> {
  try {
    const { stdout } = await execa("du", ["-sk", dir]);
    const kb = parseInt(stdout.split(/\s+/)[0], 10);
    return Number.isFinite(kb) ? kb : null;
  } catch {
    return null;
  }
}

function redactError(err: unknown, token: string): Error {
  if (err instanceof Error) {
    const clean = new Error(redact(err.message, token));
    clean.stack = err.stack ? redact(err.stack, token) : undefined;
    return clean;
  }
  return new Error(redact(String(err), token));
}
