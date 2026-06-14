import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as readline from "node:readline";
import {
  createPrompt,
  isDownKey,
  isEnterKey,
  isUpKey,
  Separator,
  useEffect,
  useKeypress,
  useRef,
  useState,
} from "@inquirer/core";
import { confirm, input, search, select } from "@inquirer/prompts";
import { execa } from "execa";
import { resolveToken, type ResolvedToken } from "./auth.js";
import {
  checkoutBranch,
  checkoutStatus,
  cleanupCheckouts,
  createCheckout,
  resolveCheckoutName,
  resolveCheckoutRoot,
  resolveRepo,
  scanCheckout,
  scanCheckouts,
  unsafeReason,
} from "./checkouts.js";
import { runFullSync } from "./commands/sync.js";
import { loadConfig, type StrappyConfig } from "./config.js";
import { openStore } from "./db.js";
import {
  listEnvironmentProfiles,
  listEnvironmentRepositories,
  readEnvironmentManifest,
  restoreEnvironment,
  saveEnvironment,
  type EnvironmentProfileSummary,
  type EnvironmentRepoSummary,
} from "./environments.js";
import {
  assertEnvironmentCheckoutReady,
  discoverEnvironmentFilePaths,
  environmentCheckoutRoot,
} from "./environment-discovery.js";
import { humanSize, timeAgo } from "./format.js";
import { makeOctokit, whoami } from "./github.js";
import { Logger } from "./logger.js";
import { getPaths, splitFullName, type Paths } from "./paths.js";
import type { CheckoutRecord, RepoRecord, StrappyState } from "./state.js";

type MainAction =
  | "sync"
  | "audit"
  | "environments"
  | "checkout"
  | `checkout:${string}`;

type AuditAction =
  | "no-readme"
  | "no-agents"
  | "no-compose"
  | "compose-no-altivec"
  | "main-unprotected"
  | "default-branch-not-main";

type CheckoutWorkAction = "diff" | "commit" | "reset";

type EnvironmentAction = "list" | "update" | "save" | "restore";

type EnvironmentDriftAction = "upload" | "download" | "choose" | "blocked";

interface EnvironmentDriftRow {
  action: EnvironmentDriftAction;
  checkoutName: string;
  repo: string;
  path: string;
  detail?: string;
}

interface EnvironmentDriftReport {
  rows: EnvironmentDriftRow[];
  checked: number;
  warnings: string[];
  savedWithoutCheckout: string[];
}

interface Choice<Value> {
  value: Value;
  name?: string;
  description?: string;
  short?: string;
  disabled?: boolean | string;
}

interface TuiContext {
  state: StrappyState;
  auth: AuthDashboardStatus;
}

interface DashboardSnapshot {
  ctx: TuiContext;
  checkouts: [string, CheckoutRecord][];
}

type DashboardPromptResult =
  | { type: "exit"; nextAutoSyncAt: number }
  | { type: "action"; action: Exclude<MainAction, "sync">; nextAutoSyncAt: number };

interface DashboardPromptConfig {
  snapshot: DashboardSnapshot;
  nextAutoSyncAt: number;
  loadSnapshot: (scanCheckouts: boolean) => Promise<DashboardSnapshot>;
  runSync: (
    label: string,
    source: string,
    onLine: (line?: string) => void,
  ) => Promise<{ failed: number }>;
}

interface DashboardPromptState {
  snapshot: DashboardSnapshot;
  nextAutoSyncAt: number;
  active: number;
  mode: DashboardMode;
}

type DashboardMode =
  | { type: "dashboard" }
  | { type: "sync"; label: string; lines: string[]; status: "running" | "done" };

interface AuthDashboardStatus {
  label: string;
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

interface DashboardRow {
  label: string;
  value: string;
  note?: string;
}

interface CheckoutListLayout {
  nameWidth: number;
  branchWidth: number;
  statusWidth: number;
}

const ESCAPE_ABORT_REASON = "strappy:escape-back";
const DASHBOARD_REFRESH_MS = 60_000;
const AUTO_SYNC_MS = 4 * 60 * 60_000;
const SYNC_LOG_RETURN_DELAY_MS = 750;
const SYNC_LOG_MAX_LINES = 500;
const AUTH_STATUS_CACHE_MS = 5 * 60_000;
const AUTH_STATUS_TIMEOUT_MS = 2_500;
const DASHBOARD_LABEL_WIDTH = 18;
const TUI_TITLE = "🍆ＳＴＲＡＰＰＹ💅ＦＬＥＥＴ🚢";
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
  navigation: "↑↓ navigate ⏎ select ␛ back",
  pager: "↑↓ navigate ⏎ select ␛ back",
};
let authStatusCache: { key: string; checkedAt: number; status: AuthDashboardStatus } | null = null;

class BackSignal extends Error {
  override name = "BackSignal";
}

class TimeoutError extends Error {
  override name = "TimeoutError";
}

export async function runTui(): Promise<void> {
  try {
    await ensureCheckoutRoot();
    let nextAutoSyncAt = scheduleNextAutoSync();

    while (true) {
      const result = await dashboardPrompt({
        snapshot: await loadDashboardSnapshot(true),
        nextAutoSyncAt,
        loadSnapshot: loadDashboardSnapshot,
        runSync: runDashboardPromptSync,
      });

      nextAutoSyncAt = result.nextAutoSyncAt;
      if (result.type === "exit") return;

      const action = result.action;
      if (action === "audit") await auditMenu();
      else if (action === "environments") await environmentsMenu();
      else if (action === "checkout") await repoCheckoutSearchView();
      else if (action.startsWith("checkout:")) await handleCheckoutSelection(action.slice("checkout:".length));
    }
  } catch (err) {
    if (isPromptExit(err)) return;
    throw err;
  }
}

