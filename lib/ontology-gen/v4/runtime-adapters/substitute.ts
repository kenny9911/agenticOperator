/**
 * Single-scan placeholder substitution.
 *
 * Builds one regex matching every placeholder (sorted long-to-short to prevent
 * a short token from swallowing a longer one, e.g. `{{CLIENT}}` vs hypothetical
 * `{{CLIENT_LIST}}`) and runs `String.prototype.replace` exactly once. Because
 * the scan visits each position at most once, any `{{...}}` substring that
 * happens to appear inside a *replacement value* will NOT be re-substituted.
 *
 * This is a behavior fix over the legacy multi-pass `replaceAll` chain: the
 * old reverse-order trick reduced but did not eliminate that re-substitution
 * hazard.
 */

export function substitute(
  prompt: string,
  subs: Record<string, string>,
): string {
  const keys = Object.keys(subs);
  if (keys.length === 0) return prompt;
  const sorted = [...keys].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(sorted.map(escapeRegex).join("|"), "g");
  return prompt.replace(pattern, (m) => (m in subs ? subs[m] : m));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
