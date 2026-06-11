import { resolveToken } from "../auth.js";
import { loadConfig } from "../config.js";
import { openStore } from "../db.js";
import { humanSize, timeAgo } from "../format.js";
import { getPaths } from "../paths.js";

export interface StatusOptions {
  /** Emit a single machine-readable line (for shell prompts / scripts). */
  oneline?: boolean;
}

export async function statusCommand(opts: StatusOptions): Promise<void> {
  const paths = getPaths();
  const config = await loadConfig(paths);
  const store = openStore(paths);
  const state = await store.read();
  const resolved = await resolveToken(paths);

  const repos = Object.values(state.repos);
  const failures = repos.filter((r) => r.lastSyncOk === false).length;
  const orphaned = repos.filter((r) => r.orphaned).length;
  const totalKb = repos.reduce((sum, r) => sum + (r.sizeKb ?? 0), 0);

  if (opts.oneline) {
    const token = resolved ? "auth✓" : "auth✗";
    console.log(
      `strappy: ${repos.length} mirrors · last ${timeAgo(state.lastInventoryAt)} · ` +
        `${failures} fail · ${orphaned} orphan · ${token}`,
    );
    return;
  }

  console.log(`STRAPPY_HOME   ${paths.home}`);
  console.log(`Token          ${resolved ? `✓ (${resolved.source})` : "✗ none — run `strappy auth`"}`);
  console.log(`Last inventory ${timeAgo(state.lastInventoryAt)}`);
  console.log(`Mirrors        ${repos.length}  (${humanSize(totalKb)})`);
  console.log(`Failures       ${failures}`);
  console.log(`Orphaned       ${orphaned}`);
  console.log(`Checkouts      ${Object.keys(state.checkouts).length}  (Milestone 3)`);
  console.log(`Concurrency    ${config.concurrency}   Schedule ${config.schedule}`);

  if (failures > 0) {
    console.log("\nFailures:");
    for (const r of repos.filter((x) => x.lastSyncOk === false)) {
      console.log(`  ✗ ${r.fullName}: ${r.lastError ?? "unknown error"}`);
    }
  }
}
