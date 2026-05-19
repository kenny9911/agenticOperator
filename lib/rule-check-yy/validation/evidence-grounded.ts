/**
 * Validation #2 — evidence grounding for audit-rich judgments.
 *
 * Same logic as MVP, but:
 *   - Sets `evidence[i].grounded = true|false` in-place on the parsed judgment
 *     so the audit-rich schema's per-evidence flag is honored downstream.
 *   - Also validates `evidence[i].fetchedInstanceIndex` matches the resolved
 *     instance's position in the fetched array.
 */

import type { Instance } from "../types";
import type { EvidenceAudited } from "../types-audited";

export interface EvidenceCheckOutput {
  ok: boolean;
  failures: string[];
}

export function checkEvidenceGroundedAudited(
  evidence: EvidenceAudited[],
  fetchedInstances: Instance[],
): EvidenceCheckOutput {
  const failures: string[] = [];

  for (let i = 0; i < evidence.length; i++) {
    const ev = evidence[i]!;
    const tag = `evidence[${i}]`;
    let grounded = false;

    const instIdx = fetchedInstances.findIndex(
      (x) => x.objectType === ev.objectType && x.objectId === ev.objectId,
    );
    if (instIdx < 0) {
      failures.push(`${tag}_unknown_instance:${ev.objectType}/${ev.objectId}`);
      ev.grounded = false;
      continue;
    }
    const inst = fetchedInstances[instIdx]!;

    // Cross-check the LLM's claimed fetchedInstanceIndex.
    if (typeof ev.fetchedInstanceIndex === "number" && ev.fetchedInstanceIndex !== instIdx) {
      failures.push(
        `${tag}_fetched_instance_index_mismatch:claimed=${ev.fetchedInstanceIndex}/actual=${instIdx}`,
      );
    }

    const resolved = resolveFieldPath(inst.data, ev.field);
    if (!resolved.found) {
      failures.push(`${tag}_unknown_field:${ev.objectType}.${ev.field}`);
      ev.grounded = false;
      continue;
    }
    if (!deepEqual(resolved.value, ev.value)) {
      failures.push(`${tag}_value_mismatch:${ev.objectType}.${ev.field}`);
      ev.grounded = false;
      continue;
    }

    grounded = true;
    ev.grounded = grounded;
  }

  return { ok: failures.length === 0, failures };
}

// ─── path resolver (JSONPath-lite, same as MVP) ───

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

    return { found: false, value: undefined };
  }

  return { found: true, value: cur };
}

function tokenizePath(path: string): (string | number)[] {
  const out: (string | number)[] = [];
  for (const segment of path.split(".")) {
    if (segment === "") continue;
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
