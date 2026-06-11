# Strappy-backup — Design

Strappy-backup is an interactive Node.js CLI with one background responsibility:
it keeps bare mirrors of all of your GitHub repositories in a durable location
(`~/.strappy`), and it hands out **ephemeral working copies** of those repos on
demand, cleaning them up later. The goal is that your development area never
becomes precious: no long-lived clones, no credentials at rest in working
copies, no "wait, which laptop has that branch?"

Stretch goal: embed [pi](https://pi.dev) (the `earendil-works/pi` agent
toolkit) so an LLM can answer questions about your fleet of repos and surface
maintenance work.

---

## 1. Core ideas

1. **The mirror store is the source of truth locally.** Every GitHub repo you
   own is mirrored with `git clone --mirror` into `~/.strappy/mirrors/`. A
   mirror clone contains *all* refs (branches, tags, notes, even PR refs if
   fetched), so it is a complete backup — including repos GitHub later deletes
   or you lose access to.

2. **Checkouts are cattle, not pets.** `strappy checkout <repo>` clones from
   the *local mirror* (fast, offline-capable) into a tracked, disposable
   directory. `strappy cleanup` deletes them — refusing if there is unpushed
   work, unless forced.

3. **Credentials live with the daemon, not the dev area.** Only the strappy
   home (`~/.strappy`) holds the GitHub token. Working copies never need it:
   their `origin` is the local mirror, and pushes are relayed upstream by
   strappy, which holds the key. Deleting a checkout leaks nothing.

4. **One binary, two modes.** The same `strappy` executable runs as an
   interactive TUI (default) or as a long-lived daemon (`strappy daemon`)
   that periodically re-syncs all mirrors. They coordinate through the state
   file and a lock — no IPC server needed for v1.

---

## 2. On-disk layout

```
~/.strappy/                      # STRAPPY_HOME (overridable via env)
├── config.json                  # owners/orgs to back up, schedule, options
├── state.json                   # repo inventory, sync results, checkout registry
├── secrets/
│   └── github-token             # fine-grained PAT, chmod 600
├── mirrors/
│   └── <owner>/<repo>.git/      # bare mirror clones
├── checkouts/
│   └── <name>/                  # ephemeral working copies (default location)
└── logs/
    └── strappy.log              # rotating daemon + CLI log
```

Notes:

- `STRAPPY_HOME` defaults to `~/.strappy` but is an env var because in the
  compose container `~/.strappy` (host) is mounted at `/root` — so inside the
  container `STRAPPY_HOME=/root` does the right thing.
- `state.json` is fine for v1 (tens-to-hundreds of repos). If it grows or we
  want history (sync runs over time, size trends), upgrade to SQLite
  (`better-sqlite3`) behind the same store interface.
- Checkouts *may* be created outside `checkouts/` (e.g. `~/dev/foo`); they are
  still registered in `state.json` so cleanup can find them.

### state.json shape (sketch)

```jsonc
{
  "repos": {
    "jeffburg/widget": {
      "githubId": 123,
      "defaultBranch": "main",
      "archived": false,
      "orphaned": false,          // true if gone from GitHub; mirror is KEPT
      "lastSync": "2026-06-11T02:00:11Z",
      "lastSyncOk": true,
      "lastError": null,
      "sizeKb": 4812
    }
  },
  "checkouts": {
    "widget": {
      "repo": "jeffburg/widget",
      "path": "/root/checkouts/widget",
      "createdAt": "2026-06-10T09:00:00Z",
      "branch": "main"
    }
  },
  "lastInventoryAt": "2026-06-11T02:00:00Z"
}
```

---

## 3. Goal 1 — Backup all GitHub repositories

### Inventory

- Enumerate repos with Octokit: `GET /user/repos?affiliation=owner` (paginated),
  plus optional extra owners/orgs from `config.json`.
- Auth: a **fine-grained PAT** with read-only `contents` + `metadata` scope,
  stored at `~/.strappy/secrets/github-token`. (Pushing via the relay needs
  read/write `contents`; see §4.) Bootstrap: `strappy auth` prompts for the
  token, or imports from `gh auth token` if the GitHub CLI is present.

### Sync algorithm (per repo)

