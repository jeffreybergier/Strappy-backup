import fs from "node:fs/promises";
import * as readline from "node:readline";
import { confirm, input, search, select } from "@inquirer/prompts";
import { resolveToken } from "./auth.js";
import {
  checkoutStatus,
  cleanupCheckouts,
  createCheckout,
  resolveCheckoutName,
  resolveCheckoutRoot,
  scanCheckouts,
  unsafeReason,
} from "./checkouts.js";
import { authCheck } from "./commands/auth.js";
import { enrichCommand } from "./commands/enrich.js";
import { infoCommand } from "./commands/info.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";
import { loadConfig, type StrappyConfig } from "./config.js";
import { openStore } from "./db.js";
import { humanSize, timeAgo } from "./format.js";
import { getPaths, type Paths } from "./paths.js";
import type { CheckoutRecord, RepoRecord, StrappyState } from "./state.js";

type MainAction =
  | "dashboard"
  | "sync"
  | "enrich"
  | "checkouts"
  | "audits"
  | "settings"
  | "quit";

type RepoAction =
  | "summary"
  | "info"
  | "sync"
  | "enrich"
  | "github"
  | "checkout";

type SettingsAction = "auth" | "status";
type CheckoutsAction = "create" | "select" | "scan" | "cleanup";
type CheckoutDetailAction = "scan" | "cleanup" | "forceCleanup" | "path";

interface Choice<Value> {
  value: Value;
  name?: string;
  description?: string;
  short?: string;
  disabled?: boolean | string;
}

interface TuiContext {
  paths: Paths;
  config: StrappyConfig;
  checkoutRoot: string;
  state: StrappyState;
  tokenSource: string | null;
}

const ESCAPE_ABORT_REASON = "strappy:escape-back";
const BACK_INSTRUCTIONS = {
  navigation: "↑↓ navigate • ⏎ select • ␛ back",
  pager: "↑↓ navigate • ⏎ select • ␛ back",
};

class BackSignal extends Error {
  override name = "BackSignal";
}

export async function runTui(): Promise<void> {
  try {
    await ensureCheckoutRoot();
    await showDashboard();

    while (true) {
      let action: MainAction;
      try {
        action = await selectPrompt<MainAction>({
          message: "Strappy",
          pageSize: 10,
          choices: [
            { value: "dashboard", name: "Dashboard", description: "Fleet health summary" },
            { value: "sync", name: "Sync now", description: "Refresh GitHub inventory and mirrors" },
            { value: "enrich", name: "Enrich stale repos", description: "Fetch languages, branches, releases, README" },
            { value: "checkouts", name: "Checkouts", description: "Create, scan, and cleanup working copies" },
            { value: "audits", name: "Audits", description: "Planned GitHub posture findings" },
            { value: "settings", name: "Settings", description: "Paths, auth, and config" },
            { value: "quit", name: "Quit" },
          ],
        });
      } catch (err) {
        if (isBackSignal(err)) return;
        throw err;
      }

      if (action === "quit") return;
      if (action === "dashboard") await showDashboard();
      else if (action === "sync") await runCommand("Sync now", () => syncCommand([]));
      else if (action === "enrich") await runCommand("Enrich stale repos", () => enrichCommand([], {}));
      else if (action === "checkouts") await checkoutsView();
      else if (action === "audits") await plannedView("Audits", [
        "This view will store durable findings for branch protection, collaborators, Actions, security, and hygiene.",
        "Next implementation step after checkouts: `strappy audit`, `strappy findings`, and an audit findings table.",
      ]);
      else if (action === "settings") await settingsView();
    }
  } catch (err) {
    if (isPromptExit(err)) return;
    throw err;
  }
}

