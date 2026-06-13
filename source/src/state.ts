import type { RepoEnrichment, RepoMetadata, RepoTier3Metadata } from "./metadata.js";

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
  /** Tier-3 sync-time agent context files from the repo's `main` branch. */
  tier3: RepoTier3Metadata | null;
}

/** Ephemeral working copy registry and last-known safety scan. */
export interface CheckoutRecord {
  repo: string;
  path: string;
  createdAt: string;
  branch: string;
  /** `github` is the normal direct-push flow; `local` is retained for escape hatches/tests. */
  mode: "github" | "local";
  remoteUrl: string | null;
  lastScan: string | null;
  exists: boolean | null;
  dirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  currentBranch: string | null;
  headSha: string | null;
  upstream: string | null;
  scanError: string | null;
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
      tier3: rec.tier3 ?? null,
    };
  }
  return {
    // Normalizing always produces the CURRENT shape, so stamp the current
    // version — keeping a legacy file's version would persist "1" forever.
    version: STATE_VERSION,
    repos,
    checkouts: normalizeCheckouts(s.checkouts ?? {}),
    lastInventoryAt: s.lastInventoryAt ?? null,
  };
}

function normalizeCheckouts(checkouts: Record<string, CheckoutRecord>): Record<string, CheckoutRecord> {
  const out: Record<string, CheckoutRecord> = {};
  for (const [name, c] of Object.entries(checkouts)) {
    out[name] = {
      ...c,
      mode: c.mode ?? "github",
      remoteUrl: c.remoteUrl ?? null,
      lastScan: c.lastScan ?? null,
      exists: c.exists ?? null,
      dirty: c.dirty ?? null,
      ahead: c.ahead ?? null,
      behind: c.behind ?? null,
      currentBranch: c.currentBranch ?? null,
      headSha: c.headSha ?? null,
      upstream: c.upstream ?? null,
      scanError: c.scanError ?? null,
    };
  }
  return out;
}
