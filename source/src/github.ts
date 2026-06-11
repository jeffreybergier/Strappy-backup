import { Octokit } from "octokit";
import type { StrappyConfig } from "./config.js";
import type { Logger } from "./logger.js";
import {
  README_MAX_CHARS,
  toRepoMetadata,
  type ApiRepo,
  type RepoEnrichment,
  type RepoMetadata,
} from "./metadata.js";
import { splitFullName } from "./paths.js";

export interface RemoteRepo {
  fullName: string;
  githubId: number;
  defaultBranch: string;
  archived: boolean;
  private: boolean;
  cloneUrl: string;
  sizeKb: number;
  /** Tier-1 metadata, free with the list response. */
  metadata: RepoMetadata;
  /** The full GitHub API repository object, kept verbatim as a hedge. */
  raw: unknown;
}

export function makeOctokit(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: "strappy-backup/0.1" });
}

/** Return login of the authenticated user (used for status / sanity checks). */
export async function whoami(octokit: Octokit): Promise<string> {
  const { data } = await octokit.rest.users.getAuthenticated();
  return data.login;
}

/**
 * Enumerate every repo to back up: the authenticated user's owned repos, plus
 * each owner/org named in config.owners. Archived repos ARE included — they're
 * still worth backing up; they're just flagged.
 */
export async function listRepos(octokit: Octokit, config: StrappyConfig): Promise<RemoteRepo[]> {
  const byId = new Map<number, RemoteRepo>();

  for (const repo of await listAuthedOwned(octokit)) {
    byId.set(repo.githubId, repo);
  }

  for (const owner of config.owners) {
    for (const repo of await listForOwner(octokit, owner, config.includeOrgs)) {
      byId.set(repo.githubId, repo); // de-dupe across sources by GitHub id
    }
  }

  return [...byId.values()];
}

async function listAuthedOwned(octokit: Octokit): Promise<RemoteRepo[]> {
  const repos = await octokit.paginate("GET /user/repos", {
    affiliation: "owner",
    per_page: 100,
  });
  return repos.map(toRemoteRepo);
}

async function listForOwner(
  octokit: Octokit,
  owner: string,
  asOrg: boolean,
): Promise<RemoteRepo[]> {
  if (asOrg) {
    try {
      const repos = await octokit.paginate("GET /orgs/{org}/repos", {
        org: owner,
        type: "all",
        per_page: 100,
      });
      return repos.map(toRemoteRepo);
    } catch (err) {
      // Fall through to the user endpoint if it isn't actually an org.
      if (!is404(err)) throw err;
    }
  }
  const repos = await octokit.paginate("GET /users/{username}/repos", {
    username: owner,
    type: "owner",
    per_page: 100,
  });
  return repos.map(toRemoteRepo);
}

function toRemoteRepo(r: ApiRepo): RemoteRepo {
  return {
    fullName: r.full_name,
    githubId: r.id,
    defaultBranch: r.default_branch ?? "main",
    archived: r.archived ?? false,
    private: r.private ?? false,
    cloneUrl: r.clone_url ?? `https://github.com/${r.full_name}.git`,
    sizeKb: r.size ?? 0,
    metadata: toRepoMetadata(r),
    raw: r,
  };
}

/**
 * Fetch Tier-2 enrichment for one repo (~8 API calls). Each facet fails soft:
 * a 403 on pulls (PAT without Pull-requests scope) or a quirky empty repo
 * must not sink the rest, so failures log a warning and store null.
 */
export async function fetchEnrichment(
  octokit: Octokit,
  fullName: string,
  logger: Logger,
): Promise<RepoEnrichment> {
  const [owner, repo] = splitFullName(fullName);

  const facet = async <T>(label: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`${fullName}: enrichment facet "${label}" failed: ${message}`);
      return null;
    }
  };

  const [languages, release, latestCommit, branches, tags, contributors, openPrCount, readme] =
    await Promise.all([
      facet("languages", async () => {
        const { data } = await octokit.rest.repos.listLanguages({ owner, repo });
        return data as Record<string, number>;
      }),

      facet("latestRelease", async (): Promise<{
        hasReleases: boolean;
        latest: RepoEnrichment["latestRelease"];
      }> => {
        try {
          const { data } = await octokit.rest.repos.getLatestRelease({ owner, repo });
          return {
            hasReleases: true,
            latest: {
              tag: data.tag_name,
              name: data.name ?? null,
              publishedAt: data.published_at ?? null,
              prerelease: data.prerelease,
            },
          };
        } catch (err) {
          if (status(err) === 404) return { hasReleases: false, latest: null };
          throw err;
        }
      }),

      facet("latestCommit", async (): Promise<RepoEnrichment["latestCommit"]> => {
        try {
          const { data } = await octokit.rest.repos.listCommits({ owner, repo, per_page: 1 });
          const c = data[0];
          if (!c) return null;
          return {
            sha: c.sha,
            message: c.commit.message.split("\n", 1)[0],
            author: c.commit.author?.name ?? c.author?.login ?? null,
            date: c.commit.author?.date ?? null,
          };
        } catch (err) {
          if (status(err) === 409) return null; // empty repository
          throw err;
        }
      }),

      facet("branches", async () => {
        const data = await octokit.paginate(octokit.rest.repos.listBranches, {
          owner,
          repo,
          per_page: 100,
        });
        return data.map((b) => ({ name: b.name, protected: b.protected }));
      }),

      facet("tags", async () => {
        const data = await octokit.paginate(octokit.rest.repos.listTags, {
          owner,
          repo,
          per_page: 100,
        });
        return data.map((t) => t.name);
      }),

      facet("contributors", async () => {
        const data = await octokit.paginate(octokit.rest.repos.listContributors, {
          owner,
          repo,
          per_page: 100,
        });
        return data
          .filter((c) => c.login)
          .map((c) => ({ login: c.login as string, contributions: c.contributions }));
      }),

      // Needs Pull-requests read on a fine-grained PAT; fails soft to null.
      facet("openPrCount", async () => {
        const data = await octokit.paginate(octokit.rest.pulls.list, {
          owner,
          repo,
          state: "open",
          per_page: 100,
        });
        return data.length;
      }),

      facet("readme", async () => {
        try {
          const { data } = await octokit.rest.repos.getReadme({ owner, repo });
          const text = Buffer.from(data.content, "base64").toString("utf8");
          return text.length > README_MAX_CHARS
            ? text.slice(0, README_MAX_CHARS) + "\n\n[…truncated by strappy]"
            : text;
        } catch (err) {
          if (status(err) === 404) return null; // no README — not an error
          throw err;
        }
      }),
    ]);

  return {
    fetchedAt: new Date().toISOString(),
    languages,
    latestRelease: release?.latest ?? null,
    hasReleases: release?.hasReleases ?? null,
    latestCommit,
    branches,
    tags,
    contributors,
    openPrCount,
    readme,
  };
}

function status(err: unknown): number | undefined {
  return typeof err === "object" && err !== null
    ? (err as { status?: number }).status
    : undefined;
}

function is404(err: unknown): boolean {
  return status(err) === 404;
}
