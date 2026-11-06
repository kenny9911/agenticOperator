// Shared helpers for allmeta writers.

import { writeInstance, AllmetaApiError } from '@/lib/allmeta-client';

export type WriteResult =
  | { ok: true; instance: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Soft-fail wrapper around allmeta writeInstance.
 * Returns { ok, error } instead of throwing so agents can log + continue.
 */
export async function safeWriteInstance(
  label: string,
  payload: Record<string, unknown>,
): Promise<WriteResult> {
  try {
    const r = await writeInstance(label, payload);
    return { ok: true, instance: r as unknown as Record<string, unknown> };
  } catch (e) {
    const msg =
      e instanceof AllmetaApiError
        ? `${e.status} ${e.message}`
        : (e as Error).message ?? String(e);
    return { ok: false, error: msg.slice(0, 400) };
  }
}

/** Return only defined / non-null values (allmeta accepts loose payloads but cleaner). */
export function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export function nonEmptyString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim();
  return null;
}

export function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  }
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

export function asNumberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function asIsoDateOrNull(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
