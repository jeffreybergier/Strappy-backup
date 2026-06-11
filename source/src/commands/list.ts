import { loadConfig } from "../config.js";
import { humanSize, timeAgo } from "../format.js";
import { getPaths } from "../paths.js";
import { JsonStore, type RepoRecord } from "../state.js";

export interface ListOptions {
  stale?: boolean;
  orphaned?: boolean;
}

export async function listCommand(opts: ListOptions): Promise<void> {
  const paths = getPaths();
  const config = await loadConfig(paths);
  const store = new JsonStore(paths);
  const state = await store.read();

  let records = Object.values(state.repos).sort((a, b) => a.fullName.localeCompare(b.fullName));

  if (opts.orphaned) records = records.filter((r) => r.orphaned);
  if (opts.stale) records = records.filter((r) => isStale(r, config.freshnessMinutes));

  if (records.length === 0) {
    console.log("No repos match. Run `strappy sync` to build the inventory.");
    return;
  }

  const nameWidth = Math.min(48, Math.max(...records.map((r) => r.fullName.length)));
  for (const r of records) {
    const flags = [
      r.lastSyncOk === false ? "FAIL" : null,
      r.orphaned ? "orphaned" : null,
      r.archived ? "archived" : null,
      r.private ? "private" : null,
      isStale(r, config.freshnessMinutes) ? "stale" : null,
    ]
      .filter(Boolean)
      .join(",");
    const status = r.lastSyncOk === false ? "✗" : r.lastSync ? "✓" : "·";
    console.log(
      `${status} ${r.fullName.padEnd(nameWidth)}  ${humanSize(r.sizeKb).padStart(9)}  ` +
        `${timeAgo(r.lastSync).padStart(9)}  ${flags}`,
    );
  }
  console.log(`\n${records.length} repo(s).`);
}

function isStale(r: RepoRecord, freshnessMinutes: number): boolean {
  if (!r.lastSync) return true;
  const ageMs = Date.now() - Date.parse(r.lastSync);
  return ageMs > freshnessMinutes * 60_000;
}
