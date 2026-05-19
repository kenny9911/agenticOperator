/**
 * Lightweight debug logger for `rule-check`.
 *
 * Output goes to stderr (so `--output json` on the CLI stays clean on stdout).
 *
 * Levels:
 *   - INFO  — always emitted; one-liner per stage with key params + timings.
 *   - DEBUG — gated by RULE_CHECK_DEBUG env (`1`/`true`/`verbose`/`all`).
 *             Prints payload digests, per-HTTP call summaries, per-rule
 *             validation/confidence breakdowns, etc.
 *   - WARN  — always emitted; abnormal-but-recoverable conditions.
 *
 * Format:  [rule-check:<scope>] <message>  (k=v k=v ...)
 *
 * Keep messages single-line and machine-parseable (key=value pairs) — easier
 * to grep, easier to ship to a log aggregator later.
 */
import { performance } from "node:perf_hooks";

const LEVEL_ORDER: Record<LogLevel, number> = { warn: 0, info: 1, debug: 2 };
type LogLevel = "warn" | "info" | "debug";

function envDebugEnabled(): boolean {
  const raw = process.env["RULE_CHECK_DEBUG"];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "verbose" || v === "all" || v === "debug";
}

const debugEnabled = envDebugEnabled();
const startTime = performance.now();

function elapsed(): string {
  const ms = Math.round(performance.now() - startTime);
  return `+${String(ms).padStart(5, " ")}ms`;
}

export function rcLog(
  level: LogLevel,
  scope: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] > (debugEnabled ? LEVEL_ORDER.debug : LEVEL_ORDER.info)) {
    return;
  }
  const head = `[rule-check:${scope}] ${elapsed()} ${level.toUpperCase().padEnd(5)} ${message}`;
  const kv = formatFields(fields);
  process.stderr.write(kv ? `${head}  ${kv}\n` : `${head}\n`);
}

export const rcInfo = (scope: string, msg: string, fields?: Record<string, unknown>) =>
  rcLog("info", scope, msg, fields);

export const rcDebug = (scope: string, msg: string, fields?: Record<string, unknown>) =>
  rcLog("debug", scope, msg, fields);

export const rcWarn = (scope: string, msg: string, fields?: Record<string, unknown>) =>
  rcLog("warn", scope, msg, fields);

/** True when RULE_CHECK_DEBUG is set — callers can skip expensive payload-snapshot prep. */
export const rcDebugEnabled = (): boolean => debugEnabled;

/** Returns a high-resolution "stopwatch" callable. */
export function rcStopwatch(): () => number {
  const t0 = performance.now();
  return () => Math.round(performance.now() - t0);
}

// ─── helpers ───

function formatFields(fields: Record<string, unknown> | undefined): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  return parts.join(" ");
}

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") {
    // Quote if contains whitespace / equals sign, else leave bare.
    if (/[\s=]/.test(v)) return JSON.stringify(v);
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (v.length <= 6) return JSON.stringify(v);
    return `[${v.slice(0, 6).map((x) => formatValue(x)).join(",")},…+${v.length - 6}]`;
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Truncated SHA-prefix helper, for compact display of long hashes. */
export function shortSha(hash: string | undefined, n = 12): string {
  if (!hash) return "—";
  return hash.length > n ? `${hash.slice(0, n)}…` : hash;
}
