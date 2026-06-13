import fs from "node:fs/promises";
import Database from "better-sqlite3";
import lockfile from "proper-lockfile";
import type { RepoEnrichment, RepoMetadata, RepoTier3Metadata } from "./metadata.js";
import type { Paths } from "./paths.js";
import {
  normalize,
  STATE_VERSION,
  type CheckoutRecord,
  type RepoRecord,
  type Store,
  type StrappyState,
} from "./state.js";

/**
 * Tier-1 fields get real columns so an agent (or you, with `sqlite3`) can
 * query the fleet directly — "SELECT full_name FROM repos WHERE pushed_at <
 * date('now','-1 year')". The verbatim API object rides along in raw_json,
 * Tier-2 facets live in `enrichment`, and sync-time Tier-3 file bodies live in
 * `tier3_metadata`, both keyed by github_id.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS repos (
  github_id       INTEGER PRIMARY KEY,
  full_name       TEXT NOT NULL UNIQUE,
  owner           TEXT,
  name            TEXT,
  owner_type      TEXT,
  description     TEXT,
  homepage        TEXT,
  html_url        TEXT,
  ssh_url         TEXT,
  default_branch  TEXT,
  visibility      TEXT,
  private         INTEGER,
  archived        INTEGER,
  disabled        INTEGER,
  fork            INTEGER,
  is_template     INTEGER,
  language        TEXT,
  license_spdx    TEXT,
  topics          TEXT,    -- JSON array
  stars           INTEGER,
  forks           INTEGER,
  watchers        INTEGER,
  open_issues     INTEGER, -- GitHub lumps PRs into this; see enrichment.open_pr_count
  has_issues      INTEGER,
  has_wiki        INTEGER,
  has_pages       INTEGER,
  has_discussions INTEGER,
  remote_size_kb  INTEGER,
  created_at      TEXT,
  updated_at      TEXT,
  pushed_at       TEXT,
  permissions     TEXT,    -- JSON object
  has_metadata    INTEGER NOT NULL DEFAULT 0,
  raw_json        TEXT,    -- full GitHub API repository object, verbatim
  orphaned        INTEGER NOT NULL DEFAULT 0,
  last_sync       TEXT,
  last_sync_ok    INTEGER,
  last_error      TEXT,
  mirror_size_kb  INTEGER
);

CREATE TABLE IF NOT EXISTS enrichment (
  github_id     INTEGER PRIMARY KEY,
  fetched_at    TEXT NOT NULL,
  languages     TEXT,    -- JSON {lang: bytes}
  latest_release TEXT,   -- JSON {tag,name,publishedAt,prerelease}
  has_releases  INTEGER,
  latest_commit TEXT,    -- JSON {sha,message,author,date}
  branches      TEXT,    -- JSON [{name,protected}]
  tags          TEXT,    -- JSON [name]
  contributors  TEXT,    -- JSON [{login,contributions}]
  open_pr_count INTEGER,
  readme        TEXT
);

CREATE TABLE IF NOT EXISTS tier3_metadata (
  github_id   INTEGER PRIMARY KEY,
  fetched_at  TEXT NOT NULL,
  ref         TEXT NOT NULL,
  readme_md   TEXT,
  agents_md   TEXT,
  compose_yml TEXT
);

CREATE TABLE IF NOT EXISTS checkouts (
  name       TEXT PRIMARY KEY,
  repo       TEXT NOT NULL,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  branch     TEXT NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'github',
  remote_url TEXT,
  last_scan  TEXT,
  exists_on_disk INTEGER,
  dirty      INTEGER,
  ahead      INTEGER,
  behind     INTEGER,
  current_branch TEXT,
  head_sha   TEXT,
  upstream   TEXT,
  scan_error TEXT
);
`;

export function openStore(paths: Paths): Store {
  return new SqliteStore(paths);
}

export class SqliteStore implements Store {
  private db: Database.Database | null = null;

  constructor(private readonly paths: Paths) {}

  async read(): Promise<StrappyState> {
    const db = await this.open();
    return readState(db);
  }

  async transaction<T>(
    fn: (state: StrappyState, checkpoint: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    const db = await this.open();
    // proper-lockfile (not SQLite's own locking) guards the WHOLE run, so a
    // manual sync and the daemon's scheduled sync still can't interleave.
    await ensureFile(this.paths.dbLock);
    const release = await lockfile.lock(this.paths.dbLock, {
      retries: { retries: 10, factor: 1.5, minTimeout: 200, maxTimeout: 2000 },
      stale: 5 * 60 * 1000,
    });
    try {
      const state = readState(db);
      const checkpoint = async () => writeState(db, state);
      const result = await fn(state, checkpoint);
      writeState(db, state);
      return result;
    } finally {
      await release();
    }
  }

  private async open(): Promise<Database.Database> {
    if (this.db) return this.db;
    await fs.mkdir(this.paths.home, { recursive: true });
    const db = new Database(this.paths.db);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.exec(SCHEMA);
    migrate(db);
    this.db = db;
    await this.importLegacyJson(db);
    return db;
  }

  /** One-time import of the pre-v2 state.json into a fresh database. */
  private async importLegacyJson(db: Database.Database): Promise<void> {
    const count = db.prepare("SELECT COUNT(*) AS n FROM repos").get() as { n: number };
    const checkouts = db.prepare("SELECT COUNT(*) AS n FROM checkouts").get() as { n: number };
    if (count.n > 0 || checkouts.n > 0) return;

    let raw: string;
    try {
      raw = await fs.readFile(this.paths.state, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return; // fresh install
      throw err;
    }

    const legacy = normalize(JSON.parse(raw) as Partial<StrappyState>);
    writeState(db, legacy);
    await fs.rename(this.paths.state, this.paths.state + ".migrated");
    process.stderr.write(
      `strappy: imported ${Object.keys(legacy.repos).length} repo(s) from state.json into strappy.db ` +
        `(state.json renamed to state.json.migrated)\n`,
    );
  }
}

