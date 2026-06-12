# strappy-backup

Keep durable bare **mirrors** of all your GitHub repositories in one place, and
hand out **ephemeral working copies** under `/repo/checkouts` on demand. See
[`plan.md`](./plan.md) for the full design.

This repository currently implements the mirror engine, metadata enrichment, a
first-pass TUI, and direct GitHub-origin checkout management.

## What it does

- Enumerates your owned GitHub repos (plus any extra `owners` in config).
- Mirrors each one with `git clone --mirror` into `$STRAPPY_HOME/mirrors/<owner>/<repo>.git`,
  and keeps them up to date with pruning fetches.
- Detects **renames/transfers** (via the stable GitHub repo id) and moves the mirror.
- Flags repos that disappeared from GitHub as **orphaned** — and never deletes a
  mirror automatically.
- Captures **rich metadata** for every repo so future tooling (and the planned
  pi agent, plan §5) has something to reason over:
  - *Tier 1* (free with every `sync`): description, topics, language, license,
    stars/forks/watchers, created/updated/pushed timestamps, visibility,
    archived/fork/template flags, permissions — plus the **verbatim GitHub API
    object** as a hedge.
  - *Tier 2* (`strappy enrich`, ~8 API calls per repo): language byte
    breakdown, latest release, latest commit, branches, tags, contributors,
    true open-PR count, and the README itself. Refreshed only when older than
    `enrichmentMaxAgeDays` (config, default 7).
- Records everything in `strappy.db` (SQLite via better-sqlite3, queryable with
  plain SQL), guarded by a lock so a manual sync and the (future) daemon can't
  collide. A pre-existing `state.json` is imported automatically on first run.
- The GitHub token is resolved from env / `secrets/github-token` / `gh` and is
  **never written into a mirror's git config**.

Also present now: a first-pass interactive TUI shell for the dashboard,
checkout-oriented repo search/actions, real checkout workflows, audit placeholder, and
settings, plus a repo-local Codex skill at `skills/strappy-fleet` for AI-assisted
SQLite/CLI workflows. The daemon, audits, repo profiles, and deeper AI
integration are still future work. Relay push is intentionally not part of the current checkout flow:
checkouts use GitHub as `origin`, so normal `git push` works with your existing
Git credentials.

## Setup

```bash
npm install
cp .env.example .env      # then edit .env and paste your GitHub PAT
```

`.env` sets `STRAPPY_HOME=/repo/backups`, so all mirrors and state live under
`/repo/backups`. The PAT only needs **read-only** `Contents` + `Metadata`.

Provide the token in any of these ways (checked in this order):

1. `STRAPPY_GITHUB_TOKEN` in `.env` (recommended)
2. `GITHUB_TOKEN` in the environment
3. `strappy auth` (stores it at `$STRAPPY_HOME/secrets/github-token`, chmod 600)
4. `gh auth token`, if the GitHub CLI is installed

## Usage

Run with `npm run strappy -- <args>` (dev), or `npm run build && strappy <args>`.

```bash
npm run strappy --                     # interactive TUI when run in a TTY
npm run strappy -- auth --check        # which token would be used?
npm run strappy -- sync                # mirror everything (+ Tier-1 metadata)
npm run strappy -- sync owner/repo     # mirror just one
npm run strappy -- enrich              # fetch Tier-2 metadata where stale
npm run strappy -- enrich owner/repo --force   # refetch one repo now
npm run strappy -- info owner/repo     # everything strappy knows about a repo
npm run strappy -- info repo --json    # agent-friendly JSON (--full adds raw + README)
npm run strappy -- list                # list mirrors
npm run strappy -- list --stale        # only stale mirrors
npm run strappy -- list --orphaned     # repos gone from GitHub
npm run strappy -- checkout repo       # clone from mirror into /repo/checkouts/repo
npm run strappy -- checkouts           # scan dirty/unpushed status
npm run strappy -- checkouts --dirty   # only dirty checkouts
npm run strappy -- cleanup repo        # delete if clean and fully pushed
npm run strappy -- cleanup repo --force
npm run strappy -- status              # backup health
npm run strappy -- status --oneline    # one line for a shell prompt
```

## Docker Compose

Add a `strappy` service that reuses your existing image (no Dockerfile needed)
and forwards any args you pass after the service name:

```yaml
  strappy:
    image: <your-image-with-node-and-git>
    env_file:
      - ./source/.env          # STRAPPY_HOME=/repo/backups + STRAPPY_GITHUB_TOKEN
    volumes:
      - ./source:/repo/source
      - ./backups:/repo/backups
      - ./checkouts:/repo/checkouts
    working_dir: /repo/source
    entrypoint: /bin/bash -lc 'npm install --no-fund --no-audit && exec npm run --silent strappy -- "$@"' bash
    stdin_open: true
    tty: true
```

```bash
docker compose run --rm strappy              # interactive TUI
docker compose run --rm strappy sync
docker compose run --rm strappy list --stale
docker compose run --rm strappy checkout repo
docker compose run --rm strappy checkouts
docker compose run --rm strappy status
docker compose run --rm strappy auth          # interactive token prompt
```

The `entrypoint` forwards anything after `strappy` to the CLI via `"$@"` (the
trailing `bash` is `$0`). `--rm` removes the one-off container on exit;
`./backups` and `./checkouts` are mounted, so mirrors and disposable working
copies persist on the host between runs.
