# Strappy SQLite and CLI Reference

## Paths

Strappy stores state under `STRAPPY_HOME`, defaulting to `~/.strappy`.

Important paths:

- Database: `$STRAPPY_HOME/strappy.db`
- Lock file: `$STRAPPY_HOME/strappy.db.lock`
- Config: `$STRAPPY_HOME/config.json`
- Mirrors: `$STRAPPY_HOME/mirrors/<owner>/<repo>.git`
- Token file: `$STRAPPY_HOME/secrets/github-token`
- Default checkout root in this workspace: `/repo/checkouts`

Do not read or print the token file. Use `npm run strappy -- auth --check`.

Resolve `STRAPPY_HOME` from a source checkout:

```bash
STRAPPY_HOME_RESOLVED=$(node -r dotenv/config -e "const os=require('node:os'),path=require('node:path'); console.log(process.env.STRAPPY_HOME ? path.resolve(process.env.STRAPPY_HOME) : path.join(os.homedir(), '.strappy'))")
DB="$STRAPPY_HOME_RESOLVED/strappy.db"
```

## Tables

### `meta`

- `key TEXT PRIMARY KEY`
- `value TEXT`

Useful keys include `version` and `last_inventory_at`.

### `repos`

One row per mirrored GitHub repository.

Core identity:

- `github_id INTEGER PRIMARY KEY`
- `full_name TEXT UNIQUE`
- `owner TEXT`
- `name TEXT`
- `owner_type TEXT`
- `html_url TEXT`
- `ssh_url TEXT`
- `default_branch TEXT`

Visibility and flags:

- `visibility TEXT`
- `private INTEGER`
- `archived INTEGER`
- `disabled INTEGER`
- `fork INTEGER`
- `is_template INTEGER`
- `orphaned INTEGER`

Metadata:

- `description TEXT`
- `homepage TEXT`
- `language TEXT`
- `license_spdx TEXT`
- `topics TEXT` JSON array
- `stars INTEGER`
- `forks INTEGER`
- `watchers INTEGER`
- `open_issues INTEGER`
- `has_issues INTEGER`
- `has_wiki INTEGER`
- `has_pages INTEGER`
- `has_discussions INTEGER`
- `remote_size_kb INTEGER`
- `created_at TEXT`
- `updated_at TEXT`
- `pushed_at TEXT`
- `permissions TEXT` JSON object
- `has_metadata INTEGER`
- `raw_json TEXT` full GitHub API repository JSON

Mirror state:

- `last_sync TEXT`
- `last_sync_ok INTEGER`
- `last_error TEXT`
- `mirror_size_kb INTEGER`

### `enrichment`

One optional row per repo, keyed by `github_id`.

- `github_id INTEGER PRIMARY KEY`
- `fetched_at TEXT`
- `languages TEXT` JSON object of language byte counts
- `latest_release TEXT` JSON object
- `has_releases INTEGER`
- `latest_commit TEXT` JSON object
- `branches TEXT` JSON array of `{name, protected}`
- `tags TEXT` JSON array
- `contributors TEXT` JSON array of `{login, contributions}`
- `open_pr_count INTEGER`
- `readme TEXT`

### `checkouts`

One row per registered disposable working copy.

- `name TEXT PRIMARY KEY`
- `repo TEXT`
- `path TEXT`
- `created_at TEXT`
- `branch TEXT`
- `mode TEXT`
- `remote_url TEXT`
- `last_scan TEXT`
- `exists_on_disk INTEGER`
- `dirty INTEGER`
- `ahead INTEGER`
- `behind INTEGER`
- `current_branch TEXT`
- `head_sha TEXT`
- `upstream TEXT`
- `scan_error TEXT`

## Read-Only Query Recipes

Fleet summary:

```sql
SELECT
  COUNT(*) AS repos,
  ROUND(COALESCE(SUM(mirror_size_kb), 0) / 1024.0 / 1024.0, 2) AS mirror_gib,
  SUM(last_sync_ok = 0) AS failures,
  SUM(orphaned = 1) AS orphaned,
  SUM(private = 1) AS private
FROM repos;
```

Inventory timestamp:

```sql
SELECT key, value FROM meta WHERE key IN ('version', 'last_inventory_at');
```

Recent sync failures:

```sql
SELECT full_name, last_sync, last_error
FROM repos
WHERE last_sync_ok = 0
ORDER BY last_sync DESC;
```

Repos that have not pushed in a year:

```sql
SELECT full_name, language, pushed_at, html_url
FROM repos
WHERE orphaned = 0
  AND (pushed_at IS NULL OR datetime(pushed_at) < datetime('now', '-1 year'))
ORDER BY pushed_at;
```

Potentially stale mirrors using the default 6 hour freshness window:

```sql
SELECT full_name, last_sync, last_error
FROM repos
WHERE last_sync IS NULL
   OR datetime(last_sync) < datetime('now', '-6 hours')
ORDER BY last_sync;
```

Top languages from enrichment:

```sql
SELECT r.full_name, j.key AS language, j.value AS bytes
FROM enrichment e
JOIN repos r USING (github_id),
     json_each(e.languages) AS j
ORDER BY j.value DESC
LIMIT 50;
```

Repos with protected branch info:

```sql
SELECT
  r.full_name,
  json_extract(b.value, '$.name') AS branch,
  json_extract(b.value, '$.protected') AS protected
FROM enrichment e
JOIN repos r USING (github_id),
     json_each(e.branches) AS b
WHERE branch = r.default_branch;
```

Topics:

```sql
SELECT r.full_name, t.value AS topic
FROM repos r, json_each(r.topics) AS t
ORDER BY topic, r.full_name;
```

Checkouts needing attention:

```sql
SELECT name, repo, current_branch, dirty, ahead, behind, path, scan_error
FROM checkouts
WHERE dirty = 1
   OR COALESCE(ahead, 0) > 0
   OR scan_error IS NOT NULL
   OR exists_on_disk = 0
ORDER BY repo, name;
```

## Mirror File Inspection

Use Git against bare mirrors. Get the mirror path from `full_name`:

```bash
MIRROR="$STRAPPY_HOME_RESOLVED/mirrors/OWNER/REPO.git"
git --git-dir "$MIRROR" ls-tree -r --name-only main
git --git-dir "$MIRROR" show main:README.md
```

Use the repo's `default_branch` from SQLite instead of assuming `main`.

Search code by cloning or checking out to a temporary directory when necessary.
Do not run destructive Git commands inside mirrors.

## CLI Commands

Run from the Strappy source repo:

```bash
npm run strappy -- status
npm run strappy -- list [--stale|--orphaned]
npm run strappy -- info <repo> [--json|--full]
npm run strappy -- auth --check
```

State-changing commands:

```bash
npm run strappy -- sync [repo...]
npm run strappy -- enrich [repo...] [--force]
npm run strappy -- checkout <repo> [--branch B] [--name N] [--path P]
npm run strappy -- scan-checkouts [name|--all]
npm run strappy -- cleanup [name|--all] [--force]
```

Checkout status:

```bash
npm run strappy -- checkouts [--dirty|--unpushed|--json]
```

Safety notes:

- Use `scan-checkouts` before cleanup decisions.
- `cleanup` without `--force` refuses dirty or unpushed checkouts.
- Use `--force` only after explicit user instruction.
- `sync` and `enrich` contact GitHub and require a token.
- `checkout` creates a working copy and sets GitHub as `origin`.
