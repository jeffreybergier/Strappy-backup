import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import * as readline from "node:readline";
import { confirm, input, search, select, Separator } from "@inquirer/prompts";
import { execa } from "execa";
import { resolveToken, type ResolvedToken, type TokenSource } from "./auth.js";
import {
  checkoutStatus,
  cleanupCheckouts,
  createCheckout,
  resolveCheckoutName,
  resolveCheckoutRoot,
  scanCheckouts,
  unsafeReason,
} from "./checkouts.js";
import { syncCommand } from "./commands/sync.js";
import { loadConfig, type StrappyConfig } from "./config.js";
import { openStore } from "./db.js";
import { humanSize, timeAgo } from "./format.js";
import { makeOctokit, whoami } from "./github.js";
import { getPaths, splitFullName, type Paths } from "./paths.js";
import type { CheckoutRecord, RepoRecord, StrappyState } from "./state.js";

type MainAction =
  | "sync"
  | "audit"
  | "checkout"
  | `checkout:${string}`;

type AuditAction =
  | "no-readme"
  | "no-agents"
  | "no-compose"
  | "compose-no-altivec"
  | "main-unprotected"
  | "default-branch-not-main";

type CheckoutWorkAction = "diff" | "commit" | "push";

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
  auth: AuthDashboardStatus;
}

interface AuthDashboardStatus {
  label: string;
  detail?: string;
  attention?: string;
}

interface AuditDefinition {
  action: AuditAction;
  name: string;
  description: string;
  empty: string;
  isKnown: (repo: RepoRecord) => boolean;
  unknownLabel: string;
  refreshHint: string;
  matches: (repo: RepoRecord) => boolean;
}

const ESCAPE_ABORT_REASON = "strappy:escape-back";
const DASHBOARD_REFRESH_ABORT_REASON = "strappy:dashboard-refresh";
const DASHBOARD_REFRESH_MS = 60_000;
const AUTH_STATUS_CACHE_MS = 5 * 60_000;
const AUTH_STATUS_TIMEOUT_MS = 2_500;
const ALTIVEC_INTELLIGENCE_IMAGE = "ghcr.io/jeffreybergier/altivec-intelligence";
const AUDITS: readonly AuditDefinition[] = [
  {
    action: "no-readme",
    name: "Repos with no README.md",
    description: "Missing README.md in the Tier-3 file snapshot",
    empty: "Every repo with Tier-3 data has a README.md.",
    isKnown: hasTier3Data,
    unknownLabel: "without Tier-3 file data",
    refreshHint: "Run Sync to fetch README.md, AGENTS.md, and compose.yml for active repos.",
    matches: (repo) => repo.tier3?.readmeMd === null,
  },
  {
    action: "no-agents",
    name: "Repos with no AGENTS.md",
    description: "Missing AGENTS.md in the Tier-3 file snapshot",
    empty: "Every repo with Tier-3 data has an AGENTS.md.",
    isKnown: hasTier3Data,
    unknownLabel: "without Tier-3 file data",
    refreshHint: "Run Sync to fetch README.md, AGENTS.md, and compose.yml for active repos.",
    matches: (repo) => repo.tier3?.agentsMd === null,
  },
  {
    action: "no-compose",
    name: "Repos with no compose file",
    description: "Missing compose.yml in the Tier-3 file snapshot",
    empty: "Every repo with Tier-3 data has a compose.yml.",
    isKnown: hasTier3Data,
    unknownLabel: "without Tier-3 file data",
    refreshHint: "Run Sync to fetch README.md, AGENTS.md, and compose.yml for active repos.",
    matches: (repo) => repo.tier3?.composeYml === null,
  },
  {
    action: "compose-no-altivec",
    name: "Compose files without altivec-intelligence",
    description: `compose.yml exists but does not reference ${ALTIVEC_INTELLIGENCE_IMAGE}`,
    empty: "Every stored compose.yml references altivec-intelligence.",
    isKnown: hasTier3Data,
    unknownLabel: "without Tier-3 file data",
    refreshHint: "Run Sync to fetch README.md, AGENTS.md, and compose.yml for active repos.",
    matches: (repo) =>
      repo.tier3?.composeYml !== null &&
      repo.tier3?.composeYml !== undefined &&
      !repo.tier3.composeYml.includes(ALTIVEC_INTELLIGENCE_IMAGE),
  },
  {
    action: "main-unprotected",
    name: "Repos without main branch protection",
    description: "Branch metadata exists, but main is missing or not protected",
    empty: "Every repo with branch metadata has a protected main branch.",
    isKnown: hasBranchData,
    unknownLabel: "without branch metadata",
    refreshHint: "Run Sync or Enrich to fetch branch metadata for active repos.",
    matches: (repo) => mainBranch(repo)?.protected !== true,
  },
  {
    action: "default-branch-not-main",
    name: "Repos whose default branch is not main",
    description: "Inventory default branch is not named main",
    empty: "Every active repo uses main as its default branch.",
    isKnown: hasInventoryData,
    unknownLabel: "without inventory data",
    refreshHint: "Run Sync to refresh repo inventory.",
    matches: (repo) => repo.defaultBranch !== "main",
  },
];
const MENU_PROMPT_THEME = {
  prefix: "",
  style: {
    disabled: (text: string) => color.dim(`  ${text}`),
  },
};
const BACK_INSTRUCTIONS = {
  navigation: "↑↓ navigate • ⏎ select • ␛ back",
  pager: "↑↓ navigate • ⏎ select • ␛ back",
};
let authStatusCache: { key: string; checkedAt: number; status: AuthDashboardStatus } | null = null;

