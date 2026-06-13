import { checkoutBranch, resolveCheckoutName, scanCheckouts } from "../checkouts.js";
import { openStore } from "../db.js";
import { getPaths } from "../paths.js";

export interface ScanCheckoutsCommandOptions {
  all?: boolean;
}

export async function scanCheckoutsCommand(
  names: string[],
  opts: ScanCheckoutsCommandOptions,
): Promise<void> {
  const paths = getPaths();
  const store = openStore(paths);
  const state = await store.read();
  const selected = opts.all || names.length === 0 ? undefined : names.map((name) => resolveCheckoutName(state, name));
  const scanned = await scanCheckouts(store, selected);

  const entries = Object.entries(scanned).sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) {
    console.log("No registered checkouts to scan.");
    return;
  }

  console.log("name                 branch           status");
  for (const [name, checkout] of entries) {
    const status = checkout.scanError
      ? `warning: ${checkout.scanError}`
      : checkout.exists === false
        ? "missing"
        : checkout.dirty
          ? "dirty"
          : (checkout.ahead ?? 0) > 0
            ? `${checkout.ahead} unpushed`
            : "clean";
    console.log(`${name.padEnd(20)} ${checkoutBranch(checkout).padEnd(16)} ${status}`);
  }
}