function readState(db: Database.Database): StrappyState {
  const meta = new Map<string, string>(
    (db.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map(
      (r) => [r.key, r.value],
    ),
  );

  const enrichmentById = new Map<number, RepoEnrichment>();
  for (const row of db.prepare("SELECT * FROM enrichment").all() as EnrichmentRow[]) {
    enrichmentById.set(row.github_id, {
      fetchedAt: row.fetched_at,
      languages: parse(row.languages),
      latestRelease: parse(row.latest_release),
      hasReleases: fromBool(row.has_releases),
      latestCommit: parse(row.latest_commit),
      branches: parse(row.branches),
      tags: parse(row.tags),
      contributors: parse(row.contributors),
      openPrCount: row.open_pr_count,
      readme: row.readme,
    });
  }

  const tier3ById = new Map<number, RepoTier3Metadata>();
  for (const row of db.prepare("SELECT * FROM tier3_metadata").all() as Tier3Row[]) {
    tier3ById.set(row.github_id, {
      fetchedAt: row.fetched_at,
      ref: row.ref,
      readmeMd: row.readme_md,
      agentsMd: row.agents_md,
      composeYml: row.compose_yml,
    });
  }

  const repos: Record<string, RepoRecord> = {};
  for (const row of db.prepare("SELECT * FROM repos").all() as RepoRow[]) {
    repos[row.full_name] = {
      githubId: row.github_id,
      fullName: row.full_name,
      defaultBranch: row.default_branch ?? "main",
      archived: row.archived === 1,
      private: row.private === 1,
      orphaned: row.orphaned === 1,
      lastSync: row.last_sync,
      lastSyncOk: fromBool(row.last_sync_ok),
      lastError: row.last_error,
      sizeKb: row.mirror_size_kb,
      metadata: row.has_metadata ? metadataFromRow(row) : null,
      raw: row.raw_json ? (JSON.parse(row.raw_json) as unknown) : null,
      enrichment: enrichmentById.get(row.github_id) ?? null,
      tier3: tier3ById.get(row.github_id) ?? null,
    };
  }

  const checkouts: Record<string, CheckoutRecord> = {};
  for (const row of db.prepare("SELECT * FROM checkouts").all() as CheckoutRow[]) {
    checkouts[row.name] = {
      repo: row.repo,
      path: row.path,
      createdAt: row.created_at,
      branch: row.branch,
      mode: row.mode === "local" ? "local" : "github",
      remoteUrl: row.remote_url,
      lastScan: row.last_scan,
      exists: fromBool(row.exists_on_disk),
      dirty: fromBool(row.dirty),
      ahead: row.ahead,
      behind: row.behind,
      currentBranch: row.current_branch,
      headSha: row.head_sha,
      upstream: row.upstream,
      scanError: row.scan_error,
    };
  }

  return {
    version: Number(meta.get("version") ?? STATE_VERSION),
    repos,
    checkouts,
    lastInventoryAt: meta.get("last_inventory_at") ?? null,
  };
}

/**
 * Full rewrite of all tables in one SQLite transaction. At strappy's scale
 * (hundreds of repos) this is a few milliseconds with better-sqlite3, and it
 * keeps the Store contract trivially correct — no dirty tracking.
 */
const writeStateTx = new WeakMap<Database.Database, (state: StrappyState) => void>();

function writeState(db: Database.Database, state: StrappyState): void {
  let tx = writeStateTx.get(db);
  if (!tx) {
    const insertRepo = db.prepare(`
      INSERT INTO repos (
        github_id, full_name, owner, name, owner_type, description, homepage,
        html_url, ssh_url, default_branch, visibility, private,
        archived, disabled, fork, is_template, language, license_spdx, topics,
        stars, forks, watchers, open_issues, has_issues, has_wiki, has_pages,
        has_discussions, remote_size_kb, created_at, updated_at, pushed_at,
        permissions, has_metadata, raw_json, orphaned, last_sync, last_sync_ok,
        last_error, mirror_size_kb
      ) VALUES (
        @github_id, @full_name, @owner, @name, @owner_type, @description, @homepage,
        @html_url, @ssh_url, @default_branch, @visibility, @private,
        @archived, @disabled, @fork, @is_template, @language, @license_spdx, @topics,
        @stars, @forks, @watchers, @open_issues, @has_issues, @has_wiki, @has_pages,
        @has_discussions, @remote_size_kb, @created_at, @updated_at, @pushed_at,
        @permissions, @has_metadata, @raw_json, @orphaned, @last_sync, @last_sync_ok,
        @last_error, @mirror_size_kb
      )`);
    const insertEnrichment = db.prepare(`
      INSERT INTO enrichment (
        github_id, fetched_at, languages, latest_release, has_releases,
        latest_commit, branches, tags, contributors, open_pr_count, readme
      ) VALUES (
        @github_id, @fetched_at, @languages, @latest_release, @has_releases,
        @latest_commit, @branches, @tags, @contributors, @open_pr_count, @readme
      )`);
    const insertTier3 = db.prepare(`
      INSERT INTO tier3_metadata (
        github_id, fetched_at, ref, readme_md, agents_md, compose_yml
      ) VALUES (
        @github_id, @fetched_at, @ref, @readme_md, @agents_md, @compose_yml
      )`);
    const insertCheckout = db.prepare(`
      INSERT INTO checkouts (
        name, repo, path, created_at, branch, mode, remote_url, last_scan,
        exists_on_disk, dirty, ahead, behind, current_branch, head_sha,
        upstream, scan_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const putMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    const delMeta = db.prepare("DELETE FROM meta WHERE key = ?");

    tx = db.transaction((s: StrappyState) => {
      db.exec("DELETE FROM repos; DELETE FROM enrichment; DELETE FROM tier3_metadata; DELETE FROM checkouts;");
      for (const rec of Object.values(s.repos)) {
        insertRepo.run(repoToRow(rec));
        if (rec.enrichment) {
          const e = rec.enrichment;
          insertEnrichment.run({
            github_id: rec.githubId,
            fetched_at: e.fetchedAt,
            languages: json(e.languages),
            latest_release: json(e.latestRelease),
            has_releases: toBool(e.hasReleases),
            latest_commit: json(e.latestCommit),
            branches: json(e.branches),
            tags: json(e.tags),
            contributors: json(e.contributors),
            open_pr_count: e.openPrCount,
            readme: e.readme,
          });
        }
        if (rec.tier3) {
          const t = rec.tier3;
          insertTier3.run({
            github_id: rec.githubId,
            fetched_at: t.fetchedAt,
            ref: t.ref,
            readme_md: t.readmeMd,
            agents_md: t.agentsMd,
            compose_yml: t.composeYml,
          });
        }
      }
      for (const [name, c] of Object.entries(s.checkouts)) {
        insertCheckout.run(
          name,
          c.repo,
          c.path,
          c.createdAt,
          c.branch,
          c.mode,
          c.remoteUrl,
          c.lastScan,
          toBool(c.exists),
          toBool(c.dirty),
          c.ahead,
          c.behind,
          c.currentBranch,
          c.headSha,
          c.upstream,
          c.scanError,
        );
      }
      putMeta.run("version", String(s.version));
      if (s.lastInventoryAt === null) delMeta.run("last_inventory_at");
      else putMeta.run("last_inventory_at", s.lastInventoryAt);
    });
    writeStateTx.set(db, tx);
  }
  tx(state);
}

function repoToRow(rec: RepoRecord): Record<string, unknown> {
  const m = rec.metadata;
  return {
    github_id: rec.githubId,
    full_name: rec.fullName,
    owner: m?.owner ?? null,
    name: m?.name ?? null,
    owner_type: m?.ownerType ?? null,
    description: m?.description ?? null,
    homepage: m?.homepage ?? null,
    html_url: m?.htmlUrl ?? null,
    ssh_url: m?.sshUrl ?? null,
    default_branch: rec.defaultBranch,
    visibility: m?.visibility ?? null,
    private: toBool(rec.private),
    archived: toBool(rec.archived),
    disabled: toBool(m?.disabled ?? null),
    fork: toBool(m?.fork ?? null),
    is_template: toBool(m?.isTemplate ?? null),
    language: m?.language ?? null,
    license_spdx: m?.licenseSpdx ?? null,
    topics: json(m?.topics ?? null),
    stars: m?.stars ?? null,
    forks: m?.forks ?? null,
    watchers: m?.watchers ?? null,
    open_issues: m?.openIssues ?? null,
    has_issues: toBool(m?.hasIssues ?? null),
    has_wiki: toBool(m?.hasWiki ?? null),
    has_pages: toBool(m?.hasPages ?? null),
    has_discussions: toBool(m?.hasDiscussions ?? null),
    remote_size_kb: m?.remoteSizeKb ?? null,
    created_at: m?.createdAt ?? null,
    updated_at: m?.updatedAt ?? null,
    pushed_at: m?.pushedAt ?? null,
    permissions: json(m?.permissions ?? null),
    has_metadata: m ? 1 : 0,
    raw_json: json(rec.raw),
    orphaned: rec.orphaned ? 1 : 0,
    last_sync: rec.lastSync,
    last_sync_ok: toBool(rec.lastSyncOk),
    last_error: rec.lastError,
    mirror_size_kb: rec.sizeKb,
  };
}

function metadataFromRow(row: RepoRow): RepoMetadata {
  return {
    name: row.name ?? row.full_name.split("/")[1] ?? row.full_name,
    owner: row.owner ?? row.full_name.split("/")[0] ?? "",
    ownerType: row.owner_type ?? "User",
    description: row.description,
    homepage: row.homepage,
    htmlUrl: row.html_url ?? `https://github.com/${row.full_name}`,
    sshUrl: row.ssh_url,
    topics: parse<string[]>(row.topics) ?? [],
    language: row.language,
    licenseSpdx: row.license_spdx,
    visibility: row.visibility ?? (row.private === 1 ? "private" : "public"),
    fork: row.fork === 1,
    isTemplate: row.is_template === 1,
    disabled: row.disabled === 1,
    remoteSizeKb: row.remote_size_kb ?? 0,
    stars: row.stars ?? 0,
    forks: row.forks ?? 0,
    watchers: row.watchers ?? 0,
    openIssues: row.open_issues ?? 0,
    hasIssues: row.has_issues === 1,
    hasWiki: row.has_wiki === 1,
    hasPages: row.has_pages === 1,
    hasDiscussions: row.has_discussions === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pushedAt: row.pushed_at,
    permissions: parse(row.permissions),
  };
}

interface RepoRow {
  github_id: number;
  full_name: string;
  owner: string | null;
  name: string | null;
  owner_type: string | null;
  description: string | null;
  homepage: string | null;
  html_url: string | null;
  ssh_url: string | null;
  default_branch: string | null;
  visibility: string | null;
  private: number | null;
  archived: number | null;
  disabled: number | null;
  fork: number | null;
  is_template: number | null;
  language: string | null;
  license_spdx: string | null;
  topics: string | null;
  stars: number | null;
  forks: number | null;
  watchers: number | null;
  open_issues: number | null;
  has_issues: number | null;
  has_wiki: number | null;
  has_pages: number | null;
  has_discussions: number | null;
  remote_size_kb: number | null;
  created_at: string | null;
  updated_at: string | null;
  pushed_at: string | null;
  permissions: string | null;
  has_metadata: number;
  raw_json: string | null;
  orphaned: number;
  last_sync: string | null;
  last_sync_ok: number | null;
  last_error: string | null;
  mirror_size_kb: number | null;
}

interface EnrichmentRow {
  github_id: number;
  fetched_at: string;
  languages: string | null;
  latest_release: string | null;
  has_releases: number | null;
  latest_commit: string | null;
  branches: string | null;
  tags: string | null;
  contributors: string | null;
  open_pr_count: number | null;
  readme: string | null;
}

interface Tier3Row {
  github_id: number;
  fetched_at: string;
  ref: string;
  readme_md: string | null;
  agents_md: string | null;
  compose_yml: string | null;
}

interface CheckoutRow {
  name: string;
  repo: string;
  path: string;
  created_at: string;
  branch: string;
  mode: string | null;
  remote_url: string | null;
  last_scan: string | null;
  exists_on_disk: number | null;
  dirty: number | null;
  ahead: number | null;
  behind: number | null;
  current_branch: string | null;
  head_sha: string | null;
  upstream: string | null;
  scan_error: string | null;
}

function json(v: unknown): string | null {
  return v === null || v === undefined ? null : JSON.stringify(v);
}

function parse<T>(v: string | null): T | null {
  return v === null ? null : (JSON.parse(v) as T);
}

function toBool(v: boolean | null | undefined): number | null {
  return v === null || v === undefined ? null : v ? 1 : 0;
}

function fromBool(v: number | null): boolean | null {
  return v === null ? null : v === 1;
}

async function ensureFile(p: string): Promise<void> {
  try {
    await fs.access(p);
  } catch {
    await fs.writeFile(p, "", "utf8");
  }
}

function migrate(db: Database.Database): void {
  const cols = new Set(
    (db.prepare("PRAGMA table_info(checkouts)").all() as { name: string }[]).map((c) => c.name),
  );
  const add = (name: string, ddl: string) => {
    if (!cols.has(name)) db.exec(`ALTER TABLE checkouts ADD COLUMN ${ddl}`);
  };

  add("mode", "mode TEXT NOT NULL DEFAULT 'github'");
  add("remote_url", "remote_url TEXT");
  add("last_scan", "last_scan TEXT");
  add("exists_on_disk", "exists_on_disk INTEGER");
  add("dirty", "dirty INTEGER");
  add("ahead", "ahead INTEGER");
  add("behind", "behind INTEGER");
  add("current_branch", "current_branch TEXT");
  add("head_sha", "head_sha TEXT");
  add("upstream", "upstream TEXT");
  add("scan_error", "scan_error TEXT");
}
