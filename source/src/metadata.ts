/**
 * Repo metadata captured from the GitHub API, in three tiers:
 *
 * - Tier 1 (`RepoMetadata`): comes for free with the repo-list response on
 *   every sync — no extra API calls. The full raw API object is also kept
 *   (`RepoRecord.raw`) as a hedge, so adding a typed field later never
 *   requires re-fetching.
 * - Tier 2 (`RepoEnrichment`): costs extra per-repo calls (languages,
 *   releases, README, …), fetched by `strappy enrich` and refreshed only when
 *   older than `config.enrichmentMaxAgeDays`.
 * - Tier 3 (`RepoTier3Metadata`): sync-time file bodies from `main` that are
 *   useful context for agents. This tier is fetched only for non-archived repos.
 *
 * This module is shared by github.ts (producer) and state.ts (storage shape),
 * and deliberately imports neither.
 */

export interface RepoMetadata {
  name: string;
  owner: string;
  /** "User" or "Organization". */
  ownerType: string;
  description: string | null;
  homepage: string | null;
  htmlUrl: string;
  sshUrl: string | null;
  topics: string[];
  /** Dominant language per GitHub; full byte breakdown lives in enrichment. */
  language: string | null;
  licenseSpdx: string | null;
  visibility: string;
  fork: boolean;
  isTemplate: boolean;
  disabled: boolean;
  /** Remote repo size in KB, as reported by GitHub. */
  remoteSizeKb: number;
  stars: number;
  forks: number;
  watchers: number;
  /** NOTE: GitHub counts open issues AND open PRs in this field. */
  openIssues: number;
  hasIssues: boolean;
  hasWiki: boolean;
  hasPages: boolean;
  hasDiscussions: boolean;
  createdAt: string | null;
  /** Bumped by any metadata change (even stars) — see pushedAt for activity. */
  updatedAt: string | null;
  /** Last actual push — the truthful "is this repo alive?" signal. */
  pushedAt: string | null;
  permissions: { admin: boolean; push: boolean; pull: boolean } | null;
}

/**
 * Tier-2 facets. `null` means "not fetched / fetch failed"; empty array or
 * empty object means "fetched, repo genuinely has none".
 */
export interface RepoEnrichment {
  fetchedAt: string;
  /** Bytes of code per language. */
  languages: Record<string, number> | null;
  latestRelease: {
    tag: string;
    name: string | null;
    publishedAt: string | null;
    prerelease: boolean;
  } | null;
  /** Whether latestRelease=null means "no releases" vs "fetch failed". */
  hasReleases: boolean | null;
  latestCommit: {
    sha: string;
    /** First line of the commit message. */
    message: string;
    author: string | null;
    date: string | null;
  } | null;
  branches: { name: string; protected: boolean }[] | null;
  tags: string[] | null;
  contributors: { login: string; contributions: number }[] | null;
  /** True open-PR count (the Tier-1 openIssues field lumps PRs in). */
  openPrCount: number | null;
  /** Decoded README markdown, truncated to README_MAX_CHARS. */
  readme: string | null;
}

/** READMEs are stored for agent consumption; cap pathological ones. */
export const README_MAX_CHARS = 100_000;

export const TIER3_REF = "main";
export const TIER3_FILE_MAX_CHARS = 200_000;

export interface RepoTier3Metadata {
  fetchedAt: string;
  ref: string;
  readmeMd: string | null;
  agentsMd: string | null;
  composeYml: string | null;
}

/** The subset of the GitHub API repository object we map into RepoMetadata. */
export interface ApiRepo {
  id: number;
  full_name: string;
  name?: string;
  owner?: { login?: string; type?: string } | null;
  description?: string | null;
  homepage?: string | null;
  html_url?: string;
  ssh_url?: string;
  clone_url?: string;
  default_branch?: string;
  visibility?: string;
  private?: boolean;
  archived?: boolean;
  disabled?: boolean;
  fork?: boolean;
  is_template?: boolean;
  language?: string | null;
  license?: { spdx_id?: string | null } | null;
  topics?: string[];
  size?: number;
  stargazers_count?: number;
  forks_count?: number;
  watchers_count?: number;
  open_issues_count?: number;
  has_issues?: boolean;
  has_wiki?: boolean;
  has_pages?: boolean;
  has_discussions?: boolean;
  created_at?: string | null;
  updated_at?: string | null;
  pushed_at?: string | null;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}

export function toRepoMetadata(r: ApiRepo): RepoMetadata {
  const [owner, name] = r.full_name.split("/", 2);
  return {
    name: r.name ?? name ?? r.full_name,
    owner: r.owner?.login ?? owner ?? "",
    ownerType: r.owner?.type ?? "User",
    description: r.description ?? null,
    homepage: r.homepage || null,
    htmlUrl: r.html_url ?? `https://github.com/${r.full_name}`,
    sshUrl: r.ssh_url ?? null,
    topics: r.topics ?? [],
    language: r.language ?? null,
    licenseSpdx: r.license?.spdx_id ?? null,
    visibility: r.visibility ?? (r.private ? "private" : "public"),
    fork: r.fork ?? false,
    isTemplate: r.is_template ?? false,
    disabled: r.disabled ?? false,
    remoteSizeKb: r.size ?? 0,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    watchers: r.watchers_count ?? 0,
    openIssues: r.open_issues_count ?? 0,
    hasIssues: r.has_issues ?? false,
    hasWiki: r.has_wiki ?? false,
    hasPages: r.has_pages ?? false,
    hasDiscussions: r.has_discussions ?? false,
    createdAt: r.created_at ?? null,
    updatedAt: r.updated_at ?? null,
    pushedAt: r.pushed_at ?? null,
    permissions: r.permissions
      ? {
          admin: r.permissions.admin ?? false,
          push: r.permissions.push ?? false,
          pull: r.permissions.pull ?? false,
        }
      : null,
  };
}
