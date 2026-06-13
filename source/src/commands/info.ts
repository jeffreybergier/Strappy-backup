import { openStore } from "../db.js";
import { humanSize, timeAgo } from "../format.js";
import { getPaths } from "../paths.js";
import type { RepoRecord } from "../state.js";

export interface InfoOptions {
  /** Dump the record as JSON (the agent-friendly view). */
  json?: boolean;
  /** Include the verbatim GitHub API object and full file bodies in --json. */
  full?: boolean;
}

export async function infoCommand(repoArg: string, opts: InfoOptions): Promise<void> {
  const paths = getPaths();
  const store = openStore(paths);
  const state = await store.read();

  const record = findRepo(Object.values(state.repos), repoArg);
  if (!record) {
    throw new Error(`Unknown repo "${repoArg}". Run \`strappy list\` to see the inventory.`);
  }

  if (opts.json) {
    const { raw, enrichment, tier3, ...rest } = record;
    const out = opts.full
      ? record
      : {
          ...rest,
          enrichment: enrichment
            ? { ...enrichment, readme: elideBody(enrichment.readme) }
            : null,
          tier3: tier3
            ? {
                ...tier3,
                readmeMd: elideBody(tier3.readmeMd),
                agentsMd: elideBody(tier3.agentsMd),
                composeYml: elideBody(tier3.composeYml),
              }
            : null,
        };
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  printHuman(record);
}

function findRepo(records: RepoRecord[], arg: string): RepoRecord | undefined {
  return (
    records.find((r) => r.fullName === arg) ??
    records.find((r) => r.fullName.split("/")[1] === arg)
  );
}

function printHuman(r: RepoRecord): void {
  const m = r.metadata;
  console.log(`${r.fullName}  (github id ${r.githubId})`);
  if (m?.description) console.log(`  ${m.description}`);

  const line2 = [
    m?.visibility ?? (r.private ? "private" : "public"),
    r.archived ? "archived" : null,
    r.orphaned ? "ORPHANED" : null,
    m?.fork ? "fork" : null,
    m?.language,
    m?.licenseSpdx && m.licenseSpdx !== "NOASSERTION" ? m.licenseSpdx : null,
    m ? `${m.stars}★ ${m.forks}⑂` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  console.log(`  ${line2}`);

  if (m) {
    console.log(
      `  created ${day(m.createdAt)} · last push ${day(m.pushedAt)} · ` +
        `${m.openIssues} open issues+PRs · remote ${humanSize(m.remoteSizeKb)}`,
    );
    if (m.topics.length) console.log(`  topics: ${m.topics.join(", ")}`);
    if (m.homepage) console.log(`  homepage: ${m.homepage}`);
  }

  const sync = r.lastSyncOk === false ? `✗ FAILED (${r.lastError})` : r.lastSync ? "✓" : "never";
  console.log(`  mirror: ${sync} synced ${timeAgo(r.lastSync)} (${humanSize(r.sizeKb)})`);

  const e = r.enrichment;
  if (!e) {
    console.log(`  enrichment: none — run \`strappy enrich ${r.fullName}\``);
  } else {
    console.log(`  enrichment (fetched ${timeAgo(e.fetchedAt)}):`);
    if (e.languages && Object.keys(e.languages).length) {
      const total = Object.values(e.languages).reduce((a, b) => a + b, 0);
      const top = Object.entries(e.languages)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([lang, bytes]) => `${lang} ${Math.round((bytes / total) * 100)}%`)
        .join(", ");
      console.log(`    languages: ${top}`);
    }
    if (e.latestRelease) {
      console.log(
        `    latest release: ${e.latestRelease.tag}${e.latestRelease.prerelease ? " (pre)" : ""} · ${day(e.latestRelease.publishedAt)}`,
      );
    } else if (e.hasReleases === false) {
      console.log(`    latest release: none`);
    }
    if (e.latestCommit) {
      console.log(
        `    latest commit: ${e.latestCommit.sha.slice(0, 7)} "${e.latestCommit.message}" ` +
          `by ${e.latestCommit.author ?? "?"} · ${day(e.latestCommit.date)}`,
      );
    }
    if (e.branches) {
      const names = e.branches.map((b) => b.name + (b.protected ? "🔒" : ""));
      console.log(
        `    branches: ${e.branches.length} (${names.slice(0, 8).join(", ")}${names.length > 8 ? ", …" : ""})`,
      );
    }
    if (e.tags) console.log(`    tags: ${e.tags.length}`);
    if (e.contributors) {
      const top = e.contributors
        .slice(0, 5)
        .map((c) => `${c.login} (${c.contributions})`)
        .join(", ");
      console.log(`    contributors: ${top}${e.contributors.length > 5 ? ", …" : ""}`);
    }
    if (e.openPrCount !== null) console.log(`    open PRs: ${e.openPrCount}`);
    console.log(
      e.readme
        ? `    readme: ${(e.readme.length / 1024).toFixed(1)} KiB stored`
        : `    readme: none`,
    );
  }

  const t = r.tier3;
  if (!t) {
    console.log(`  tier 3 files: none — run \`strappy sync ${r.fullName}\``);
    return;
  }

  console.log(`  tier 3 files (fetched ${timeAgo(t.fetchedAt)} from ${t.ref}):`);
  console.log(`    README.md: ${bodySize(t.readmeMd)}`);
  console.log(`    AGENTS.md: ${bodySize(t.agentsMd)}`);
  console.log(`    compose.yml: ${bodySize(t.composeYml)}`);
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "?";
}

function elideBody(body: string | null): string | null {
  return body ? `[${body.length} chars — use --full]` : null;
}

function bodySize(body: string | null): string {
  return body ? `${(body.length / 1024).toFixed(1)} KiB stored` : "none";
}
