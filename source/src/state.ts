import type { RepoEnrichment, RepoMetadata } from "./metadata.js";

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
  /** Local mirror size on disk (metadata.remoteSizeKb is GitHub's number). */
  sizeKb: number | null;
  /** Tier-1 metadata captured from the repo-list response on every sync. */
  metadata: RepoMetadata | null;
  /** Full GitHub API repository object, verbatim. */
  raw: unknown | null;
  /** Tier-2 facets from `strappy enrich`; refreshed when stale. */
  enrichment: RepoEnrichment | null;
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

/** v2: storage moved from state.json to strappy.db (SQLite) + metadata tiers. */
export const STATE_VERSION = 2;

export function emptyState(): StrappyState {
  return { version: STATE_VERSION, repos: {}, checkouts: {}, lastInventoryAt: null };
}

/**
 * Persistence boundary for strappy's state. Commands only see this interface;
 * the SQLite backend (db.ts) implements it, and the legacy state.json file is
 * imported once on first open.
 */
export interface Store {
  /** Unlocked read — safe for display commands (status/list). */
  read(): Promise<StrappyState>;
  /**
   * Lock the store, read it, run `fn` (which may be long-running, e.g. a full
   * sync), then persist. `checkpoint()` flushes intermediate progress while the
   * lock is still held, so a crash mid-sync doesn't lose completed repos.
   */
  transaction<T>(
    fn: (state: StrappyState, checkpoint: () => Promise<void>) => Promise<T>,
  ): Promise<T>;
}

/** Fill defaults on a parsed legacy state.json (or partial state). */
export function normalize(s: Partial<StrappyState>): StrappyState {
  const repos: Record<string, RepoRecord> = {};
  for (const [name, rec] of Object.entries(s.repos ?? {})) {
    // Pre-v2 records lack the metadata fields; default them to null.
    repos[name] = {
      ...rec,
      metadata: rec.metadata ?? null,
      raw: rec.raw ?? null,
      enrichment: rec.enrichment ?? null,
    };
  }
  return {
    // Normalizing always produces the CURRENT shape, so stamp the current
    // version — keeping a legacy file's version would persist "1" forever.
    version: STATE_VERSION,
    repos,
    checkouts: s.checkouts ?? {},
    lastInventoryAt: s.lastInventoryAt ?? null,
  };
}
