import pLimit from "p-limit";
import type { StrappyConfig } from "./config.js";
import { fetchEnrichment, makeOctokit } from "./github.js";
import type { Logger } from "./logger.js";
import type { RepoRecord, Store } from "./state.js";

export interface EnrichResult {
  fullName: string;
  ok: boolean;
  error: string | null;
}

export interface EnrichSummary {
  /** Repos whose enrichment was still fresh and therefore skipped. */
  skipped: number;
  results: EnrichResult[];
  ok: number;
  failed: number;
}

export interface EnrichOptions {
  store: Store;
  config: StrappyConfig;
  token: string;
  logger: Logger;
  /** If set, only enrich these repos (by full name or bare name). */
  only?: string[];
  /** Refetch even if the stored enrichment is still fresh. */
  force?: boolean;
}

/**
 * Fetch Tier-2 metadata for every known (non-orphaned) repo whose enrichment
 * is missing or older than config.enrichmentMaxAgeDays. Orphaned repos are
 * skipped — they're gone from GitHub, and their last enrichment is the best
 * record we'll ever have.
 */
export async function enrich(opts: EnrichOptions): Promise<EnrichSummary> {
  const { store, config, token, logger, only, force } = opts;
  const octokit = makeOctokit(token);
  const maxAgeMs = config.enrichmentMaxAgeDays * 24 * 3600_000;

  return store.transaction(async (state, checkpoint) => {
    const candidates = selectTargets(Object.values(state.repos), only).filter((r) => !r.orphaned);
    const targets = force ? candidates : candidates.filter((r) => isStale(r, maxAgeMs));
    const skipped = candidates.length - targets.length;

    logger.info(
      `Enriching ${targets.length} repo(s)` +
        (skipped > 0 ? ` (${skipped} still fresh, use --force to refetch)` : "") +
        "…",
    );

    const limit = pLimit(Math.max(1, config.concurrency));
    const results: EnrichResult[] = [];

    await Promise.all(
      targets.map((record) =>
        limit(async () => {
          try {
            record.enrichment = await fetchEnrichment(octokit, record.fullName, logger);
            logger.info(`Enriched ${record.fullName}`);
            results.push({ fullName: record.fullName, ok: true, error: null });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(`Failed to enrich ${record.fullName}: ${message}`);
            results.push({ fullName: record.fullName, ok: false, error: message });
          }
          await checkpoint(); // flush progress while the lock is still held
        }),
      ),
    );

    const ok = results.filter((r) => r.ok).length;
    return { skipped, results, ok, failed: results.length - ok };
  });
}

function isStale(record: RepoRecord, maxAgeMs: number): boolean {
  if (!record.enrichment) return true;
  const age = Date.now() - Date.parse(record.enrichment.fetchedAt);
  return Number.isNaN(age) || age > maxAgeMs;
}

function selectTargets(records: RepoRecord[], only?: string[]): RepoRecord[] {
  if (!only || only.length === 0) return records;
  const wanted = new Set(only);
  return records.filter(
    (r) => wanted.has(r.fullName) || wanted.has(r.fullName.split("/")[1]),
  );
}