class BackSignal extends Error {
  override name = "BackSignal";
}

class DashboardRefreshSignal extends Error {
  override name = "DashboardRefreshSignal";
}

class TimeoutError extends Error {
  override name = "TimeoutError";
}

export async function runTui(): Promise<void> {
  try {
    await ensureCheckoutRoot();

    while (true) {
      await showDashboard();
      const checkouts = await scanCheckoutEntries();

      let action: MainAction;
      try {
        action = await selectPrompt<MainAction>({
          message: "Menu",
          pageSize: menuPageSize(),
          choices: mainMenuChoices(checkouts),
        }, { refreshMs: DASHBOARD_REFRESH_MS });
      } catch (err) {
        if (isDashboardRefreshSignal(err)) continue;
        if (isBackSignal(err)) return;
        throw err;
      }

      if (action === "sync") await runCommand("Sync", () => syncCommand([]));
      else if (action === "audit") await auditMenu();
      else if (action === "checkout") await repoCheckoutSearchView();
      else if (action.startsWith("checkout:")) await handleCheckoutSelection(action.slice("checkout:".length));
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
  console.log(color.bold("STRAPPY"));
  console.log(color.dim(`Live fleet dashboard • refreshed ${clock(new Date())} • auto ${DASHBOARD_REFRESH_MS / 1000}s`));
  console.log(rule());
  dashboardRow("Mirrors", `${repos.length} (${humanSize(totalKb)})`);
  dashboardRow("Last sync", timeAgo(ctx.state.lastInventoryAt));
  dashboardRow("Checkouts", String(checkouts.length));
  dashboardRow("Auth", authSummary(ctx.auth));
  dashboardRow("Failures", String(failures.length));
  dashboardRow("Orphaned", String(orphaned.length));
  console.log("");
  console.log(color.dim(`Checkout root  ${ctx.checkoutRoot}`));
  console.log(color.dim(`STRAPPY_HOME   ${ctx.paths.home}`));
  console.log("");

  const needsAttention = [
    ctx.auth.attention ?? null,
    failures.length ? `danger  ${failures.length} mirror sync failure(s)` : null,
    orphaned.length ? `warn    ${orphaned.length} orphaned mirror(s) kept locally` : null,
    repos.length === 0 ? "info    No repo inventory yet; run Sync" : null,
    checkouts.length === 0 ? "info    No checkouts yet" : null,
  ].filter((line): line is string => line !== null);

  section("Needs Attention");
  if (needsAttention.length === 0) console.log("  none");
  else for (const line of needsAttention) console.log(`  ${attentionLine(line)}`);

  if (failures.length) {
    console.log("");
    section("Recent Failures");
    for (const repo of failures.slice(0, 5)) {
      console.log(`  ${repo.fullName}: ${repo.lastError ?? "unknown error"}`);
    }
  }

  console.log("");
}

async function repoCheckoutSearchView(): Promise<void> {
  while (true) {
    const ctx = await loadTuiContext();
    const records = Object.values(ctx.state.repos).sort(compareReposForCheckout);

    clear();
    title("Choose Repo");
    if (records.length === 0) {
      console.log("No repos in inventory. Run Sync first.");
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

    if (await createCheckoutFlow(selection)) return;
  }
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
  const auth = await dashboardAuthStatus(paths);
  return {
    paths,
    config,
    checkoutRoot,
    state,
    auth,
  };
}

async function dashboardAuthStatus(paths: Paths): Promise<AuthDashboardStatus> {
  const resolved = await resolveToken(paths);
  if (!resolved) {
    return {
      label: color.danger("not signed in"),
      detail: "run `strappy auth`",
      attention: "danger  GitHub auth is not configured",
    };
  }

  const key = authCacheKey(resolved);
  const now = Date.now();
  if (authStatusCache?.key === key && now - authStatusCache.checkedAt < AUTH_STATUS_CACHE_MS) {
    return authStatusCache.status;
  }

  const status = await checkAuth(resolved);
  authStatusCache = { key, checkedAt: now, status };
  return status;
}

async function checkAuth(resolved: ResolvedToken): Promise<AuthDashboardStatus> {
  try {
    const login = await withTimeout(whoami(makeOctokit(resolved.token)), AUTH_STATUS_TIMEOUT_MS);
    return {
      label: color.info(`@${login}`),
      detail: tokenSourceLabel(resolved.source),
    };
  } catch (err) {
    if (err instanceof TimeoutError) {
      return {
        label: "configured",
        detail: `${tokenSourceLabel(resolved.source)}, check timed out`,
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    return {
      label: color.danger("invalid"),
      detail: tokenSourceLabel(resolved.source),
      attention: `danger  GitHub auth failed: ${message}`,
    };
  }
}

async function withTimeout<Value>(promise: Promise<Value>, ms: number): Promise<Value> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<Value>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function authCacheKey(resolved: ResolvedToken): string {
  const fingerprint = createHash("sha256").update(resolved.token).digest("hex");
  return `${resolved.source}:${fingerprint}`;
}

function authSummary(status: AuthDashboardStatus): string {
  return status.detail ? `${status.label} (${status.detail})` : status.label;
}

function tokenSourceLabel(source: TokenSource): string {
  switch (source) {
    case "env:STRAPPY_GITHUB_TOKEN":
      return "STRAPPY_GITHUB_TOKEN";
    case "env:GITHUB_TOKEN":
      return "GITHUB_TOKEN";
    case "file":
      return "saved token";
    case "gh-cli":
      return "GitHub CLI";
  }
}

async function ensureCheckoutRoot(): Promise<void> {
  const paths = getPaths();
  const config = await loadConfig(paths);
  await fs.mkdir(resolveCheckoutRoot(paths, config), { recursive: true });
}

async function scanCheckoutEntries(): Promise<[string, CheckoutRecord][]> {
  const store = openStore(getPaths());
  const scanned = await scanCheckouts(store);
  return Object.entries(scanned).sort((a, b) => a[0].localeCompare(b[0]));
}

function mainMenuChoices(checkouts: [string, CheckoutRecord][]): Array<Choice<MainAction> | Separator> {
  const choices: Array<Choice<MainAction> | Separator> = [
    menuSection("Actions"),
    { value: "sync", name: "Sync", description: "Inventory, mirrors, stale metadata" },
    { value: "audit", name: "Audit", description: "Repo file hygiene reports" },
    { value: "checkout", name: "Checkout", description: "New working copy" },
    menuSection(checkouts.length ? "Checkouts" : "Checkouts (none)"),
  ];

  choices.push(...checkouts.map(([name, checkout]) => checkoutChoice(name, checkout)));
  return choices;
}

function menuSection(text: string): Separator {
  return new Separator(color.dim(text));
}

function menuPageSize(): number {
  return Math.max(10, Math.min(20, (process.stdout.rows ?? 24) - 8));
}

function repoChoices(records: RepoRecord[], term: string | undefined): Choice<RepoRecord>[] {
  const needle = term?.trim().toLowerCase() ?? "";
  const filtered = needle
    ? records.filter((repo) => repoSearchText(repo).includes(needle))
    : records;
  const visible = filtered.sort(compareReposForCheckout).slice(0, 50);
  const layout = repoListLayout(hasSingleOwner(visible));

  return visible.map((repo) => ({
    value: repo,
    name: repoListLine(repo, layout),
    description: repo.metadata?.description ?? undefined,
    short: repo.fullName,
  }));
}

interface RepoListLayout {
  nameWidth: number;
  languageWidth: number;
  ageWidth: number;
  visibilityWidth: number;
  statusWidth: number;
  hideOwner: boolean;
}

function repoListLayout(hideOwner: boolean): RepoListLayout {
  const languageWidth = 12;
  const ageWidth = 10;
  const visibilityWidth = 7;
  const minNameWidth = 18;
  const desiredStatusWidth = 16;
  const minStatusWidth = 8;
  const gapsWidth = 8;
  const rowWidth = Math.max(52, screenWidth() - 3);
  let statusWidth = desiredStatusWidth;
  let nameWidth = rowWidth - languageWidth - ageWidth - visibilityWidth - statusWidth - gapsWidth;

  if (nameWidth < minNameWidth) {
    statusWidth = Math.max(minStatusWidth, rowWidth - languageWidth - ageWidth - visibilityWidth - minNameWidth - gapsWidth);
    nameWidth = rowWidth - languageWidth - ageWidth - visibilityWidth - statusWidth - gapsWidth;
  }

  return {
    nameWidth: Math.max(minNameWidth, nameWidth),
    languageWidth,
    ageWidth,
    visibilityWidth,
    statusWidth,
    hideOwner,
  };
}

function repoListLine(repo: RepoRecord, layout: RepoListLayout): string {
  const language = fitText(repo.metadata?.language ?? "-", layout.languageWidth);
  const pushed = fitText(timeAgo(repoActivityIso(repo)), layout.ageWidth);
  const visibility = repo.private ? "private" : "public";
  const status = [
    repo.lastSyncOk === false ? "FAIL" : null,
    repo.orphaned ? "orphaned" : null,
    repo.archived ? "archived" : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    `${fitText(repoDisplayName(repo, layout.hideOwner), layout.nameWidth).padEnd(layout.nameWidth)}  ` +
    `${language.padEnd(layout.languageWidth)}  ` +
    `${pushed.padStart(layout.ageWidth)}  ` +
    `${visibility.padEnd(layout.visibilityWidth)}  ` +
    fitText(status, layout.statusWidth)
  );
}

function hasSingleOwner(repos: RepoRecord[]): boolean {
  if (repos.length === 0) return true;
  const firstOwner = repoOwner(repos[0]);
  return repos.every((repo) => repoOwner(repo) === firstOwner);
}

function repoDisplayName(repo: RepoRecord, hideOwner: boolean): string {
  return hideOwner ? splitFullName(repo.fullName)[1] : repo.fullName;
}

function repoOwner(repo: RepoRecord): string {
  return splitFullName(repo.fullName)[0];
}

function compareReposForCheckout(a: RepoRecord, b: RepoRecord): number {
  const archived = Number(a.archived) - Number(b.archived);
  if (archived !== 0) return archived;

  const activity = repoActivityMs(b) - repoActivityMs(a);
  if (activity !== 0) return activity;

  return a.fullName.localeCompare(b.fullName);
}

function repoActivityIso(repo: RepoRecord): string | null {
  return repo.metadata?.pushedAt ?? repo.lastSync;
}

function repoActivityMs(repo: RepoRecord): number {
  const iso = repoActivityIso(repo);
  if (!iso) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
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

async function auditMenu(): Promise<void> {
  while (true) {
    const ctx = await loadTuiContext();
    const records = auditCandidateRepos(Object.values(ctx.state.repos));

    clear();
    title("Audit");
    if (records.length === 0) {
      console.log("No active repos to audit. Run Sync first.");
      await pause();
      return;
    }

    const tier3Count = records.filter(hasTier3Data).length;
    const branchCount = records.filter(hasBranchData).length;
    console.log(
      `${records.length} active repo(s), ${tier3Count} with Tier-3 file data, ` +
        `${branchCount} with branch metadata.`,
    );
    console.log(color.dim("Audits use stored file bodies and branch metadata from Sync/Enrich."));
    console.log("");

    let action: AuditAction;
    try {
      action = await selectPrompt<AuditAction>({
        message: "Choose audit",
        pageSize: 8,
        choices: auditMenuChoices(records),
      });
    } catch (err) {
      if (isBackSignal(err)) return;
      throw err;
    }

    await showAuditReport(action);
  }
}

function auditMenuChoices(records: RepoRecord[]): Choice<AuditAction>[] {
  return AUDITS.map((audit) => {
    const result = runAudit(audit, records);
    return {
      value: audit.action,
      name: `${audit.name} (${result.matches.length})`,
      description: audit.description,
      short: audit.name,
    };
  });
}

async function showAuditReport(action: AuditAction): Promise<void> {
  const audit = auditDefinition(action);
  const ctx = await loadTuiContext();
  const records = auditCandidateRepos(Object.values(ctx.state.repos));
  const result = runAudit(audit, records);

  clear();
  title(audit.name);
  console.log(`${result.matches.length} repo(s) matched out of ${records.length} active repo(s).`);
  console.log(color.dim(audit.description));
  console.log("");

  if (result.matches.length === 0) {
    console.log(audit.empty);
  } else {
    printAuditRepoList(result.matches);
  }

  if (result.unknown.length > 0) {
    console.log("");
    console.log(color.warn(`Skipped ${result.unknown.length} repo(s) ${audit.unknownLabel}.`));
    console.log(color.dim(audit.refreshHint));
    const examples = result.unknown.slice(0, 5).map((repo) => repo.fullName).join(", ");
    console.log(color.dim(`Examples: ${examples}${result.unknown.length > 5 ? ", ..." : ""}`));
  }

  console.log("");
  await pause();
}

function auditDefinition(action: AuditAction): AuditDefinition {
  const audit = AUDITS.find((candidate) => candidate.action === action);
  if (!audit) throw new Error(`Unknown audit "${action}".`);
  return audit;
}

function runAudit(
  audit: AuditDefinition,
  records: RepoRecord[],
): { matches: RepoRecord[]; unknown: RepoRecord[] } {
  const known = records.filter(audit.isKnown);
  return {
    matches: known.filter(audit.matches).sort(compareReposForCheckout),
    unknown: records.filter((repo) => !audit.isKnown(repo)).sort(compareReposForCheckout),
  };
}

function auditCandidateRepos(records: RepoRecord[]): RepoRecord[] {
  return records.filter((repo) => !repo.orphaned && !repo.archived).sort(compareReposForCheckout);
}

function hasInventoryData(_repo: RepoRecord): boolean {
  return true;
}

function hasTier3Data(repo: RepoRecord): boolean {
  return repo.tier3 !== null;
}

function hasBranchData(repo: RepoRecord): boolean {
  return repo.enrichment?.branches !== null && repo.enrichment?.branches !== undefined;
}

function mainBranch(repo: RepoRecord): { protected: boolean } | undefined {
  return repo.enrichment?.branches?.find((branch) => branch.name === "main");
}

function printAuditRepoList(records: RepoRecord[]): void {
  const layout = repoListLayout(hasSingleOwner(records));
  for (const repo of records) console.log(repoListLine(repo, layout));
}

function checkoutChoice(name: string, checkout: CheckoutRecord): Choice<MainAction> {
  return {
    value: `checkout:${name}`,
    name: checkoutMenuLine(name, checkout),
    description: `${checkout.repo}  ${checkout.path}`,
    short: name,
  };
}

function checkoutMenuLine(name: string, checkout: CheckoutRecord): string {
  const status = checkoutStatusLabel(checkout);
  const branch = fitText(checkout.currentBranch ?? checkout.branch, 14);
  const nameWidth = Math.max(18, screenWidth() - 38);
  return `${fitText(name, nameWidth).padEnd(nameWidth)}  ${status.padEnd(12)}  ${branch}`;
}

function checkoutStatusLabel(checkout: CheckoutRecord): string {
  if (checkout.exists === false) return "missing";
  if (checkout.scanError) return "warning";
  if (checkout.dirty && (checkout.ahead ?? 0) > 0) return "dirty+push";
  if (checkout.dirty) return "dirty";
  if ((checkout.ahead ?? 0) > 0) return `${checkout.ahead} unpushed`;
  if ((checkout.behind ?? 0) > 0) return `${checkout.behind} behind`;
  return "clean";
}

function fitText(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 3) return value.slice(0, width);
  return `${value.slice(0, width - 3)}...`;
}

async function createCheckoutFlow(repo: RepoRecord): Promise<boolean> {
  clear();
  title(`Checkout ${repoDisplayName(repo, true)}`);
  console.log(color.dim("Creating checkout..."));

  try {
    const paths = getPaths();
    const config = await loadConfig(paths);
    const store = openStore(paths);
    await createCheckout({
      store,
      paths,
      config,
      repoArg: repo.fullName,
    });
  } catch (err) {
    clear();
    title(`Checkout ${repoDisplayName(repo, true)}`);
    const message = err instanceof Error ? err.message : String(err);
    console.log(`Error: ${message}`);
    console.log("");
    await pause();
  }

  return true;
}

async function handleCheckoutSelection(name: string): Promise<void> {
  const checkout = await refreshCheckout(name);
  if (!checkout) return;

  const unsafe = unsafeReason(checkout);
  if (!unsafe) {
    let confirmed: boolean;
    try {
      confirmed = await confirmCleanCheckout(name, checkout);
    } catch (err) {
      if (isBackSignal(err)) return;
      throw err;
    }
    if (!confirmed) return;
    await cleanCheckout(name);
    return;
  }

  await checkoutWorkMenu(name);
}

async function confirmCleanCheckout(name: string, checkout: CheckoutRecord): Promise<boolean> {
  clear();
  title(`Remove ${name}`);
  console.log(`Repo   ${checkout.repo}`);
  console.log(`Path   ${checkout.path}`);
  console.log(`Status ${checkoutStatus(checkout)}`);
  console.log("");
  return confirmPrompt({ message: "Remove checkout?", default: true });
}

async function refreshCheckout(name: string): Promise<CheckoutRecord | null> {
  const paths = getPaths();
  const store = openStore(paths);
  const state = await store.read();
  const resolvedName = resolveCheckoutName(state, name);
  const scanned = await scanCheckouts(store, [resolvedName]);
  return scanned[resolvedName] ?? null;
}

async function cleanCheckout(name: string): Promise<void> {
  const store = openStore(getPaths());
  const result = await cleanupCheckouts(store, { name });
  if (result.refused.length) {
    clear();
    title(`Clean ${name}`);
    printCleanupResult(result);
    console.log("");
    await pause();
  }
}

async function checkoutWorkMenu(name: string): Promise<void> {
  while (true) {
    const checkout = await refreshCheckout(name);
    if (!checkout) return;

    clear();
    title(name);
    console.log(`${checkoutStatus(checkout)}  ${checkout.repo}  ${checkout.currentBranch ?? checkout.branch}`);
    if (checkout.scanError) console.log(color.warn(`Warning  ${checkout.scanError}`));
    console.log(color.dim(checkout.path));
    console.log("");

    const canDiff = checkout.dirty === true;
    const canCommit = checkout.dirty === true;
    const canPush = (checkout.ahead ?? 0) > 0;

    if (!canDiff && !canCommit && !canPush) {
      console.log(color.dim("No local diff or unpushed commits available."));
      await pause();
      return;
    }

    let action: CheckoutWorkAction;
    try {
      action = await selectPrompt<CheckoutWorkAction>({
        message: "Menu",
        choices: [
          { value: "diff", name: "Diff", disabled: canDiff ? false : "(no changes)" },
          { value: "commit", name: "Commit", disabled: canCommit ? false : "(no changes)" },
          { value: "push", name: "Push", disabled: canPush ? false : "(nothing to push)" },
        ],
      });
    } catch (err) {
      if (isBackSignal(err)) return;
      throw err;
    }

    if (action === "diff") await showCheckoutDiff(name, checkout);
    else if (action === "commit") await commitCheckoutChanges(name, checkout);
    else if (action === "push") await pushCheckoutChanges(name, checkout);
  }
}

async function showCheckoutDiff(name: string, checkout: CheckoutRecord): Promise<void> {
  await runCommand(`Diff ${name}`, async () => {
    await printGitSection(checkout.path, "Status", ["status", "--short"]);
    await printGitSection(checkout.path, "Unstaged", ["--no-pager", "diff"]);
    await printGitSection(checkout.path, "Staged", ["--no-pager", "diff", "--cached"]);
  });
}

async function commitCheckoutChanges(name: string, checkout: CheckoutRecord): Promise<void> {
  let message: string;
  try {
    message = await inputPrompt({ message: "Commit message" });
  } catch (err) {
    if (isBackSignal(err)) return;
    throw err;
  }

  const trimmed = message.trim();
  if (!trimmed) return;

  await runCommand(`Commit ${name}`, async () => {
    await git(checkout.path, ["add", "-A"]);
    const result = await git(checkout.path, ["commit", "-m", trimmed], 60_000);
    printProcessOutput(result);
    const refreshed = await refreshCheckout(name);
    if (refreshed) console.log(`Status ${checkoutStatus(refreshed)}`);
  });
}

async function pushCheckoutChanges(name: string, checkout: CheckoutRecord): Promise<void> {
  await runCommand(`Push ${name}`, async () => {
    const args = checkout.upstream ? ["push"] : ["push", "-u", "origin", "HEAD"];
    const result = await git(checkout.path, args, 120_000);
    printProcessOutput(result);
    const refreshed = await refreshCheckout(name);
    if (refreshed) console.log(`Status ${checkoutStatus(refreshed)}`);
  });
}

async function printGitSection(repoPath: string, label: string, args: string[]): Promise<void> {
  const result = await git(repoPath, args);
  console.log(label);
  console.log("-".repeat(Math.max(12, label.length)));
  printProcessOutput(result, "(none)");
  console.log("");
}

async function git(repoPath: string, args: string[], timeout = 30_000): Promise<{ stdout: string; stderr: string }> {
  return execa("git", ["-C", repoPath, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    timeout,
  });
}

function printProcessOutput(result: { stdout: string; stderr: string }, empty = ""): void {
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  console.log(output || empty);
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

interface PromptBehavior {
  refreshMs?: number;
}

async function selectPrompt<Value>(
  config: Parameters<typeof select<Value>>[0],
  behavior: PromptBehavior = {},
): Promise<Value> {
  return withEscapeBack((signal) =>
    select<Value>(
      {
        ...config,
        instructions: config.instructions ?? BACK_INSTRUCTIONS,
        theme: { ...MENU_PROMPT_THEME, ...config.theme },
      },
      { signal },
    ),
    behavior,
  );
}

async function searchPrompt<Value>(config: Parameters<typeof search<Value>>[0]): Promise<Value> {
  return withEscapeBack((signal) =>
    search<Value>(
      {
        ...config,
        instructions: config.instructions ?? BACK_INSTRUCTIONS,
        theme: { ...MENU_PROMPT_THEME, ...config.theme },
      },
      { signal },
    ),
  );
}

async function inputPrompt(config: Parameters<typeof input>[0]): Promise<string> {
  return withEscapeBack((signal) => input(config, { signal }));
}

async function confirmPrompt(config: Parameters<typeof confirm>[0]): Promise<boolean> {
  return withEscapeBack((signal) =>
    confirm(
      {
        ...config,
        theme: { prefix: "", ...config.theme },
      },
      { signal },
    ),
  );
}

async function withEscapeBack<Value>(
  fn: (signal: AbortSignal) => Promise<Value>,
  behavior: PromptBehavior = {},
): Promise<Value> {
  const controller = new AbortController();
  const onKeypress = (_char: string, key: KeypressEvent) => {
    if (!controller.signal.aborted && (key.name === "escape" || key.sequence === "\u001b")) {
      controller.abort(ESCAPE_ABORT_REASON);
    }
  };
  const refreshTimer = behavior.refreshMs
    ? setTimeout(() => {
        if (!controller.signal.aborted) controller.abort(DASHBOARD_REFRESH_ABORT_REASON);
      }, behavior.refreshMs)
    : null;

  readline.emitKeypressEvents(process.stdin);
  process.stdin.on("keypress", onKeypress);
  try {
    return await fn(controller.signal);
  } catch (err) {
    if (isEscapeAbort(err)) throw new BackSignal();
    if (isDashboardRefreshAbort(err)) throw new DashboardRefreshSignal();
    throw err;
  } finally {
    if (refreshTimer) clearTimeout(refreshTimer);
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

function isDashboardRefreshSignal(err: unknown): boolean {
  return err instanceof DashboardRefreshSignal;
}

function isEscapeAbort(err: unknown): boolean {
  return isPromptAbort(err, ESCAPE_ABORT_REASON);
}

function isDashboardRefreshAbort(err: unknown): boolean {
  return isPromptAbort(err, DASHBOARD_REFRESH_ABORT_REASON);
}

function isPromptAbort(err: unknown, reason: string): boolean {
  return (
    err instanceof Error &&
    err.name === "AbortPromptError" &&
    (err as Error & { cause?: unknown }).cause === reason
  );
}

function isPromptExit(err: unknown): boolean {
  return err instanceof Error && err.name === "ExitPromptError";
}

const color = {
  bold: ansi(1),
  dim: ansi(2),
  danger: ansi(31),
  warn: ansi(33),
  info: ansi(36),
};

function ansi(code: number): (value: string) => string {
  return (value) => (process.stdout.isTTY ? `\x1b[${code}m${value}\x1b[0m` : value);
}

function rule(): string {
  return color.dim("─".repeat(screenWidth()));
}

function screenWidth(): number {
  return Math.max(56, Math.min(100, process.stdout.columns ?? 88));
}

function clock(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function dashboardRow(
  label: string,
  value: string,
): void {
  console.log(`${color.dim(label.padEnd(12))}${value}`);
}

function section(text: string): void {
  console.log(color.bold(text));
}

function attentionLine(line: string): string {
  if (line.startsWith("danger")) return color.danger(line);
  if (line.startsWith("warn")) return color.warn(line);
  if (line.startsWith("info")) return color.info(line);
  return line;
}