async function showDashboard(): Promise<void> {
  const ctx = await loadTuiContext();
  const repos = Object.values(ctx.state.repos);
  const failures = repos.filter((r) => r.lastSyncOk === false);
  const orphaned = repos.filter((r) => r.orphaned);
  const checkouts = Object.entries(ctx.state.checkouts);
  const totalKb = repos.reduce((sum, r) => sum + (r.sizeKb ?? 0), 0);

  clear();
  title("STRAPPY");
  console.log(`Checkout root  ${ctx.checkoutRoot}`);
  console.log(`STRAPPY_HOME   ${ctx.paths.home}`);
  console.log(`Token          ${ctx.tokenSource ?? "none - run `strappy auth`"}`);
  console.log(`Last sync      ${timeAgo(ctx.state.lastInventoryAt)}`);
  console.log(`Mirrors        ${repos.length} (${humanSize(totalKb)})`);
  console.log(`Failures       ${failures.length}`);
  console.log(`Orphaned       ${orphaned.length}`);
  console.log(`Checkouts      ${checkouts.length}`);
  console.log("");

  const needsAttention = [
    ctx.tokenSource ? null : "danger  No GitHub token configured",
    failures.length ? `danger  ${failures.length} mirror sync failure(s)` : null,
    orphaned.length ? `warn    ${orphaned.length} orphaned mirror(s) kept locally` : null,
    repos.length === 0 ? "info    No repo inventory yet; run Sync now" : null,
    checkouts.length === 0 ? "info    No registered checkouts yet" : null,
  ].filter((line): line is string => line !== null);

  console.log("Needs Attention");
  if (needsAttention.length === 0) console.log("  none");
  else for (const line of needsAttention) console.log(`  ${line}`);

  if (failures.length) {
    console.log("");
    console.log("Recent Failures");
    for (const repo of failures.slice(0, 5)) {
      console.log(`  ${repo.fullName}: ${repo.lastError ?? "unknown error"}`);
    }
  }

  if (checkouts.length) {
    console.log("");
    console.log("Registered Checkouts");
    for (const [name, checkout] of checkouts.slice(0, 5)) {
      console.log(`  ${name.padEnd(18)} ${checkout.repo.padEnd(32)} ${checkout.branch.padEnd(16)} ${checkout.path}`);
    }
  }

  console.log("");
}

async function repoCheckoutSearchView(): Promise<void> {
  while (true) {
    const ctx = await loadTuiContext();
    const records = Object.values(ctx.state.repos).sort((a, b) => a.fullName.localeCompare(b.fullName));

    clear();
    title("Choose Repo");
    if (records.length === 0) {
      console.log("No repos in inventory. Run Sync now first.");
      await pause();
      return;
    }

    let selection: RepoRecord;
    try {
      selection = await searchPrompt<RepoRecord>({
        message: "Search repos",
        pageSize: 12,
        source: (term) => repoChoices(records, term),
      });
    } catch (err) {
      if (isBackSignal(err)) return;
      throw err;
    }

    const next = await repoActions(selection);
    if (next === "checkoutCreated") return;
  }
}

async function repoActions(repo: RepoRecord): Promise<"search" | "checkoutCreated"> {
  while (true) {
    clear();
    printRepoSummary(repo);
    console.log("");

    let action: RepoAction;
    try {
      action = await selectPrompt<RepoAction>({
        message: "Repo action",
        choices: [
          { value: "summary", name: "Refresh summary" },
          { value: "info", name: "Show full info", description: "`strappy info` output" },
          { value: "sync", name: "Sync this repo" },
          { value: "enrich", name: "Enrich this repo" },
          { value: "github", name: "Show GitHub URL" },
          { value: "checkout", name: "Create checkout" },
        ],
      });
    } catch (err) {
      if (isBackSignal(err)) return "search";
      throw err;
    }

    if (action === "summary") {
      const refreshed = await findRepo(repo.fullName);
      if (refreshed) repo = refreshed;
      continue;
    }
    if (action === "info") await runCommand(`Info: ${repo.fullName}`, () => infoCommand(repo.fullName, {}));
    else if (action === "sync") await runCommand(`Sync: ${repo.fullName}`, () => syncCommand([repo.fullName]));
    else if (action === "enrich") await runCommand(`Enrich: ${repo.fullName}`, () => enrichCommand([repo.fullName], {}));
    else if (action === "checkout") {
      if (await createCheckoutFlow(repo)) return "checkoutCreated";
      continue;
    }
    else if (action === "github") {
      console.log("");
      console.log(repo.metadata?.htmlUrl ?? `https://github.com/${repo.fullName}`);
      await pause();
    }

    const refreshed = await findRepo(repo.fullName);
    if (refreshed) repo = refreshed;
  }
}