```
if mirrors/<owner>/<repo>.git missing:
    git clone --mirror <url> mirrors/<owner>/<repo>.git
else:
    git -C <mirror> remote update --prune
record result + timestamp in state.json
```

- `--mirror` implies `+refs/*:refs/*` and prune semantics — the mirror tracks
  upstream exactly, including deletions of branches. That is correct for a
  *mirror*; point-in-time protection comes from your separate backup of
  `~/.strappy` itself (Time Machine, restic, etc. — out of scope but assumed).
- Repos that disappear from the GitHub inventory are marked `orphaned: true`
  and their mirrors are **never deleted automatically** — this is a backup
  tool; deletion is an explicit `strappy forget <repo>`.
- Renames/transfers: detect via `githubId`, move the mirror directory, keep
  history in state.
- Concurrency: sync N repos in parallel (default 4) with a small queue.
- Each run is guarded by a lock file (`proper-lockfile` on `state.json`) so a
  manual "Sync now" in the TUI and the daemon's scheduled run can't collide.

### The background responsibility

`strappy daemon` is a long-running process:

- Internal scheduler (`node-cron`), default `0 */6 * * *` (every 6h),
  configurable in `config.json`.
- On each tick: refresh inventory → sync all mirrors → update state → log.
- Deployment is just another compose service (see §7), `restart: unless-stopped`.
- The interactive CLI reads `state.json` to show freshness ("last synced 2h
  ago ✓ / 3 failures ✗") and can run a sync inline at any time — the lock
  makes daemon-vs-CLI safe, so no socket/IPC is needed in v1.

---

## 4. Goal 2 — Ephemeral checkouts

### Checkout

```
strappy checkout jeffburg/widget [--dir ~/dev/widget] [--branch main]
```

1. Ensure the mirror is fresh (fetch if older than a threshold and online).
2. `git clone <mirror-path> <dir>` — local clone, near-instant, works offline.
3. `origin` is the **local mirror**, not GitHub. The working copy never sees
   a GitHub URL or credential.
4. Register the checkout in `state.json`.

### Pushing without keys in the dev area

This is the interesting part. Two supported flows:

**A. Relay push (the strappy way, default).**
You commit and `git push origin my-branch` — which lands in the *mirror*.
Then `strappy push jeffburg/widget my-branch` (or the TUI "push" action, or
the daemon noticing `refs/strappy/outbox/*`) pushes that ref from the mirror
to GitHub using the daemon-held token:

```
git -C <mirror> push github <sha>:refs/heads/my-branch
```

Safety: the relay only pushes explicitly named refs — never `--mirror` push,
which could propagate a local mistake (e.g. a deleted branch) upstream.
The next mirror sync then confirms the ref round-tripped.

**B. Direct push (escape hatch).** `strappy checkout --direct` sets `origin`
to the GitHub URL and relies on whatever ambient credential helper exists.
Useful on a trusted host; defeats the ephemerality discipline, so it's opt-in.

### Cleanup

```
strappy cleanup widget          # one checkout
strappy cleanup --all
strappy cleanup --older-than 14d
```

Before deleting, strappy refuses (without `--force`) if:

- the working tree is dirty (`git status --porcelain` non-empty), or
- any local branch has commits not present in the mirror
  (`git log --branches --not --remotes` non-empty).

The TUI shows each checkout's age and dirty/unpushed status so cleanup is a
one-keystroke decision. Optionally the daemon flags (never auto-deletes)
checkouts older than a configured age.

---

## 5. Goal 3 (stretch) — pi.dev integration

[pi](https://github.com/earendil-works/pi) is an MIT-licensed agent toolkit:
a unified multi-provider LLM API, an agent loop, and TUI components, all as
TypeScript packages. Strappy embeds the **agent loop with custom tools** —
the LLM never edits code; it gets read-mostly tools over strappy's own data:

| Tool             | Backed by                                              |
|------------------|--------------------------------------------------------|
| `list_repos`     | state.json inventory (+ filters: language, archived…)  |
| `repo_activity`  | `git log` against the local mirror (no API calls)      |
| `repo_health`    | GitHub API: open issues/PRs, Dependabot alerts, CI runs|
| `read_file`      | `git show` from the mirror (read a file at any ref)    |
| `sync_status`    | last sync results, failures, orphans                   |

Surfaces:

- `strappy ask "which of my repos still use Node 16?"` — one-shot agent run.
- An "Ask" pane in the interactive TUI (pi ships TUI components we can reuse).
- **Daemon digest**: a scheduled agent run that reviews `repo_health` across
  the fleet and writes a maintenance digest ("3 repos have Dependabot alerts,
  `widget` CI has been red for 9 days") to the TUI dashboard, and optionally
  email/ntfy.

Because pi is provider-agnostic (Anthropic, OpenAI, Google, local models…),
the LLM key is one more secret that lives in `~/.strappy/secrets/` — same
discipline as the GitHub token. The agent's GitHub-touching tools are built
on strappy's existing Octokit client, read-only by construction.

---

## 6. CLI surface

```
strappy                       # interactive TUI (dashboard) — the default
strappy daemon                # background sync loop (compose service)
strappy auth                  # store/refresh the GitHub token
strappy sync [repo…]          # sync now (all, or named repos)
strappy list [--stale|--orphaned]
strappy checkout <repo> [--dir D] [--branch B] [--direct]
strappy push <repo> <ref>     # relay a ref from mirror → GitHub
strappy cleanup [name|--all|--older-than AGE] [--force]
strappy forget <repo>         # explicit mirror deletion (the only one)
strappy ask "<question>"      # pi-powered fleet question (stretch)
strappy status                # one-line health for scripts/prompt
```

Interactive dashboard (default command) sketch:

```
 STRAPPY  last sync 2h ago · 47 mirrors · 2 checkouts · 1 failure
─────────────────────────────────────────────────────────────────
 › Repos        browse/search mirrors, sync one, checkout
   Checkouts    age, dirty?, unpushed? — push / clean up
   Sync now
   Digest       latest pi maintenance digest        (stretch)
   Ask          free-form question about your repos (stretch)
```

---

## 7. Technology choices

| Concern        | Choice                          | Why                                                            |
|----------------|---------------------------------|----------------------------------------------------------------|
| Runtime        | Node.js ≥ 22 + TypeScript       | User preference; pi SDK is TypeScript; single language end-to-end |
| Subcommands    | `commander`                     | Boring, ubiquitous                                              |
| Interactive UI | `@inquirer/prompts` for v1      | Menu/list/confirm flows cover the dashboard; upgrade path: pi's TUI package or Ink if we want live panes |
| Git operations | spawn `git` via `execa`         | Mirrors/relay pushes are plumbing-level; shelling out is more debuggable than libgit bindings and matches what you'd run by hand |
| GitHub API     | `octokit`                       | Pagination, fine-grained PAT support                            |
| Scheduling     | `node-cron` inside the daemon   | No host crontab dependency; works in a container                |
| Locking        | `proper-lockfile`               | CLI and daemon share state safely without IPC                   |
| State          | JSON file v1 → `better-sqlite3` | Start simple; swap behind a store interface                     |
| LLM (stretch)  | `pi` packages (agent + ai)      | Provider-agnostic, embeddable loop, custom tools                |

### Compose integration

```yaml
  strappy-daemon:
    build: .
    command: ["strappy", "daemon"]
    environment:
      - STRAPPY_HOME=/root
    volumes:
      - ~/.strappy:/root
    restart: unless-stopped
```

The existing `altivec-intelligence` service already mounts `~/.strappy:/root`,
so the interactive `strappy` run inside that container sees the same mirrors,
state, and secrets as the daemon.

---

## 8. Milestones

1. **M1 — Mirror engine**: config, auth, inventory, sync, `strappy sync/list/status`, lockfile. (The backup is real after this milestone.)
2. **M2 — Daemon**: `strappy daemon` + compose service, scheduled sync, logging, failure surfacing.
3. **M3 — Ephemeral checkouts**: checkout/cleanup with safety checks, checkout registry, relay push.
4. **M4 — Interactive TUI**: dashboard wrapping M1–M3.
5. **M5 (stretch) — pi**: tools, `strappy ask`, daemon digest.

## 9. Open questions

- Relay push (A) as default — comfortable with the extra `strappy push` step,
  or should the daemon auto-relay an outbox ref pattern from day one?
- Should orgs you're a member of (not owner) be backed up by default, or
  opt-in per org in `config.json`?
- Digest delivery for the stretch goal: TUI-only, or also email/ntfy push?