const dashboardPrompt = createPrompt<DashboardPromptResult, DashboardPromptConfig>((config, done) => {
  const [, setVersion] = useState(0);
  const versionRef = useRef(0);
  const renderTimerRef = useRef<NodeJS.Timeout | null>(null);
  const returnTimerRef = useRef<NodeJS.Timeout | null>(null);
  const stateRef = useRef<DashboardPromptState>({
    snapshot: config.snapshot,
    nextAutoSyncAt: config.nextAutoSyncAt,
    active: firstSelectableIndex(mainMenuChoices(config.snapshot.checkouts)),
    mode: { type: "dashboard" },
  });

  const renderNow = () => {
    versionRef.current += 1;
    setVersion(versionRef.current);
  };

  const requestRender = () => {
    if (renderTimerRef.current) return;
    renderTimerRef.current = setTimeout(() => {
      renderTimerRef.current = null;
      renderNow();
    }, 50);
  };

  const appendSyncLine = (line = "") => {
    const mode = stateRef.current.mode;
    if (mode.type !== "sync") return;
    for (const part of line.split(/\r?\n/)) mode.lines.push(part);
    if (mode.lines.length > SYNC_LOG_MAX_LINES) {
      mode.lines.splice(0, mode.lines.length - SYNC_LOG_MAX_LINES);
    }
    requestRender();
  };

  const refreshSnapshot = async (scanCheckouts: boolean) => {
    if (stateRef.current.mode.type !== "dashboard") return;
    const snapshot = await config.loadSnapshot(scanCheckouts);
    if (stateRef.current.mode.type !== "dashboard") return;
    stateRef.current.snapshot = snapshot;
    normalizeDashboardActive(stateRef.current);
    renderNow();
  };

  const returnToDashboard = async () => {
    stateRef.current.snapshot = await config.loadSnapshot(false);
    stateRef.current.mode = { type: "dashboard" };
    normalizeDashboardActive(stateRef.current);
    renderNow();
  };

  const beginSync = (label: string, source: string) => {
    if (stateRef.current.mode.type === "sync") return;
    if (returnTimerRef.current) clearTimeout(returnTimerRef.current);

    stateRef.current.mode = {
      type: "sync",
      label,
      lines: [`${label} started at ${clock(new Date())}`],
      status: "running",
    };
    renderNow();

    void config
      .runSync(label, source, appendSyncLine)
      .then((result) => {
        const mode = stateRef.current.mode;
        if (mode.type === "sync") {
          mode.status = "done";
          mode.lines.push("");
          mode.lines.push(
            result.failed > 0
              ? `${label} finished with ${result.failed} failure(s).`
              : `${label} finished successfully.`,
          );
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const mode = stateRef.current.mode;
        if (mode.type === "sync") {
          mode.status = "done";
          mode.lines.push("");
          mode.lines.push(`Error: ${message}`);
          mode.lines.push(`${label} failed.`);
        }
      })
      .finally(() => {
        stateRef.current.nextAutoSyncAt = scheduleNextAutoSync();
        renderNow();
        returnTimerRef.current = setTimeout(() => {
          returnTimerRef.current = null;
          void returnToDashboard();
        }, SYNC_LOG_RETURN_DELAY_MS);
      });
  };

  useEffect(() => {
    const refreshTimer = setInterval(() => {
      void refreshSnapshot(true);
    }, DASHBOARD_REFRESH_MS);

    return () => {
      clearInterval(refreshTimer);
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
      if (returnTimerRef.current) clearTimeout(returnTimerRef.current);
    };
  }, []);

  const modeType = stateRef.current.mode.type;
  const nextAutoSyncAt = stateRef.current.nextAutoSyncAt;
  useEffect(() => {
    if (stateRef.current.mode.type !== "dashboard") return;
    const timer = setTimeout(() => {
      beginSync("Automatic Sync", "tui-auto-sync");
    }, Math.max(0, nextAutoSyncAt - Date.now()));

    return () => clearTimeout(timer);
  }, [modeType, nextAutoSyncAt]);

  useKeypress((key, rl) => {
    if (stateRef.current.mode.type === "sync") {
      rl.clearLine(0);
      return;
    }

    if (key.name === "escape") {
      done({ type: "exit", nextAutoSyncAt: stateRef.current.nextAutoSyncAt });
      return;
    }

    if (isUpKey(key) || isDownKey(key)) {
      rl.clearLine(0);
      moveDashboardActive(stateRef.current, isUpKey(key) ? -1 : 1);
      renderNow();
      return;
    }

    if (isEnterKey(key)) {
      const choice = activeDashboardChoice(stateRef.current);
      if (!choice || Separator.isSeparator(choice)) return;
      if (choice.value === "sync") beginSync("Sync", "tui-sync");
      else {
        done({
          type: "action",
          action: choice.value,
          nextAutoSyncAt: stateRef.current.nextAutoSyncAt,
        });
      }
      return;
    }

    rl.clearLine(0);
  });

  return renderDashboardPrompt(stateRef.current);
});

function renderDashboardPrompt(state: DashboardPromptState): string {
  normalizeDashboardActive(state);
  const topLines =
    state.mode.type === "sync"
      ? syncDashboardLines(state.mode)
      : dashboardLines(state.snapshot, state.nextAutoSyncAt);

  return [
    ...topLines,
    "",
    color.bold("Menu"),
    ...dashboardMenuLines(state),
    "",
    state.mode.type === "sync"
      ? color.dim("Sync in progress. Menu will unlock when the tail completes.")
      : color.dim("↑↓ navigate ⏎ select ␛ exit"),
  ].join("\n");
}

function syncDashboardLines(mode: Extract<DashboardMode, { type: "sync" }>): string[] {
  const menuReserve = syncMenuPageSize() + 7;
  const maxLines = Math.max(6, (process.stdout.rows ?? 24) - menuReserve);
  const width = screenWidth();
  const stateLabel = mode.status === "running" ? "running" : "complete";
  return [
    ...tuiTitleLines(),
    color.dim(`${mode.label} | ${stateLabel} | ${clock(new Date())}`),
    rule(),
    ...mode.lines.slice(-maxLines).map((line) => fitText(line, width)),
    rule(),
    mode.status === "running"
      ? color.dim("Sync in progress...")
      : color.dim("Returning to dashboard..."),
  ];
}

function dashboardLines(snapshot: DashboardSnapshot, nextAutoSyncAt: number): string[] {
  const ctx = snapshot.ctx;
  const repos = Object.values(ctx.state.repos);
  const failures = repos.filter((r) => r.lastSyncOk === false);
  const orphaned = repos.filter((r) => r.orphaned);
  const totalKb = repos.reduce((sum, r) => sum + (r.sizeKb ?? 0), 0);
  const fleetRows: DashboardRow[] = [
    { label: "Mirrors", value: `${repos.length} (${humanSize(totalKb)})` },
    { label: "Checkouts", value: String(snapshot.checkouts.length) },
  ];
  const syncRows: DashboardRow[] = [
    { label: "Auth", value: authSummary(ctx.auth) },
    { label: "Last Sync", value: timeAgo(ctx.state.lastInventoryAt) },
    { label: "Next Sync", value: timeUntil(nextAutoSyncAt) },
    { label: "Sync Timer", value: `${AUTO_SYNC_MS / 3600_000}h` },
    { label: "Checkout Timer", value: `${DASHBOARD_REFRESH_MS / 1000}s` },
  ];
  const lines = [
    ...tuiTitleLines(),
    color.bold("Sync"),
    ...syncRows.map((row) => dashboardRowText(row.label, row.value, row.note)),
    "",
    color.bold("Fleet"),
    ...fleetRows.map((row) => dashboardRowText(row.label, row.value, row.note)),
  ];

  const needsAttention = [
    ctx.auth.attention ?? null,
    failures.length ? `danger  ${failures.length} repo(s) had mirror sync errors` : null,
    orphaned.length ? `warn    ${orphaned.length} orphaned mirror(s); repo absent from GitHub inventory` : null,
    repos.length === 0 ? "info    No repo inventory yet; run Sync" : null,
  ].filter((line): line is string => line !== null);

  if (needsAttention.length > 0) {
    lines.push("", color.bold("Needs Attention"));
    for (const line of needsAttention) lines.push(attentionLine(line));
  }

  if (failures.length) {
    lines.push("", color.bold("Recent Sync Errors"));
    for (const repo of failures.slice(0, 5)) {
      lines.push(`${repo.fullName}: ${repo.lastError ?? "unknown error"}`);
    }
  }

  if (orphaned.length) {
    lines.push("", color.bold("Orphaned Mirrors"));
    for (const repo of orphaned.slice(0, 5)) {
      lines.push(repo.fullName);
    }
  }

  return lines;
}

function dashboardMenuLines(state: DashboardPromptState): string[] {
  const choices = mainMenuChoices(state.snapshot.checkouts);
  const pageSize = state.mode.type === "sync" ? syncMenuPageSize() : menuPageSize();
  const start = Math.max(0, Math.min(state.active - Math.floor(pageSize / 2), choices.length - pageSize));
  const end = Math.min(choices.length, start + pageSize);
  const lines: string[] = [];
  const sectionIndent = "";
  const itemIndent = "";

  if (start > 0) lines.push(color.dim(`... ${start} more above`));
  for (let index = start; index < end; index++) {
    const choice = choices[index];
    if (Separator.isSeparator(choice)) {
      lines.push(`${sectionIndent}${choice.separator}`);
      continue;
    }

    const marker = index === state.active ? ">" : " ";
    const name = choice.name ?? String(choice.value);
    const line = `${itemIndent}${marker} ${name}`;
    lines.push(index === state.active ? color.info(line) : line);
  }
  if (end < choices.length) lines.push(color.dim(`... ${choices.length - end} more below`));

  return lines;
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

async function runDashboardPromptSync(
  _label: string,
  source: string,
  onLine: (line?: string) => void,
): Promise<{ failed: number }> {
  const priorExitCode = process.exitCode;

  try {
    const paths = getPaths();
    const logger = new Logger(paths.logFile, source, false, (line) => onLine(line));
    return await runFullSync({
      repos: [],
      logger,
      emit: onLine,
    });
  } finally {
    process.exitCode = priorExitCode;
  }
}

async function loadTuiContext(): Promise<TuiContext> {
  const paths = getPaths();
  const store = openStore(paths);
  const state = await store.read();
  const auth = await dashboardAuthStatus(paths);
  return {
    state,
    auth,
  };
}

async function loadDashboardSnapshot(scanCheckouts: boolean): Promise<DashboardSnapshot> {
  const scanned = scanCheckouts ? await scanCheckoutEntries() : null;
  const ctx = await loadTuiContext();
  return {
    ctx,
    checkouts: scanned ?? Object.entries(ctx.state.checkouts).sort((a, b) => a[0].localeCompare(b[0])),
  };
}

async function dashboardAuthStatus(paths: Paths): Promise<AuthDashboardStatus> {
  const resolved = await resolveToken(paths);
  if (!resolved) {
    return {
      label: color.danger("not signed in"),
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
    };
  } catch (err) {
    if (err instanceof TimeoutError) {
      return {
        label: "configured, check timed out",
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    return {
      label: color.danger("invalid"),
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
  return status.label;
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
    { value: "sync", name: "Sync" },
    { value: "audit", name: "Audit" },
    { value: "environments", name: "Environments" },
    { value: "checkout", name: "Checkout" },
    menuSection(checkouts.length ? "Checkouts" : "Checkouts (none)"),
  ];

  if (checkouts.length) {
    const layout = checkoutListLayout(checkouts);
    choices.push(checkoutMenuHeader(layout));
    choices.push(...checkouts.map(([name, checkout]) => checkoutChoice(name, checkout, layout)));
  }
  return choices;
}

function firstSelectableIndex(choices: Array<Choice<MainAction> | Separator>): number {
  const index = choices.findIndex((choice) => !Separator.isSeparator(choice) && !choice.disabled);
  return index === -1 ? 0 : index;
}

function activeDashboardChoice(state: DashboardPromptState): Choice<MainAction> | Separator | undefined {
  return mainMenuChoices(state.snapshot.checkouts)[state.active];
}

function normalizeDashboardActive(state: DashboardPromptState): void {
  const choices = mainMenuChoices(state.snapshot.checkouts);
  const active = choices[state.active];
  if (active && !Separator.isSeparator(active) && !active.disabled) return;
  state.active = firstSelectableIndex(choices);
}

function moveDashboardActive(state: DashboardPromptState, offset: -1 | 1): void {
  const choices = mainMenuChoices(state.snapshot.checkouts);
  if (choices.length === 0) return;

  let next = state.active;
  for (let attempt = 0; attempt < choices.length; attempt++) {
    next = (next + offset + choices.length) % choices.length;
    const choice = choices[next];
    if (!Separator.isSeparator(choice) && !choice.disabled) {
      state.active = next;
      return;
    }
  }
}

function menuSection(text: string): Separator {
  return new Separator(color.dim(text));
}

function menuPageSize(): number {
  return Math.max(10, Math.min(20, (process.stdout.rows ?? 24) - 8));
}

function syncMenuPageSize(): number {
  return Math.max(5, Math.min(8, (process.stdout.rows ?? 24) - 16));
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

async function environmentsMenu(): Promise<void> {
  while (true) {
    const paths = getPaths();
    const checkouts = await scanCheckoutEntries();
    const drift = await environmentDriftReport(paths, checkouts);

    clear();
    title("Environments");
    printEnvironmentDrift(drift);
    console.log("");

    let action: EnvironmentAction;
    try {
      action = await selectPrompt<EnvironmentAction>({
        message: "Menu",
        choices: [
          { value: "list", name: "View Saved Secret Counts" },
          { value: "update", name: "Upload Checkout Secrets To Strappy" },
          { value: "save", name: "Upload Specific Path From Checkout" },
          { value: "restore", name: "Download Strappy Secrets To Checkout" },
        ],
      });
    } catch (err) {
      if (isBackSignal(err)) return;
      throw err;
    }

    if (action === "list") await showEnvironmentSummary();
    else if (action === "update") await updateEnvironmentFromCheckout();
    else if (action === "save") await saveEnvironmentPathFromCheckout();
    else if (action === "restore") await restoreEnvironmentIntoCheckout();
  }
}

async function showEnvironmentSummary(): Promise<void> {
  const summaries = await listEnvironmentRepositories(getPaths());
  clear();
  title("Saved Secrets");
  printEnvironmentSummaries(summaries);
  console.log("");
  await pause();
}

function printEnvironmentSummaries(summaries: EnvironmentRepoSummary[]): void {
  if (summaries.length === 0) {
    console.log("No saved environments.");
    return;
  }

  const repoWidth = Math.min(48, Math.max(...summaries.map((summary) => summary.repo.length)));
  for (const summary of summaries) {
    console.log(`${summary.repo.padEnd(repoWidth)}  ${String(summary.fileCount).padStart(3)} secret(s)`);
  }
  console.log(color.dim(`${summaries.length} repo(s).`));
}

async function environmentDriftReport(
  paths: Paths,
  checkouts: [string, CheckoutRecord][],
): Promise<EnvironmentDriftReport> {
  const savedSummaries = await listEnvironmentRepositories(paths);
  const checkoutRepos = new Set(checkouts.map(([, checkout]) => checkout.repo));
  const savedWithoutCheckout = savedSummaries
    .filter((summary) => !checkoutRepos.has(summary.repo))
    .map((summary) => summary.repo);
  const rows: EnvironmentDriftRow[] = [];
  const warnings: string[] = [];
  let checked = 0;

  for (const [name, checkout] of checkouts) {
    if (checkout.exists === false) {
      warnings.push(`${name}: checkout path is missing`);
      continue;
    }
    if (checkout.scanError) {
      warnings.push(`${name}: ${checkout.scanError}`);
      continue;
    }

    try {
      rows.push(...(await checkoutEnvironmentDriftRows(paths, name, checkout)));
      checked += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`${name}: ${message}`);
    }
  }

  rows.sort(
    (a, b) =>
      environmentDriftActionRank(a.action) - environmentDriftActionRank(b.action) ||
      a.checkoutName.localeCompare(b.checkoutName) ||
      a.path.localeCompare(b.path),
  );
  return { rows, checked, warnings, savedWithoutCheckout };
}

async function checkoutEnvironmentDriftRows(
  paths: Paths,
  checkoutName: string,
  checkout: CheckoutRecord,
): Promise<EnvironmentDriftRow[]> {
  const root = await environmentCheckoutRoot(checkout.path);
  const discoveredPaths = await discoverEnvironmentFilePaths(root);
  const manifest = await readEnvironmentManifest(paths, checkout.repo, "default", { allowMissing: true });
  const savedByPath = new Map((manifest?.files ?? []).map((entry) => [entry.path, entry]));
  const discovered = new Set(discoveredPaths);
  const rows: EnvironmentDriftRow[] = [];

  for (const rel of discoveredPaths) {
    if (!savedByPath.has(rel)) {
      rows.push({
        action: "upload",
        checkoutName,
        repo: checkout.repo,
        path: rel,
        detail: "checkout only",
      });
    }
  }

  for (const entry of savedByPath.values()) {
    const checkoutFile = path.join(root, ...entry.path.split("/"));
    const current = await checkoutEnvironmentFileState(checkoutFile);
    if (current.kind === "missing") {
      rows.push({
        action: "download",
        checkoutName,
        repo: checkout.repo,
        path: entry.path,
        detail: "strappy only",
      });
      continue;
    }
    if (current.kind === "blocked") {
      rows.push({
        action: "blocked",
        checkoutName,
        repo: checkout.repo,
        path: entry.path,
        detail: current.reason,
      });
      continue;
    }
    if (current.sha256 !== entry.sha256) {
      rows.push({
        action: "choose",
        checkoutName,
        repo: checkout.repo,
        path: entry.path,
        detail: discovered.has(entry.path) ? "both present" : "contents differ",
      });
    }
  }

  return rows;
}

async function checkoutEnvironmentFileState(
  file: string,
): Promise<{ kind: "file"; sha256: string } | { kind: "missing" } | { kind: "blocked"; reason: string }> {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw err;
  }

  if (stat.isSymbolicLink()) return { kind: "blocked", reason: "checkout path is a symlink" };
  if (!stat.isFile()) return { kind: "blocked", reason: "checkout path is not a file" };
  return { kind: "file", sha256: await hashFileSha256(file) };
}

async function hashFileSha256(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

function printEnvironmentDrift(report: EnvironmentDriftReport): void {
  console.log(color.bold("Drift"));
  if (report.checked === 0) {
    console.log("No registered checkouts to compare.");
  } else if (report.rows.length === 0) {
    console.log(`All environment files match across ${report.checked} checkout(s).`);
  } else {
    const layout = environmentDriftLayout(report.rows);
    for (const row of report.rows.slice(0, environmentDriftPageSize())) {
      console.log(environmentDriftLine(row, layout));
    }
    if (report.rows.length > environmentDriftPageSize()) {
      console.log(color.dim(`... ${report.rows.length - environmentDriftPageSize()} more mismatch(es)`));
    }
  }

  if (report.warnings.length) {
    console.log("");
    console.log(color.warn(`Skipped ${report.warnings.length} checkout(s).`));
    for (const warning of report.warnings.slice(0, 3)) console.log(color.dim(warning));
    if (report.warnings.length > 3) console.log(color.dim(`... ${report.warnings.length - 3} more`));
  }

  if (report.savedWithoutCheckout.length) {
    console.log("");
    console.log(color.dim(`${report.savedWithoutCheckout.length} saved repo(s) have no registered checkout.`));
    console.log(color.dim(report.savedWithoutCheckout.slice(0, 3).join(", ")));
  }
}

interface EnvironmentDriftLayout {
  actionWidth: number;
  checkoutWidth: number;
  pathWidth: number;
}

function environmentDriftLayout(rows: EnvironmentDriftRow[]): EnvironmentDriftLayout {
  const actionWidth = Math.max("Action".length, ...rows.map((row) => environmentDriftActionLabel(row.action).length));
  const checkoutWidth = Math.min(28, Math.max("Checkout".length, ...rows.map((row) => row.checkoutName.length)));
  const gapsWidth = 4;
  const pathWidth = Math.max(12, screenWidth() - actionWidth - checkoutWidth - gapsWidth);
  return { actionWidth, checkoutWidth, pathWidth };
}

function environmentDriftLine(row: EnvironmentDriftRow, layout: EnvironmentDriftLayout): string {
  const action = environmentDriftActionLabel(row.action).padEnd(layout.actionWidth);
  const checkout = fitText(row.checkoutName, layout.checkoutWidth).padEnd(layout.checkoutWidth);
  const detail = row.detail ? ` ${color.dim(`(${row.detail})`)}` : "";
  return `${action}  ${checkout}  ${fitText(row.path, layout.pathWidth)}${detail}`;
}

function environmentDriftActionLabel(action: EnvironmentDriftAction): string {
  if (action === "upload") return "upload";
  if (action === "download") return "download";
  if (action === "choose") return "choose";
  return "blocked";
}

function environmentDriftActionRank(action: EnvironmentDriftAction): number {
  if (action === "choose") return 0;
  if (action === "upload") return 1;
  if (action === "download") return 2;
  return 3;
}

function environmentDriftPageSize(): number {
  return Math.max(6, Math.min(14, (process.stdout.rows ?? 24) - 13));
}

interface EnvironmentCheckoutSource {
  repo: string;
  path: string;
  label: string;
  checkoutName: string | null;
}

async function updateEnvironmentFromCheckout(): Promise<void> {
  const source = await chooseEnvironmentCheckoutSource("Update from checkout");
  if (!source) return;
  const checkoutPath = await requireCleanCheckout(source);
  if (!checkoutPath) return;

  const paths = getPaths();
  const filePaths = await discoverEnvironmentFilePaths(checkoutPath);
  if (filePaths.length === 0) {
    clear();
    title("No Environment Files");
    console.log(`No untracked, ignored, assume-unchanged, or skip-worktree file(s) found for ${source.repo}.`);
    console.log("");
    await pause();
    return;
  }

  const profile = await chooseEnvironmentProfile(source.repo, true);
  if (!profile) return;
  const confirmed = await confirmPrompt({
    message: `Update ${filePaths.length} environment file(s) from ${source.label}?`,
    default: true,
  });
  if (!confirmed) return;

  await runCommand("Update Secrets", async () => {
    const result = await saveEnvironment({
      paths,
      repo: source.repo,
      profile,
      checkoutPath,
      filePaths,
    });
    console.log(`Updated ${result.saved.length} secret(s) for ${source.repo}.`);
  });
}

async function saveEnvironmentPathFromCheckout(): Promise<void> {
  const source = await chooseEnvironmentCheckoutSource("Save from checkout");
  if (!source) return;
  const checkoutPath = await requireCleanCheckout(source);
  if (!checkoutPath) return;

  let relPath: string;
  try {
    relPath = await inputPrompt({ message: "Repo-relative secret path" });
  } catch (err) {
    if (isBackSignal(err)) return;
    throw err;
  }

  const trimmed = relPath.trim();
  if (!trimmed) return;

  const confirmed = await confirmPrompt({
    message: `Save one secret path for ${source.repo}?`,
    default: true,
  });
  if (!confirmed) return;

  await runCommand("Save Secret", async () => {
    const result = await saveEnvironment({
      paths: getPaths(),
      repo: source.repo,
      profile: "default",
      checkoutPath,
      filePaths: [trimmed],
    });
    console.log(`Saved ${result.saved.length} secret(s) for ${source.repo}.`);
  });
}

async function restoreEnvironmentIntoCheckout(): Promise<void> {
  const source = await chooseEnvironmentCheckoutSource("Restore into checkout");
  if (!source) return;

  const profile = await chooseEnvironmentProfile(source.repo);
  if (!profile) return;

  const overwrite = await confirmPrompt({
    message: "Overwrite existing different files?",
    default: false,
  });

  await runCommand("Restore Secrets", async () => {
    const result = await restoreEnvironment({
      paths: getPaths(),
      repo: source.repo,
      profile,
      checkoutPath: source.path,
      overwrite,
    });
    console.log(`Restored ${result.restored.length} secret(s) for ${source.repo}.`);
    if (result.unchanged.length) console.log(`${result.unchanged.length} secret(s) already matched.`);
    if (result.refused.length) {
      console.log(`${result.refused.length} secret(s) refused.`);
      for (const refused of result.refused) console.log(`- ${refused.path}: ${refused.reason}`);
    }
  });
}

async function chooseEnvironmentCheckoutSource(message: string): Promise<EnvironmentCheckoutSource | null> {
  const checkouts = await scanCheckoutEntries();
  const choices: Array<Choice<string> | Separator> = [];
  if (checkouts.length) {
    const layout = checkoutListLayout(checkouts);
    choices.push(checkoutMenuHeader(layout));
    for (const [name, checkout] of checkouts) {
      choices.push({
        value: `checkout:${name}`,
        name: checkoutMenuLine(name, checkout, layout),
        short: name,
      });
    }
    choices.push(menuSection("Other"));
  }
  choices.push({ value: "manual", name: "Manual checkout path" });

  let selected: string;
  try {
    selected = await selectPrompt<string>({
      message,
      pageSize: 10,
      choices,
    });
  } catch (err) {
    if (isBackSignal(err)) return null;
    throw err;
  }

  if (selected.startsWith("checkout:")) {
    const name = selected.slice("checkout:".length);
    const checkout = await refreshCheckout(name);
    if (!checkout) return null;
    return {
      repo: checkout.repo,
      path: checkout.path,
      label: name,
      checkoutName: name,
    };
  }

  let checkoutPath: string;
  let repoArg: string;
  try {
    checkoutPath = await inputPrompt({ message: "Checkout path" });
    repoArg = await inputPrompt({ message: "Repo (owner/name or known repo name)" });
  } catch (err) {
    if (isBackSignal(err)) return null;
    throw err;
  }

  const resolvedPath = path.resolve(checkoutPath.trim());
  const repo = await resolveEnvironmentRepoForTui(repoArg.trim());
  return {
    repo,
    path: resolvedPath,
    label: resolvedPath,
    checkoutName: null,
  };
}

async function chooseEnvironmentProfile(repo: string, allowDefaultWhenMissing = false): Promise<string | null> {
  const profiles = await listEnvironmentProfiles(getPaths(), repo);
  if (profiles.length === 0) {
    if (allowDefaultWhenMissing) return "default";
    clear();
    title("No Saved Secrets");
    console.log(`No saved secrets for ${repo}.`);
    console.log("");
    await pause();
    return null;
  }
  if (profiles.length === 1) return profiles[0].profile;

  try {
    return await selectPrompt<string>({
      message: "Profile",
      choices: profiles.map((profile) => environmentProfileChoice(profile)),
    });
  } catch (err) {
    if (isBackSignal(err)) return null;
    throw err;
  }
}

function environmentProfileChoice(profile: EnvironmentProfileSummary): Choice<string> {
  return {
    value: profile.profile,
    name: `${profile.profile} (${profile.fileCount} secret(s))`,
    short: profile.profile,
  };
}

async function requireCleanCheckout(source: EnvironmentCheckoutSource): Promise<string | null> {
  const scanned = source.checkoutName ? await refreshCheckout(source.checkoutName) : await scanStandaloneCheckout(source);
  if (!scanned) return null;

  let checkoutPath: string | null = null;
  let problem =
    scanned.exists === false
      ? `Checkout path does not exist: ${source.path}`
      : scanned.scanError
        ? `Checkout scan failed: ${scanned.scanError}`
        : null;

  if (!problem) {
    try {
      checkoutPath = await assertEnvironmentCheckoutReady(source.path);
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
  }

  if (!problem) return checkoutPath;

  clear();
  title("Checkout Not Ready");
  console.log(problem);
  console.log(color.dim("Commit or discard tracked changes before updating saved secrets."));
  console.log("");
  await pause();
  return null;
}

async function scanStandaloneCheckout(source: EnvironmentCheckoutSource): Promise<CheckoutRecord> {
  const record: CheckoutRecord = {
    repo: source.repo,
    path: source.path,
    createdAt: new Date().toISOString(),
    branch: "",
    mode: "github",
    remoteUrl: null,
    lastScan: null,
    exists: null,
    dirty: null,
    ahead: null,
    behind: null,
    currentBranch: null,
    headSha: null,
    upstream: null,
    scanError: null,
  };
  return scanCheckout(record);
}

async function resolveEnvironmentRepoForTui(repoArg: string): Promise<string> {
  const state = await openStore(getPaths()).read();
  try {
    return resolveRepo(Object.values(state.repos), repoArg).fullName;
  } catch (err) {
    if (!repoArg.includes("/")) throw err;
    splitFullName(repoArg);
    return repoArg;
  }
}

function checkoutChoice(
  name: string,
  checkout: CheckoutRecord,
  layout: CheckoutListLayout,
): Choice<MainAction> {
  return {
    value: `checkout:${name}`,
    name: checkoutMenuLine(name, checkout, layout),
    short: name,
  };
}

function checkoutMenuHeader(layout: CheckoutListLayout): Separator {
  return new Separator(color.dim(`  ${checkoutMenuHeaderLine(layout)}`));
}

function checkoutMenuHeaderLine(layout: CheckoutListLayout): string {
  return (
    `${"Name".padEnd(layout.nameWidth)}  ` +
    `${"Branch".padEnd(layout.branchWidth)}  ` +
    "Status".padEnd(layout.statusWidth)
  );
}

function checkoutMenuLine(name: string, checkout: CheckoutRecord, layout: CheckoutListLayout): string {
  const status = fitText(checkoutStatusLabel(checkout), layout.statusWidth);
  const branch = fitText(checkoutBranch(checkout), layout.branchWidth);
  return (
    `${fitText(name, layout.nameWidth).padEnd(layout.nameWidth)}  ` +
    `${branch.padEnd(layout.branchWidth)}  ` +
    status.padEnd(layout.statusWidth)
  );
}

function checkoutListLayout(checkouts: [string, CheckoutRecord][]): CheckoutListLayout {
  const minNameWidth = 12;
  const minBranchWidth = 10;
  const maxBranchWidth = 40;
  const gapsWidth = 4;
  const rowWidth = Math.max(32, screenWidth() - 3);
  const desiredStatusWidth = maxTextLength(["Status", ...checkouts.map(([, checkout]) => checkoutStatusLabel(checkout))]);
  const desiredBranchWidth = Math.min(
    maxBranchWidth,
    maxTextLength(["Branch", ...checkouts.map(([, checkout]) => checkoutBranch(checkout))]),
  );
  const desiredNameWidth = maxTextLength(["Name", ...checkouts.map(([name]) => name)]);
  const desiredTotal = desiredNameWidth + desiredBranchWidth + desiredStatusWidth + gapsWidth;

  if (desiredTotal <= rowWidth) {
    return {
      nameWidth: desiredNameWidth,
      branchWidth: desiredBranchWidth,
      statusWidth: desiredStatusWidth,
    };
  }

  const statusWidth = Math.min(
    desiredStatusWidth,
    Math.max("Status".length, rowWidth - minNameWidth - minBranchWidth - gapsWidth),
  );
  const branchWidth = Math.min(
    desiredBranchWidth,
    Math.max(minBranchWidth, rowWidth - minNameWidth - statusWidth - gapsWidth),
  );
  const nameWidth = Math.max("Name".length, rowWidth - branchWidth - statusWidth - gapsWidth);
  return { nameWidth, branchWidth, statusWidth };
}

function maxTextLength(values: string[]): number {
  return values.reduce((max, value) => Math.max(max, value.length), 0);
}

function checkoutStatusLabel(checkout: CheckoutRecord): string {
  if (checkout.exists === false) return "missing";
  if (checkout.scanError) return "warning";
  if (checkout.dirty && (checkout.ahead ?? 0) > 0) return "dirty+unpushed";
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

  try {
    const paths = getPaths();
    const config = await loadConfig(paths);
    const store = openStore(paths);
    const profiles = await listEnvironmentProfiles(paths, repo.fullName);
    let environmentProfile: string | undefined;

    if (profiles.length > 0) {
      console.log(`${profiles.reduce((count, profile) => count + profile.fileCount, 0)} saved secret(s) available.`);
      const restoreSaved = await confirmPrompt({
        message: "Restore saved secrets into checkout?",
        default: true,
      });
      if (restoreSaved) {
        environmentProfile = profiles.length === 1
          ? profiles[0].profile
          : await selectPrompt<string>({
              message: "Profile",
              choices: profiles.map((profile) => environmentProfileChoice(profile)),
            });
      }
    }

    clear();
    title(`Checkout ${repoDisplayName(repo, true)}`);
    console.log(color.dim("Creating checkout..."));
    await createCheckout({
      store,
      paths,
      config,
      repoArg: repo.fullName,
      environmentProfile,
    });
  } catch (err) {
    if (isBackSignal(err)) return false;
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
  console.log(`Branch ${checkoutBranch(checkout)}`);
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
    console.log(`${checkoutStatus(checkout)}  ${checkout.repo}  ${checkoutBranch(checkout)}`);
    if (checkout.scanError) console.log(color.warn(`Warning  ${checkout.scanError}`));
    console.log(color.dim(checkout.path));
    console.log("");

    const canDiff = checkout.dirty === true;
    const canCommit = checkout.dirty === true;
    const canReset = checkout.dirty === true;

    if (!canDiff && !canCommit) {
      if ((checkout.ahead ?? 0) > 0) {
        console.log(color.dim("Checkout has unpushed commits. Push from your local shell using SSH credentials."));
      } else {
        console.log(color.dim("No local diff available."));
      }
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
          { value: "reset", name: "Reset", disabled: canReset ? false : "(no changes)" },
        ],
      });
    } catch (err) {
      if (isBackSignal(err)) return;
      throw err;
    }

    if (action === "diff") await showCheckoutDiff(name, checkout);
    else if (action === "commit") await commitCheckoutChanges(name, checkout);
    else if (action === "reset") {
      if (await resetCheckoutChanges(name, checkout)) return;
    }
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

async function resetCheckoutChanges(name: string, checkout: CheckoutRecord): Promise<boolean> {
  let confirmed: boolean;
  try {
    confirmed = await confirmPrompt({
      message: `Discard all uncommitted changes in ${name}?`,
      default: false,
    });
  } catch (err) {
    if (isBackSignal(err)) return false;
    throw err;
  }

  if (!confirmed) return false;

  await runCommand(`Reset ${name}`, async () => {
    const reset = await git(checkout.path, ["reset", "--hard", "HEAD"]);
    printProcessOutput(reset);
    const clean = await git(checkout.path, ["clean", "-fd"]);
    printProcessOutput(clean);
    const refreshed = await refreshCheckout(name);
    if (refreshed) console.log(`Status ${checkoutStatus(refreshed)}`);
  });
  return true;
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

async function pause(message = "Press ⏎ to continue"): Promise<void> {
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

async function selectPrompt<Value>(
  config: Parameters<typeof select<Value>>[0],
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
): Promise<Value> {
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
  return isPromptAbort(err, ESCAPE_ABORT_REASON);
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

function tuiTitleLines(): string[] {
  return ["", color.bold(TUI_TITLE), ""];
}

function screenWidth(): number {
  return Math.max(56, Math.min(100, process.stdout.columns ?? 88));
}

function clock(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function scheduleNextAutoSync(): number {
  return Date.now() + AUTO_SYNC_MS;
}

function timeUntil(timestamp: number): string {
  const ms = Math.max(0, timestamp - Date.now());
  if (ms < 1_000) return "now";

  const minutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours > 0 && remainingMinutes > 0) return `${hours}h ${remainingMinutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

function dashboardRowText(label: string, value: string, note?: string): string {
  let line = `${color.dim(label.padEnd(DASHBOARD_LABEL_WIDTH))}${value}`;
  if (!note) return line;

  const noteWidth = screenWidth() - DASHBOARD_LABEL_WIDTH - value.length - 2;
  if (noteWidth >= 12) line += `  ${color.dim(fitText(note, noteWidth))}`;
  return line;
}

function section(text: string): void {
  console.log(color.bold(text));
}

function attentionLine(line: string): string {
  const match = /^(danger|warn|info)\s+(.*)$/.exec(line);
  if (!match) return line;

  const [, level, message] = match;
  const formatted = `${level === "info" ? "i" : "!"} ${message.trim()}`;
  if (level === "danger") return color.danger(formatted);
  if (level === "warn") return color.warn(formatted);
  if (level === "info") return color.info(formatted);
  return line;
}