async function checkoutsView(): Promise<void> {
  while (true) {
    const ctx = await loadTuiContext();
    const checkouts = Object.entries(ctx.state.checkouts).sort((a, b) => a[0].localeCompare(b[0]));

    clear();
    title("Checkouts");
    console.log(`Root  ${ctx.checkoutRoot}`);
    console.log("");

    if (checkouts.length === 0) {
      console.log("No registered checkouts yet.");
    } else {
      console.log("name               repo                             branch           status                 path");
      for (const [name, checkout] of checkouts) printCheckout(name, checkout);
    }

    console.log("");
    let action: CheckoutsAction;
    try {
      action = await selectPrompt<CheckoutsAction>({
        message: "Checkout action",
        choices: [
          { value: "create", name: "Create checkout", description: "Search repos, inspect details, then clone from mirror" },
          {
            value: "select",
            name: "Select checkout",
            description: "Inspect, scan, or cleanup one checkout",
            disabled: checkouts.length === 0 ? "No registered checkouts" : false,
          },
          {
            value: "scan",
            name: "Scan all",
            description: "Refresh dirty/unpushed status",
            disabled: checkouts.length === 0 ? "No registered checkouts" : false,
          },
          {
            value: "cleanup",
            name: "Cleanup all safe",
            description: "Deletes only checkouts with no dirty or unpushed work",
            disabled: checkouts.length === 0 ? "No registered checkouts" : false,
          },
        ],
      });
    } catch (err) {
      if (isBackSignal(err)) return;
      throw err;
    }

    if (action === "create") await repoCheckoutSearchView();
    else if (action === "scan") await runCommand("Scan checkouts", async () => {
      const store = openStore(getPaths());
      const scanned = await scanCheckouts(store);
      for (const [name, checkout] of Object.entries(scanned)) {
        console.log(`${name}: ${checkoutStatus(checkout)}`);
      }
      if (Object.keys(scanned).length === 0) console.log("No registered checkouts.");
    });
    else if (action === "cleanup") await runCommand("Cleanup safe checkouts", async () => {
      const store = openStore(getPaths());
      const result = await cleanupCheckouts(store, { all: true });
      printCleanupResult(result);
    });
    else if (action === "select") await checkoutDetailFlow();
  }
}

async function settingsView(): Promise<void> {
  while (true) {
    const ctx = await loadTuiContext();

    clear();
    title("Settings");
    console.log(`STRAPPY_HOME       ${ctx.paths.home}`);
    console.log(`Checkout root      ${ctx.checkoutRoot}`);
    console.log(`Config             ${ctx.paths.config}`);
    console.log(`Database           ${ctx.paths.db}`);
    console.log(`Token              ${ctx.tokenSource ?? "none"}`);
    console.log(`Owners             ${ctx.config.owners.length ? ctx.config.owners.join(", ") : "(none)"}`);
    console.log(`Include orgs       ${ctx.config.includeOrgs}`);
    console.log(`Concurrency        ${ctx.config.concurrency}`);
    console.log(`Freshness          ${ctx.config.freshnessMinutes} minutes`);
    console.log(`Enrichment max age ${ctx.config.enrichmentMaxAgeDays} days`);
    console.log(`Schedule           ${ctx.config.schedule}`);
    console.log("");

    let action: SettingsAction;
    try {
      action = await selectPrompt<SettingsAction>({
        message: "Settings action",
        choices: [
          { value: "auth", name: "Check GitHub auth" },
          { value: "status", name: "Print status" },
        ],
      });
    } catch (err) {
      if (isBackSignal(err)) return;
      throw err;
    }

    if (action === "auth") await runCommand("GitHub auth", () => authCheck());
    else if (action === "status") await runCommand("Status", () => statusCommand({}));
  }
}

