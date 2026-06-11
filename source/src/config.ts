import fs from "node:fs/promises";
import type { Paths } from "./paths.js";

export interface StrappyConfig {
  /** Extra owners/orgs to back up beyond the authenticated user's own repos. */
  owners: string[];
  /** Whether configured `owners` that are orgs should be enumerated as orgs. */
  includeOrgs: boolean;
  /** Cron expression used by the daemon (Milestone 2); stored now for forward-compat. */
  schedule: string;
  /** How many repos to sync in parallel. */
  concurrency: number;
  /** A mirror is considered "stale" once it is older than this many minutes. */
  freshnessMinutes: number;
  /** `strappy enrich` refetches a repo's Tier-2 metadata once it's older than this. */
  enrichmentMaxAgeDays: number;
}

export const DEFAULT_CONFIG: StrappyConfig = {
  owners: [],
  includeOrgs: false,
  schedule: "0 */6 * * *",
  concurrency: 4,
  freshnessMinutes: 6 * 60,
  enrichmentMaxAgeDays: 7,
};

/** Load config.json, filling any missing keys from defaults. Creates the file if absent. */
export async function loadConfig(paths: Paths): Promise<StrappyConfig> {
  let raw: string | null = null;
  try {
    raw = await fs.readFile(paths.config, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  if (raw === null) {
    await saveConfig(paths, DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }

  const parsed = JSON.parse(raw) as Partial<StrappyConfig>;
  return { ...DEFAULT_CONFIG, ...parsed };
}

export async function saveConfig(paths: Paths, config: StrappyConfig): Promise<void> {
  await fs.mkdir(paths.home, { recursive: true });
  await fs.writeFile(paths.config, JSON.stringify(config, null, 2) + "\n", "utf8");
}
