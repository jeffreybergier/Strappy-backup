import { resolveToken } from "../auth.js";
import { loadConfig } from "../config.js";
import { openStore } from "../db.js";
import { enrich } from "../enrich.js";
import { Logger } from "../logger.js";
import { getPaths } from "../paths.js";

export interface EnrichCommandOptions {
  force?: boolean;
}

export async function enrichCommand(repos: string[], opts: EnrichCommandOptions): Promise<void> {
  const paths = getPaths();
  const config = await loadConfig(paths);
  const logger = new Logger(paths.logFile, "cli");

  const resolved = await resolveToken(paths);
  if (!resolved) {
    throw new Error(
      "No GitHub token found. Set STRAPPY_GITHUB_TOKEN in .env, or run `strappy auth`.",
    );
  }

  const store = openStore(paths);
  const summary = await enrich({
    store,
    config,
    token: resolved.token,
    logger,
    only: repos.length ? repos : undefined,
    force: opts.force,
  });

  console.log("");
  if (summary.results.length === 0) {
    console.log(
      summary.skipped > 0
        ? `All ${summary.skipped} repo(s) already fresh (within ${config.enrichmentMaxAgeDays}d). Use --force to refetch.`
        : "No repos in inventory. Run `strappy sync` first.",
    );
    return;
  }
  console.log(`Enriched ${summary.ok} repo(s), ${summary.failed} failed, ${summary.skipped} fresh.`);
  for (const r of summary.results.filter((x) => !x.ok)) {
    console.log(`  ✗ ${r.fullName}: ${r.error}`);
  }
  if (summary.failed > 0) process.exitCode = 1;
}
