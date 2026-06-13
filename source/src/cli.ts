#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { authCheck, authCommand } from "./commands/auth.js";
import { checkoutCommand } from "./commands/checkout.js";
import { checkoutsCommand } from "./commands/checkouts.js";
import { cleanupCommand } from "./commands/cleanup.js";
import { enrichCommand } from "./commands/enrich.js";
import { infoCommand } from "./commands/info.js";
import { listCommand } from "./commands/list.js";
import { scanCheckoutsCommand } from "./commands/scan-checkouts.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";
import { runTui } from "./tui.js";

const program = new Command();

program
  .name("strappy")
  .description("Durable bare mirrors of all your GitHub repos, plus ephemeral checkouts.")
  .version("0.1.0");

program
  .command("auth")
  .description("Store/refresh the GitHub token (or check the current one)")
  .option("--token <token>", "use this token instead of prompting")
  .option("--from-gh", "import the token from `gh auth token`")
  .option("--check", "report which token strappy would use, without changing it")
  .action(async (opts: { token?: string; fromGh?: boolean; check?: boolean }) => {
    if (opts.check) await authCheck();
    else await authCommand({ token: opts.token, fromGh: opts.fromGh });
  });

program
  .command("sync")
  .description("Refresh inventory, mirrors, stale enrichment, and Tier-3 files")
  .argument("[repos...]", 'repos to sync, e.g. "owner/name" or "name"')
  .action(async (repos: string[]) => {
    await syncCommand(repos);
  });

program
  .command("list")
  .description("List mirrored repos")
  .option("--stale", "only repos not synced within the freshness window")
  .option("--orphaned", "only repos gone from GitHub (mirror kept)")
  .action(async (opts: { stale?: boolean; orphaned?: boolean }) => {
    await listCommand(opts);
  });

program
  .command("enrich")
  .description("Fetch per-repo extras from GitHub (languages, releases, branches, README…)")
  .argument("[repos...]", 'repos to enrich, e.g. "owner/name" or "name" (default: all stale)')
  .option("--force", "refetch even if the stored data is still fresh")
  .action(async (repos: string[], opts: { force?: boolean }) => {
    await enrichCommand(repos, opts);
  });

program
  .command("info")
  .description("Show everything strappy knows about one repo")
  .argument("<repo>", '"owner/name" or "name"')
  .option("--json", "machine-readable output (large file bodies elided unless --full)")
  .option("--full", "with --json, include the raw API object and full file bodies")
  .action(async (repo: string, opts: { json?: boolean; full?: boolean }) => {
    await infoCommand(repo, opts);
  });

program
  .command("status")
  .description("Show backup health")
  .option("--oneline", "single machine-readable line for prompts/scripts")
  .action(async (opts: { oneline?: boolean }) => {
    await statusCommand(opts);
  });

program
  .command("checkout")
  .description("Create a disposable checkout under /repo/checkouts")
  .argument("<repo>", '"owner/name" or "name"')
  .option("--branch <branch>", "branch to checkout (default: repo default branch)")
  .option("--name <name>", "checkout registry name and default directory name")
  .option("--path <path>", "custom checkout path")
  .action(async (repo: string, opts: { branch?: string; name?: string; path?: string }) => {
    await checkoutCommand(repo, opts);
  });

program
  .command("checkouts")
  .description("List registered checkouts with dirty/unpushed status")
  .option("--dirty", "only dirty checkouts")
  .option("--unpushed", "only checkouts with commits not on a remote")
  .option("--json", "machine-readable output")
  .action(async (opts: { dirty?: boolean; unpushed?: boolean; json?: boolean }) => {
    await checkoutsCommand(opts);
  });

program
  .command("scan-checkouts")
  .description("Refresh dirty/unpushed status for registered checkouts")
  .argument("[names...]", "checkout names to scan (default: all)")
  .option("--all", "scan all checkouts")
  .action(async (names: string[], opts: { all?: boolean }) => {
    await scanCheckoutsCommand(names, opts);
  });

program
  .command("cleanup")
  .description("Delete safe disposable checkouts")
  .argument("[name]", "checkout name to remove")
  .option("--all", "cleanup all safe checkouts")
  .option("--force", "delete even with dirty or unpushed work")
  .action(async (name: string | undefined, opts: { all?: boolean; force?: boolean }) => {
    await cleanupCommand(name, opts);
  });

program.action(async () => {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    await runTui();
    return;
  }

  await statusCommand({});
  console.log("\nNon-interactive shell detected. Run `strappy` in a TTY for the interactive UI.");
});

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`strappy: ${message}\n`);
  process.exitCode = 1;
});
