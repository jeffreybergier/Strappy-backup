import { resolveToken } from "../auth.js";
import { loadConfig } from "../config.js";
import { enrich } from "../enrich.js";
import { humanSize } from "../format.js";
import { openStore } from "../db.js";
import { Logger } from "../logger.js";
import { getPaths } from "../paths.js";
import { sync } from "../sync.js";
import { refreshTier3 } from "../tier3.js";

type SyncReporter = (line?: string) => void;

export interface FullSyncOptions {
  repos?: string[];
  logger?: Logger;
  emit?: SyncReporter;
}

export interface FullSyncResult {
  failed: number;
}

export async function syncCommand(repos: string[]): Promise<void> {
  const result = await runFullSync({ repos });
  if (result.failed > 0) process.exitCode = 1;
}

export async function runFullSync(opts: FullSyncOptions = {}): Promise<FullSyncResult> {
  const repos = opts.repos ?? [];
  const emit = opts.emit ?? ((line = "") => console.log(line));
  const paths = getPaths();
  const config = await loadConfig(paths);
  const logger = opts.logger ?? new Logger(paths.logFile, "cli");

  const resolved = await resolveToken(paths);
  if (!resolved) {
    throw new Error(
      "No GitHub token found. Set STRAPPY_GITHUB_TOKEN in .env, or run `strappy auth`.",
    );
  }

  const store = openStore(paths);
  const summary = await sync({
    store,
    paths,
    config,
    token: resolved.token,
    logger,
    only: repos.length ? repos : undefined,
  });

  emit("");
  emit(
    `Synced ${summary.results.length} repo(s) from an inventory of ${summary.inventoryCount}:`,
  );
  for (const r of summary.results) {
    const tag = r.action === "failed" ? "✗ FAILED" : r.action === "cloned" ? "✓ cloned " : "✓ updated";
    const size = r.action === "failed" ? r.error ?? "" : humanSize(r.sizeKb);
    emit(`  ${tag}  ${r.fullName}  ${size}`);
  }
  if (summary.renamed.length) {
    emit("");
    for (const mv of summary.renamed) emit(`  ↦ renamed ${mv.from} -> ${mv.to}`);
  }
  if (summary.orphaned.length) {
    emit("");
    emit(`  ${summary.orphaned.length} orphaned (gone from GitHub, mirror kept):`);
    for (const name of summary.orphaned) emit(`    • ${name}`);
  }
  emit("");
  emit(`Result: ${summary.ok} ok, ${summary.failed} failed.`);

  emit("");
  emit("Refreshing stale enrichment:");
  const enrichment = await enrich({
    store,
    config,
    token: resolved.token,
    logger,
    only: repos.length ? repos : undefined,
  });

  if (enrichment.results.length === 0) {
    emit(
      enrichment.skipped > 0
        ? `All ${enrichment.skipped} repo(s) already fresh (within ${config.enrichmentMaxAgeDays}d). Use \`strappy enrich --force\` to refetch.`
        : "No repos in inventory.",
    );
  } else {
    emit(
      `Enriched ${enrichment.ok} repo(s), ${enrichment.failed} failed, ${enrichment.skipped} fresh.`,
    );
    for (const r of enrichment.results.filter((x) => !x.ok)) {
      emit(`  ✗ ${r.fullName}: ${r.error}`);
    }
  }

  emit("");
  emit("Refreshing Tier-3 files:");
  const tier3 = await refreshTier3({
    store,
    config,
    token: resolved.token,
    logger,
    only: repos.length ? repos : undefined,
  });

  if (tier3.results.length === 0) {
    const skipped = tier3.skippedArchived + tier3.skippedOrphaned;
    emit(
      skipped > 0
        ? `No active repos to refresh (${tier3.skippedArchived} archived, ${tier3.skippedOrphaned} orphaned skipped).`
        : "No repos in inventory.",
    );
  } else {
    emit(
      `Tier-3 files refreshed for ${tier3.ok} repo(s), ${tier3.failed} failed` +
        `, ${tier3.skippedArchived} archived skipped, ${tier3.skippedOrphaned} orphaned skipped.`,
    );
    for (const r of tier3.results.filter((x) => !x.ok)) {
      emit(`  ✗ ${r.fullName}: ${r.error}`);
    }
  }

  return { failed: summary.failed + enrichment.failed + tier3.failed };
}
