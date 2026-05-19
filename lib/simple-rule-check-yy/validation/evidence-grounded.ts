/**
 * Validation #2 — every Evidence entry must reference (objectType, objectId,
 * field, value) that exists in `fetched.instances`. Catches:
 *   - LLM cites an instance we never fetched (hallucinated object id)
 *   - LLM cites a field that doesn't exist on the instance (made-up property)
 *   - LLM's value doesn't match what we fetched (misread / fabricated value)
 *
 * Field-path syntax (JSONPath-lite) supported:
 *   - `foo`                    → data.foo
 *   - `foo.bar`                → data.foo.bar
 *   - `foo[0]`                 → data.foo[0]
 *   - `foo[0].bar`             → data.foo[0].bar
 *   - `foo.0.bar`              → equivalent to `foo[0].bar`
 *
 * Equality on values is deep — primitives must be ===, objects/arrays must
 * match structurally.
 */

import type { Evidence, Instance } from "../types";

export interface EvidenceCheckOutput {
  ok: boolean;
  failures: string[];
}

export function checkEvidenceGrounded(
  evidence: Evidence[],
  fetchedInstances: Instance[],
): EvidenceCheckOutput {
  const failures: string[] = [];

  for (let i = 0; i < evidence.length; i++) {
    const ev = evidence[i]!;
    const tag = `evidence[${i}]`;

    const inst = fetchedInstances.find(
      (x) => x.objectType === ev.objectType && x.objectId === ev.objectId,
    );
    if (!inst) {
      failures.push(`${tag}_unknown_instance:${ev.objectType}/${ev.objectId}`);
      continue;
    }
    const resolved = resolveFieldPath(inst.data, ev.field);
    if (!resolved.found) {
      failures.push(`${tag}_unknown_field:${ev.objectType}.${ev.field}`);
      continue;
    }
    if (!deepEqual(resolved.value, ev.value)) {
      failures.push(
        `${tag}_value_mismatch:${ev.objectType}.${ev.field}`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

// ─── path resolver ───

/**
 * Walk `data` along a JSONPath-lite expression. Returns `{ found: false }` if
 * any segment is missing (property absent, array index out of range, null
 * pivot, etc.). Otherwise returns the leaf value (which may be `undefined`
 * if the field exists but is null/undefined explicitly).
 *
 * Tokenization:
 *   - Split on `.`
 *   - Each part may be `name[i][j]...` — unwrap each `[N]` into a separate
 *     numeric segment after `name`
 *   - Pure-numeric segments (e.g. `"0"`) act as array indices when the
 *     pivot is an array
 */
export function resolveFieldPath(
  data: unknown,
  path: string,
): { found: boolean; value: unknown } {
  const tokens = tokenizePath(path);
  if (tokens.length === 0) return { found: false, value: undefined };

  let cur: unknown = data;
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };

    if (Array.isArray(cur)) {
      const idx = toArrayIndex(tok);
      if (idx === null || idx < 0 || idx >= cur.length) {
        return { found: false, value: undefined };
      }
      cur = cur[idx];
      continue;
    }

    if (typeof cur === "object") {
      const key = String(tok);
      const obj = cur as Record<string, unknown>;
      if (!(key in obj)) return { found: false, value: undefined };
      cur = obj[key];
      continue;
    }

    // Pivot is a primitive but there are still tokens to walk — path is invalid.
    return { found: false, value: undefined };
  }

  return { found: true, value: cur };
}

function tokenizePath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const segment of path.split(".")) {
    if (segment === "") continue;
    // Match `name[0][1]...` where name may contain anything but `[`.
    const m = segment.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (m) {
      const name = m[1] ?? "";
      const indices = m[2] ?? "";
      if (name !== "") out.push(name);
      if (indices.length > 0) {
        const re = /\[(\d+)\]/g;
        let im: RegExpExecArray | null;
        while ((im = re.exec(indices)) !== null) {
          out.push(parseInt(im[1]!, 10));
        }
      }
    } else {
      // Unparseable segment — push as-is and let downstream key-lookup fail.
      out.push(segment);
    }
  }
  return out;
}

function toArrayIndex(tok: string | number): number | null {
  if (typeof tok === "number") return Number.isInteger(tok) ? tok : null;
  if (/^\d+$/.test(tok)) return parseInt(tok, 10);
  return null;
}

// ─── deep equality ───

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual(ao[k], bo[k]));
}
