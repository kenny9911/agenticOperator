/**
 * Shared render helpers for adapter authors + core.
 *
 * Keep this module dependency-free; everything here is pure formatting.
 */

/** Wrap a value in a ```json``` fenced code block via `JSON.stringify(v, null, 2)`. */
export function renderJsonBlock(v: unknown): string {
  return "```json\n" + JSON.stringify(v, null, 2) + "\n```";
}

/**
 * Format a `Date` as ISO-8601 in Beijing time (UTC+8 / Asia/Shanghai), with
 * a trailing zone hint for readability.
 *
 * Example output: `2026-05-11T14:30:00+08:00 (Asia/Shanghai)`
 *
 * Used by `fillRuntimeInput` to substitute the universal `{{CURRENT_TIME}}`
 * placeholder at fill time, so prompts always carry a fresh "current time"
 * regardless of when the snapshot was generated.
 *
 * Implementation note: `Intl.DateTimeFormat` does not directly emit ISO,
 * so we use it only to extract Asia/Shanghai wall-clock parts, then format
 * them ourselves. Asia/Shanghai has no DST, so the offset is always +08:00.
 */
export function formatBeijingTimeISO(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}+08:00 (Asia/Shanghai)`;
}
