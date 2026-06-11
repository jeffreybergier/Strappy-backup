import { Octokit } from "octokit";
import type { StrappyConfig } from "./config.js";

export interface RemoteRepo {
  fullName: string;
  githubId: number;
  defaultBranch: string;
  archived: boolean;
  private: boolean;
  cloneUrl: string;
  sizeKb: number;
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

function toRemoteRepo(r: {
  full_name: string;
  id: number;
  default_branch?: string;
  archived?: boolean;
  private?: boolean;
  clone_url?: string;
  size?: number;
}): RemoteRepo {
  return {
    fullName: r.full_name,
    githubId: r.id,
    defaultBranch: r.default_branch ?? "main",
    archived: r.archived ?? false,
    private: r.private ?? false,
    cloneUrl: r.clone_url ?? `https://github.com/${r.full_name}.git`,
    sizeKb: r.size ?? 0,
  };
}

function is404(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: number }).status === 404;
}
