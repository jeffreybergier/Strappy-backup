import fs from "node:fs";
import path from "node:path";

type Level = "INFO" | "WARN" | "ERROR";
export type LogSink = (line: string, level: Level) => void;

/**
 * Minimal logger: appends timestamped lines to STRAPPY_HOME/logs/strappy.log
 * and mirrors them to the console. The same log is shared by the CLI and the
 * daemon (Milestone 2), so each line is tagged with the source.
 */
export class Logger {
  private stream: fs.WriteStream | null = null;

  constructor(
    private readonly logFile: string,
    private readonly source: string = "cli",
    private readonly echo: boolean = true,
    private readonly onLine?: LogSink,
  ) {}

  private write(level: Level, msg: string): void {
    const line = `${new Date().toISOString()} [${this.source}] ${level} ${msg}`;
    try {
      this.onLine?.(line, level);
    } catch {
      // Logging sinks are best-effort, same as file writes.
    }
    if (this.echo) {
      const out = level === "ERROR" || level === "WARN" ? process.stderr : process.stdout;
      out.write(line + "\n");
    }
    try {
      if (!this.stream) {
        fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
        this.stream = fs.createWriteStream(this.logFile, { flags: "a" });
      }
      this.stream.write(line + "\n");
    } catch {
      // Never let logging failures break a sync run.
    }
  }

  info(msg: string): void {
    this.write("INFO", msg);
  }
  warn(msg: string): void {
    this.write("WARN", msg);
  }
  error(msg: string): void {
    this.write("ERROR", msg);
  }
}
