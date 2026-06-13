import {
  checkoutBranch,
  checkoutStatus,
  scanCheckouts,
} from "../checkouts.js";
import { openStore } from "../db.js";
import { timeAgo } from "../format.js";
import { getPaths } from "../paths.js";
import type { CheckoutRecord } from "../state.js";

export interface CheckoutsCommandOptions {
  dirty?: boolean;
  unpushed?: boolean;
  json?: boolean;
}

export async function checkoutsCommand(opts: CheckoutsCommandOptions): Promise<void> {
  const paths = getPaths();
  const store = openStore(paths);
  const scanned = await scanCheckouts(store);
  let entries = Object.entries(scanned).sort((a, b) => a[0].localeCompare(b[0]));

  if (opts.dirty) entries = entries.filter(([, c]) => c.dirty === true);
  if (opts.unpushed) entries = entries.filter(([, c]) => (c.ahead ?? 0) > 0);

  if (opts.json) {
    console.log(JSON.stringify(Object.fromEntries(entries), null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log("No checkouts match.");
    return;
  }

  console.log("name                 repo                              branch           status                 path");
  for (const [name, checkout] of entries) printCheckout(name, checkout);
  console.log(`\n${entries.length} checkout(s).`);
}

function printCheckout(name: string, checkout: CheckoutRecord): void {
  const branch = checkoutBranch(checkout);
  const status = checkoutStatus(checkout);
  const scanned = checkout.lastScan ? `scan ${timeAgo(checkout.lastScan)}` : "never scanned";
  console.log(
    `${name.padEnd(20)} ${checkout.repo.padEnd(33)} ${branch.padEnd(16)} ` +
      `${status.padEnd(22)} ${checkout.path} (${scanned})`,
  );
}