async function plannedView(name: string, lines: string[]): Promise<void> {
  clear();
  title(name);
  for (const line of lines) console.log(line);
  console.log("");
  await pause();
}

async function runCommand(label: string, fn: () => Promise<void>): Promise<void> {
  clear();
  title(label);
  const priorExitCode = process.exitCode;
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log("");
    console.log(`Error: ${message}`);
  } finally {
    process.exitCode = priorExitCode;
  }
  console.log("");
  await pause();
}

async function loadTuiContext(): Promise<TuiContext> {
  const paths = getPaths();
  const config = await loadConfig(paths);
  const checkoutRoot = resolveCheckoutRoot(paths, config);
  const store = openStore(paths);
  const state = await store.read();
  const resolved = await resolveToken(paths);
  return {
    paths,
    config,
    checkoutRoot,
    state,
    tokenSource: resolved?.source ?? null,
  };
}

async function ensureCheckoutRoot(): Promise<void> {
  const paths = getPaths();
  const config = await loadConfig(paths);
  await fs.mkdir(resolveCheckoutRoot(paths, config), { recursive: true });
}

function repoChoices(records: RepoRecord[], term: string | undefined): Choice<RepoRecord>[] {
  const needle = term?.trim().toLowerCase() ?? "";
  const filtered = needle
    ? records.filter((repo) => repoSearchText(repo).includes(needle))
    : records;

  return filtered.slice(0, 50).map((repo) => ({
    value: repo,
    name: repoListLine(repo),
    description: repo.metadata?.description ?? undefined,
    short: repo.fullName,
  }));
}

function repoListLine(repo: RepoRecord): string {
  const language = repo.metadata?.language ?? "-";
  const pushed = timeAgo(repo.metadata?.pushedAt ?? repo.lastSync);
  const flags = [
    repo.lastSyncOk === false ? "FAIL" : null,
    repo.orphaned ? "orphaned" : null,
    repo.archived ? "archived" : null,
    repo.private ? "private" : null,
  ]
    .filter(Boolean)
    .join(",");
  return `${repo.fullName.padEnd(38)} ${language.padEnd(12)} ${pushed.padStart(8)} ${flags}`;
}

