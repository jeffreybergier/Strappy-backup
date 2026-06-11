/** Human-friendly "time ago" from an ISO timestamp. */
export function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** KiB -> human size. */
export function humanSize(kb: number | null): string {
  if (kb === null) return "-";
  if (kb < 1024) return `${kb} KiB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MiB`;
  return `${(mb / 1024).toFixed(2)} GiB`;
}

/** Parse a duration like "14d", "12h", "30m" into milliseconds. */
export function parseAge(input: string): number {
  const m = /^(\d+)\s*([smhdw])$/.exec(input.trim());
  if (!m) throw new Error(`Invalid age "${input}" (use forms like 30m, 12h, 14d, 2w).`);
  const n = parseInt(m[1], 10);
  const unit = m[2];
  const factor = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[unit]!;
  return n * factor;
}
