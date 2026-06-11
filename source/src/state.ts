import fs from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import type { Paths } from "./paths.js";

export interface RepoRecord {
  githubId: number;
  fullName: string;
  defaultBranch: string;
  archived: boolean;
  private: boolean;
  /** True once the repo is gone from GitHub. The mirror is KEPT regardless. */
  orphaned: boolean;
  lastSync: string | null;
  lastSyncOk: boolean | null;
  lastError: string | null;
  sizeKb: number | null;
}

/** Ephemeral working copy registry — populated in Milestone 3, defined now for shape stability. */
export interface CheckoutRecord {
  repo: string;
  path: string;
  createdAt: string;
  branch: string;
}

export interface StrappyState {
  version: number;
  repos: Record<string, RepoRecord>;
  checkouts: Record<string, CheckoutRecord>;
  lastInventoryAt: string | null;
}

export const STATE_VERSION = 1;

export function emptyState(): StrappyState {
  return { version: STATE_VERSION, repos: {}, checkouts: {}, lastInventoryAt: null };
}

/**
 * Persistence boundary for strappy's state. Everything goes through this
 * interface so the JSON-file backend can later be swapped for better-sqlite3
 * (plan §7) without touching command code.
 */
export interface Store {
  /** Unlocked read — safe for display commands (status/list). */
  read(): Promise<StrappyState>;
  /**
   * Lock state.json, read it, run `fn` (which may be long-running, e.g. a full
   * sync), then persist. `checkpoint()` flushes intermediate progress while the
   * lock is still held, so a crash mid-sync doesn't lose completed repos.
   */
  transaction<T>(fn: (state: StrappyState, checkpoint: () => Promise<void>) => Promise<T>): Promise<T>;
}

export class JsonStore implements Store {
  constructor(private readonly paths: Paths) {}

  async read(): Promise<StrappyState> {
    try {
      const raw = await fs.readFile(this.paths.state, "utf8");
      return normalize(JSON.parse(raw) as Partial<StrappyState>);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw err;
    }
  }

  async transaction<T>(
    fn: (state: StrappyState, checkpoint: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    await this.ensureFile();
    // proper-lockfile needs the target to exist; lock the state file directly.
    const release = await lockfile.lock(this.paths.state, {
      retries: { retries: 10, factor: 1.5, minTimeout: 200, maxTimeout: 2000 },
      stale: 5 * 60 * 1000,
    });
    try {
      const state = await this.read();
      const checkpoint = () => this.write(state);
      const result = await fn(state, checkpoint);
      await this.write(state);
      return result;
    } finally {
      await release();
    }
  }

  private async ensureFile(): Promise<void> {
    await fs.mkdir(this.paths.home, { recursive: true });
    try {
      await fs.access(this.paths.state);
    } catch {
      await this.write(emptyState());
    }
  }

  private async write(state: StrappyState): Promise<void> {
    const tmp = this.paths.state + ".tmp";
    await fs.mkdir(path.dirname(this.paths.state), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
    await fs.rename(tmp, this.paths.state);
  }
}

function normalize(s: Partial<StrappyState>): StrappyState {
  return {
    version: s.version ?? STATE_VERSION,
    repos: s.repos ?? {},
    checkouts: s.checkouts ?? {},
    lastInventoryAt: s.lastInventoryAt ?? null,
  };
}
