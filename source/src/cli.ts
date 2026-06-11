#!/usr/bin/env node
import "dotenv/config";
import { Command } from "commander";
import { authCheck, authCommand } from "./commands/auth.js";
import { listCommand } from "./commands/list.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";

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
  .description("Refresh inventory and mirror all repos (or just the named ones)")
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
  .command("status")
  .description("Show backup health")
  .option("--oneline", "single machine-readable line for prompts/scripts")
  .action(async (opts: { oneline?: boolean }) => {
    await statusCommand(opts);
  });

// Default command (bare `strappy`) — the interactive TUI is Milestone 4; for
// now, surface status and point at the available commands.
program.action(async () => {
  await statusCommand({});
  console.log("\nCommands: auth · sync · list · status   (try `strappy --help`)");
});

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`strappy: ${message}\n`);
  process.exitCode = 1;
});