function repoSearchText(repo: RepoRecord): string {
  return [
    repo.fullName,
    repo.metadata?.language,
    repo.metadata?.description,
    repo.metadata?.topics.join(" "),
    repo.metadata?.licenseSpdx,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function printRepoSummary(repo: RepoRecord): void {
  title(repo.fullName);
  const metadata = repo.metadata;
  if (metadata?.description) console.log(metadata.description);
  console.log("");
  console.log(`Mirror       ${repo.lastSyncOk === false ? "failed" : repo.lastSync ? "synced" : "never"} (${timeAgo(repo.lastSync)})`);
  console.log(`Size         ${humanSize(repo.sizeKb)}`);
  console.log(`Visibility   ${metadata?.visibility ?? (repo.private ? "private" : "public")}`);
  console.log(`Default      ${repo.defaultBranch}`);
  console.log(`Language     ${metadata?.language ?? "-"}`);
  console.log(`Last push    ${timeAgo(metadata?.pushedAt ?? null)}`);
  console.log(`Flags        ${repoFlags(repo).join(", ") || "-"}`);
  if (metadata?.topics.length) console.log(`Topics       ${metadata.topics.join(", ")}`);
  if (repo.enrichment) console.log(`Enrichment   fetched ${timeAgo(repo.enrichment.fetchedAt)}`);
  else console.log("Enrichment   none");
}

function repoFlags(repo: RepoRecord): string[] {
  return [
    repo.private ? "private" : null,
    repo.archived ? "archived" : null,
    repo.orphaned ? "orphaned" : null,
    repo.metadata?.fork ? "fork" : null,
    repo.metadata?.isTemplate ? "template" : null,
  ].filter((flag): flag is string => flag !== null);
}

async function findRepo(fullName: string): Promise<RepoRecord | null> {
  const ctx = await loadTuiContext();
  return ctx.state.repos[fullName] ?? null;
}

function printCheckout(name: string, checkout: CheckoutRecord): void {
  const branch = checkout.currentBranch ?? checkout.branch;
  const status = checkoutStatus(checkout);
  console.log(
    `${name.padEnd(18)} ${checkout.repo.padEnd(32)} ${branch.padEnd(16)} ` +
      `${status.padEnd(22)} ${checkout.path}`,
  );
}

async function createCheckoutFlow(repo: RepoRecord): Promise<boolean> {
  let branch: string;
  let name: string;
  try {
    branch = await inputPrompt({
      message: "Branch",
      default: repo.defaultBranch,
    });
    name = await inputPrompt({
      message: "Checkout name (blank for default)",
    });
  } catch (err) {
    if (isBackSignal(err)) return false;
    throw err;
  }

  await runCommand(`Checkout ${repo.fullName}`, async () => {
    const paths = getPaths();
    const config = await loadConfig(paths);
    const store = openStore(paths);
    const result = await createCheckout({
      store,
      paths,
      config,
      repoArg: repo.fullName,
      branch: branch.trim() || undefined,
      name: name.trim() || undefined,
    });
    console.log(`Checked out ${result.record.repo} as ${result.name}`);
    console.log(`Path   ${result.record.path}`);
    console.log(`Branch ${result.record.currentBranch ?? result.record.branch}`);
    console.log(`Origin ${result.record.remoteUrl ?? "local mirror"}`);
    console.log(`Status ${checkoutStatus(result.record)}`);
  });
  return true;
}

async function checkoutDetailFlow(): Promise<void> {
  while (true) {
    const ctx = await loadTuiContext();
    const entries = Object.entries(ctx.state.checkouts).sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length === 0) return;

    let name: string;
    try {
      name = await selectPrompt<string>({
        message: "Select checkout",
        pageSize: 12,
        choices: entries.map(([checkoutName, checkout]) => ({
          value: checkoutName,
          name: `${checkoutName.padEnd(18)} ${checkout.repo.padEnd(32)} ${checkoutStatus(checkout)}`,
          description: checkout.path,
        })),
      });
    } catch (err) {
      if (isBackSignal(err)) return;
      throw err;
    }

    const next = await singleCheckoutActions(name);
    if (next === "done") return;
  }
}

async function singleCheckoutActions(name: string): Promise<"select" | "done"> {
  while (true) {
    const ctx = await loadTuiContext();
    const resolvedName = resolveCheckoutName(ctx.state, name);
    const checkout = ctx.state.checkouts[resolvedName];
    if (!checkout) return "done";

    clear();
    title(resolvedName);
    console.log(`Repo       ${checkout.repo}`);
    console.log(`Path       ${checkout.path}`);
    console.log(`Branch     ${checkout.currentBranch ?? checkout.branch}`);
    console.log(`Origin     ${checkout.remoteUrl ?? "local mirror"}`);
    console.log(`Status     ${checkoutStatus(checkout)}`);
    console.log(`Last scan  ${timeAgo(checkout.lastScan)}`);
    if (checkout.scanError) console.log(`Warning    ${checkout.scanError}`);
    const unsafe = unsafeReason(checkout);
    if (unsafe) console.log(`Cleanup    blocked: ${unsafe}`);
    else console.log("Cleanup    safe");
    console.log("");

    let action: CheckoutDetailAction;
    try {
      action = await selectPrompt<CheckoutDetailAction>({
        message: "Checkout action",
        choices: [
          { value: "scan", name: "Scan" },
          {
            value: "cleanup",
            name: "Cleanup if safe",
            disabled: unsafe ? unsafe : false,
          },
          { value: "forceCleanup", name: "Force cleanup" },
          { value: "path", name: "Show path" },
        ],
      });
    } catch (err) {
      if (isBackSignal(err)) return "select";
      throw err;
    }

    if (action === "path") {
      console.log("");
      console.log(checkout.path);
      await pause();
    } else if (action === "scan") {
      await runCommand(`Scan ${resolvedName}`, async () => {
        const store = openStore(getPaths());
        const scanned = await scanCheckouts(store, [resolvedName]);
        console.log(`${resolvedName}: ${checkoutStatus(scanned[resolvedName])}`);
      });
    } else if (action === "cleanup") {
      await runCommand(`Cleanup ${resolvedName}`, async () => {
        const store = openStore(getPaths());
        printCleanupResult(await cleanupCheckouts(store, { name: resolvedName }));
      });
      return "done";
    } else if (action === "forceCleanup") {
      let ok: boolean;
      try {
        ok = await confirmPrompt({
          message: `Force delete ${resolvedName}? Dirty or unpushed work may be lost.`,
          default: false,
        });
      } catch (err) {
        if (isBackSignal(err)) continue;
        throw err;
      }
      if (ok) {
        await runCommand(`Force cleanup ${resolvedName}`, async () => {
          const store = openStore(getPaths());
          printCleanupResult(await cleanupCheckouts(store, { name: resolvedName, force: true }));
        });
        return "done";
      }
    }
  }
}

function printCleanupResult(result: {
  removed: string[];
  refused: { name: string; reason: string }[];
  missing: string[];
}): void {
  for (const removed of result.removed) console.log(`Removed ${removed}`);
  for (const missing of result.missing) console.log(`Unregistered missing checkout ${missing}`);
  for (const refused of result.refused) console.log(`Refused ${refused.name}: ${refused.reason}`);
  if (!result.removed.length && !result.missing.length && !result.refused.length) {
    console.log("Nothing to clean.");
  }
}

async function pause(message = "Press Enter to continue"): Promise<void> {
  try {
    await inputPrompt({ message });
  } catch (err) {
    if (!isBackSignal(err)) throw err;
  }
}

function clear(): void {
  console.clear();
}

function title(text: string): void {
  console.log(text);
  console.log("-".repeat(Math.max(12, Math.min(80, text.length))));
}

async function selectPrompt<Value>(config: Parameters<typeof select<Value>>[0]): Promise<Value> {
  return withEscapeBack((signal) =>
    select<Value>(
      {
        ...config,
        instructions: config.instructions ?? BACK_INSTRUCTIONS,
      },
      { signal },
    ),
  );
}

async function searchPrompt<Value>(config: Parameters<typeof search<Value>>[0]): Promise<Value> {
  return withEscapeBack((signal) =>
    search<Value>(
      {
        ...config,
        instructions: config.instructions ?? BACK_INSTRUCTIONS,
      },
      { signal },
    ),
  );
}

async function inputPrompt(config: Parameters<typeof input>[0]): Promise<string> {
  return withEscapeBack((signal) => input(config, { signal }));
}

async function confirmPrompt(config: Parameters<typeof confirm>[0]): Promise<boolean> {
  return withEscapeBack((signal) => confirm(config, { signal }));
}

async function withEscapeBack<Value>(fn: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
  const controller = new AbortController();
  const onKeypress = (_char: string, key: KeypressEvent) => {
    if (!controller.signal.aborted && (key.name === "escape" || key.sequence === "\u001b")) {
      controller.abort(ESCAPE_ABORT_REASON);
    }
  };

  readline.emitKeypressEvents(process.stdin);
  process.stdin.on("keypress", onKeypress);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (isEscapeAbort(err)) throw new BackSignal();
    throw err;
  } finally {
    process.stdin.removeListener("keypress", onKeypress);
  }
}

interface KeypressEvent {
  name?: string;
  sequence?: string;
}

function isBackSignal(err: unknown): boolean {
  return err instanceof BackSignal;
}

function isEscapeAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === "AbortPromptError" &&
    (err as Error & { cause?: unknown }).cause === ESCAPE_ABORT_REASON
  );
}

function isPromptExit(err: unknown): boolean {
  return err instanceof Error && err.name === "ExitPromptError";
}
