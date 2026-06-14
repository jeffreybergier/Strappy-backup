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
  - *Tier 2* (`strappy sync` for stale repos, or `strappy enrich` manually,
    ~8 API calls per repo): language byte breakdown, latest release, latest
    commit, branches, tags, contributors, true open-PR count, and the README
    itself. Refreshed only when older than `enrichmentMaxAgeDays` (config,
    default 7).
  - *Tier 3* (`strappy sync`, non-archived repos only): raw `README.md`,
    `AGENTS.md`, and `compose.yml` contents from the `main` branch, capped for
    pathological files and stored in SQLite for agent context. `compose.yml` is
    stored raw for now rather than pre-parsed into services.
- Records everything in `strappy.db` (SQLite via better-sqlite3, queryable with
  plain SQL), guarded by a lock so a manual sync and the (future) daemon can't
  collide. A pre-existing `state.json` is imported automatically on first run.
- The GitHub token is resolved from env / `secrets/github-token` / `gh` and is
  **never written into a mirror's git config**.
- Repo-local environment files can be saved under `$STRAPPY_HOME/environments`
  and restored into future disposable checkouts without committing them to Git.

Also present now: a first-pass interactive TUI shell with a live auth/health
dashboard, checkout-oriented repo search/actions, and integrated checkout
workflows, a first-pass audit menu for repo hygiene, plus a repo-local
Codex skill at `skills/strappy-fleet` for AI-assisted SQLite/CLI workflows. The
daemon, durable audit findings, repo profiles, and deeper AI integration are
still future work. Relay push is intentionally not part of the current checkout flow:
checkouts use GitHub SSH remotes and Strappy never fetches, pulls, or pushes
them. Use your host shell for checkout network operations; the TUI only reads
the local checkout state already present on disk.

## Setup

```bash
npm install
cp .env.example .env      # then edit .env and paste your GitHub PAT
```

`.env` sets `STRAPPY_HOME=/repo/backups`, so all mirrors and state live under
`/repo/backups`. The PAT only needs **read-only** `Contents` + `Metadata`.

Provide the token in any of these ways (checked in this order):

1. `GITHUB_TOKEN` in `.env` or the environment
2. `strappy auth` (stores it at `$STRAPPY_HOME/secrets/github-token`, chmod 600)
3. `gh auth token`, if the GitHub CLI is installed

## Usage

Run with `npm run strappy -- <args>` (dev), or `npm run build && strappy <args>`.

```bash
npm run strappy --                     # interactive TUI when run in a TTY
npm run strappy -- auth --check        # which token would be used?
npm run strappy -- sync                # mirror everything (+ stale enrichment + Tier-3 files)
npm run strappy -- sync owner/repo     # mirror just one
npm run strappy -- enrich              # fetch Tier-2 metadata without mirroring
npm run strappy -- enrich owner/repo --force   # refetch one repo now
npm run strappy -- info owner/repo     # everything strappy knows about a repo
npm run strappy -- info repo --json    # agent-friendly JSON (--full adds raw/file bodies)
npm run strappy -- list                # list mirrors
npm run strappy -- list --stale        # only stale mirrors
npm run strappy -- list --orphaned     # repos gone from GitHub
npm run strappy -- checkout repo       # clone into /repo/checkouts/repo on vibing/YYYY-MM-DD
npm run strappy -- env save repo --from /path/to/checkout .env
npm run strappy -- env list repo
npm run strappy -- env update repo --from /path/to/checkout
npm run strappy -- env restore repo --to /path/to/checkout
npm run strappy -- checkout repo --env default
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
      - ./.env                 # STRAPPY_HOME=/repo/backups + GITHUB_TOKEN
    volumes:
      - ./source:/repo/source
      - ./backups:/repo/backups
      - ./checkouts:/repo/checkouts
    working_dir: /repo/source
    entrypoint: /bin/bash -lc 'npm install --no-fund --no-audit --loglevel=error >/dev/null && exec npm run --silent strappy -- "$@"' bash
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

## Environments

Saved environment files live under a repo-relative tree:

```text
$STRAPPY_HOME/environments/<owner>/<repo>/<repo-relative-path>
```

By default, save/update discovers repo-relative files that Git is not tracking:
untracked files, ignored files, and tracked files marked assume-unchanged or
skip-worktree. Dependency and generated-cache noise such as `node_modules` and
`.wrangler/tmp` is skipped. Explicit repo-relative file or directory paths can
still be passed to save/update. Restore refuses unsafe paths, symlinks, and
existing different target files unless `--overwrite` is passed. Files are
restored with private permissions (`0600`, or `0700` for executable files). The
`<owner>/<repo>` directory is the source of truth and can be edited directly;
Strappy rebuilds its saved secret list by scanning this tree when listing
environments, including when the TUI opens `Environments`.

Use `strappy env list` to show each saved repo and its secret count. Use
`strappy env update [repo] --from <checkout>` to refresh the discovered
environment file set from a checkout; update refuses to run when tracked files
have uncommitted changes. Add specific paths with `strappy env save`.
The interactive TUI has the same environment workflows under `Environments`,
and checkout creation prompts to restore saved secrets when the repo has any.
