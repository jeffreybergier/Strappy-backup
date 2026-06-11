# strappy-backup

Keep durable bare **mirrors** of all your GitHub repositories in one place, and
(later) hand out **ephemeral working copies** on demand. See [`plan.md`](./plan.md)
for the full design.

This repository currently implements **Milestone 1 — the mirror engine**: the
backup is real once you've run a sync.

## What M1 does

- Enumerates your owned GitHub repos (plus any extra `owners` in config).
- Mirrors each one with `git clone --mirror` into `$STRAPPY_HOME/mirrors/<owner>/<repo>.git`,
  and keeps them up to date with pruning fetches.
- Detects **renames/transfers** (via the stable GitHub repo id) and moves the mirror.
- Flags repos that disappeared from GitHub as **orphaned** — and never deletes a
  mirror automatically.
- Records everything in `state.json`, guarded by a lock so a manual sync and the
  (future) daemon can't collide.
- The GitHub token is resolved from env / `secrets/github-token` / `gh` and is
  **never written into a mirror's git config**.

Not in M1 yet: the daemon (`M2`), ephemeral checkouts + relay push (`M3`), the
interactive TUI (`M4`), and pi integration (`M5`).

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
npm run strappy -- auth --check        # which token would be used?
npm run strappy -- sync                # mirror everything
npm run strappy -- sync owner/repo     # mirror just one
npm run strappy -- list                # list mirrors
npm run strappy -- list --stale        # only stale mirrors
npm run strappy -- list --orphaned     # repos gone from GitHub
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
    working_dir: /repo/source
    entrypoint: /bin/bash -lc 'npm install --no-fund --no-audit && exec npm run --silent strappy -- "$@"' bash
    command: status
```

```bash
docker compose run --rm strappy sync
docker compose run --rm strappy list --stale
docker compose run --rm strappy status
docker compose run --rm strappy auth          # interactive token prompt
```

The args you type after `strappy` replace `command`, and the `entrypoint`
forwards them to the CLI via `"$@"` (the trailing `bash` is `$0`). `--rm`
removes the one-off container on exit; `./backups` is mounted, so mirrors
persist on the host between runs.
