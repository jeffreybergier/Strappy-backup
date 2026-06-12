---
name: strappy-fleet
description: "Use when Codex needs to inspect or operate a Strappy backup fleet: querying Strappy's SQLite database, answering questions about mirrored GitHub repositories, checking sync/enrichment/audit/checkout state, or using the Strappy CLI for sync, enrich, checkout, scan, cleanup, auth, list, info, and status workflows."
---

# Strappy Fleet

Use this skill to work with a Strappy repository backup fleet from a repo that
contains Strappy or has access to `STRAPPY_HOME`.

## Core Rules

- Prefer read-only SQLite queries for inspection and reporting.
- Use the Strappy CLI for state changes. Do not mutate `strappy.db` directly.
- Do not read or print token files. Use `strappy auth --check` when auth status is needed.
- Scan checkouts before judging cleanup safety.
- Never run `cleanup --force`, delete checkout paths, or change auth/config unless the user explicitly asks.
- For broad `sync`, `enrich`, or cleanup operations, tell the user what command you are running and why.

## Find Strappy

From the Strappy source repo, prefer:

```bash
npm run strappy -- status
npm run strappy -- <command>
```

If a global binary is available, `strappy <command>` is also fine.

Resolve the database path with the same default as the app:

```bash
STRAPPY_HOME_RESOLVED=$(node -r dotenv/config -e "const os=require('node:os'),path=require('node:path'); console.log(process.env.STRAPPY_HOME ? path.resolve(process.env.STRAPPY_HOME) : path.join(os.homedir(), '.strappy'))")
DB="$STRAPPY_HOME_RESOLVED/strappy.db"
```

Read [references/strappy-sqlite-cli.md](references/strappy-sqlite-cli.md) when
you need table schemas, query examples, or CLI command semantics.

## Workflow

1. Start with `npm run strappy -- status` to verify home path, auth, inventory size, failures, and checkout count.
2. For questions like "which repos..." or "what needs attention...", query SQLite read-only.
3. For one-repo details, use `npm run strappy -- info owner/repo` or `--json`.
4. For stale data, use CLI updates:
   - `npm run strappy -- sync [repo...]`
   - `npm run strappy -- enrich [repo...]`
5. For working copies, use CLI checkout flows:
   - `npm run strappy -- checkout <repo> [--branch B] [--name N]`
   - `npm run strappy -- checkouts [--dirty|--unpushed|--json]`
   - `npm run strappy -- scan-checkouts [name|--all]`
   - `npm run strappy -- cleanup <name|--all>`

## Query Pattern

Use `sqlite3` in read-only mode:

```bash
sqlite3 -readonly -header -column "$DB" "SELECT COUNT(*) AS repos FROM repos;"
```

For JSON columns, use SQLite JSON functions when available:

```bash
sqlite3 -readonly -header -column "$DB" \
  "SELECT r.full_name, j.key AS language, j.value AS bytes
   FROM enrichment e
   JOIN repos r USING (github_id),
        json_each(e.languages) AS j
   ORDER BY j.value DESC
   LIMIT 20;"
```

If `sqlite3` is unavailable, run a tiny Node script using `better-sqlite3` with
`readonly: true`.
