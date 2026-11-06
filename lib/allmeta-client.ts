// Allmeta Ontology API HTTP client (v0_1_010)
//
// Single entry for AO to write/read instance data through Allmeta studio (:3500).
// Allmeta is the only path to Neo4j instance data (per ADR-0011 + alignment doc §1).

import { currentLogger } from '@/lib/agent-logger';
import { logApiCall } from '@/lib/external-api-log';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';

// Read at module load. No silent localhost fallback for the base URL —
// a partner whose .env.local is half-configured used to get cryptic
// "connection refused 127.0.0.1:3500" errors deep inside an agent run;
// throwing a clear "ALLMETA_BASE_URL is not configured" message at the
// first call point is much easier to diagnose. Empty string keeps module
// load side-effect-free so importing this file in a misconfigured env
// doesn't crash the whole server boot.
const DEFAULT_BASE_URL = process.env.ALLMETA_BASE_URL ?? '';
const DEFAULT_DOMAIN = process.env.ALLMETA_DOMAIN ?? RECRUITMENT_DOMAIN_ID;
const API_KEY = process.env.ALLMETA_API_KEY ?? '';

// Label = first 2 URL segments, e.g. "allmeta.POST /api/v1/ontology/instances".
function callLabel(method: string, path: string): string {
  const trimmed = path.split('?')[0];
  const segs = trimmed.split('/').filter(Boolean);
  // /api/v1/ontology/{resource}/{id?} — group by /{resource}, drop {id}
  const groupedPath = segs.slice(0, 4).join('/');
  return `allmeta.${method} /${groupedPath}`;
}

export type AllmetaError = {
  status: number;
  error: string;
  details?: Record<string, unknown>;
  body?: unknown;
};

export class AllmetaApiError extends Error {
  status: number;
  details?: Record<string, unknown>;
  body?: unknown;

  constructor(payload: AllmetaError) {
    super(`Allmeta ${payload.status} ${payload.error}`);
    this.name = 'AllmetaApiError';
    this.status = payload.status;
    this.details = payload.details;
    this.body = payload.body;
  }
}

type CommonOpts = {
  baseUrl?: string;
  domain?: string;
  timeoutMs?: number;
  validateStrict?: boolean;
};

async function doRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  opts: CommonOpts = {},
): Promise<T> {
  const rawBase = opts.baseUrl ?? DEFAULT_BASE_URL;
  if (!rawBase) {
    throw new Error(
      'ALLMETA_BASE_URL is not configured. Set it in .env.local (e.g. http://localhost:3500).',
    );
  }
  const baseUrl = rawBase.replace(/\/+$/, '');
  const url = `${baseUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (API_KEY) headers['Authorization'] = `Bearer ${API_KEY}`;

  const logger = currentLogger();
  const label = callLabel(method, path);
  const start = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // 独立 sink — 不依赖 ALS,Inngest step.run 内部也能稳定记录(网络/abort 错)
    logApiCall({
      category: 'allmeta',
      label,
      url,
      method,
      duration_ms: Date.now() - start,
      request: body,
      error: (err as Error).message,
    });
    // Network / abort error — nothing to parse, but still emit a log line so
    // the agent file shows "we tried, it never connected".
    logger?.apiCall(label, {
      url,
      method,
      request: body,
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const rawText = await res.text();
  let parsed: unknown;
  try {
    parsed = rawText ? JSON.parse(rawText) : undefined;
  } catch {
    parsed = rawText;
  }

  // 独立 sink — 完整 in/out,绕过 ALS
  logApiCall({
    category: 'allmeta',
    label,
    url,
    method,
    status: res.status,
    duration_ms: Date.now() - start,
    request: body,
    response: parsed,
    ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
  });
  logger?.apiCall(label, {
    url,
    method,
    request: body,
    status: res.status,
    durationMs: Date.now() - start,
    response: parsed,
    ...(res.ok ? {} : { error: `HTTP ${res.status}` }),
  });

  if (!res.ok) {
    const errObj = (parsed as Record<string, unknown>) ?? {};
    throw new AllmetaApiError({
      status: res.status,
      error: typeof errObj.error === 'string' ? (errObj.error as string) : res.statusText,
      details: errObj.details as Record<string, unknown> | undefined,
      body: parsed,
    });
  }

  return parsed as T;
}

// ──────────────────────────────────────────────────────────────
//  Instance CRUD
// ──────────────────────────────────────────────────────────────

export type WriteInstanceResponse = {
  upserted?: string[];
  count?: number;
  [k: string]: unknown;
};

/**
 * POST /api/v1/ontology/instances/{label}?domain=RAAS-v1
 *
 * `payload` must already match the DataObject's `properties[]` exactly — extra
 * fields trigger 400 validation-failed (this is what alignment doc §1.2 is about).
 */
export async function writeInstance(
  label: string,
  payload: Record<string, unknown>,
  opts: CommonOpts = {},
): Promise<WriteInstanceResponse> {
  const domain = opts.domain ?? DEFAULT_DOMAIN;
  const strict = opts.validateStrict ? '&validate=strict' : '';
  const path = `/api/v1/ontology/instances/${encodeURIComponent(label)}?domain=${encodeURIComponent(domain)}${strict}`;
  return doRequest<WriteInstanceResponse>(
    'POST',
    path,
    { ...payload, domainId: domain },
    opts,
  );
}

export async function getInstance<T = Record<string, unknown>>(
  label: string,
  pk: string,
  opts: CommonOpts = {},
): Promise<T | null> {
  const domain = opts.domain ?? DEFAULT_DOMAIN;
  const path = `/api/v1/ontology/instances/${encodeURIComponent(label)}/${encodeURIComponent(pk)}?domain=${encodeURIComponent(domain)}`;
  try {
    return await doRequest<T>('GET', path, undefined, opts);
  } catch (err) {
    if (err instanceof AllmetaApiError && err.status === 404) return null;
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────
//  Link (relationship) CRUD
// ──────────────────────────────────────────────────────────────

export type WriteLinkInput = {
  source_label: string;
  source_id: string;
  target_label: string;
  target_id: string;
  relationship: string; // e.g. "HAS_RESUME" / "EVALUATED_FOR"
};

export async function writeLink(
  link: WriteLinkInput,
  opts: CommonOpts = {},
): Promise<{ created?: boolean; [k: string]: unknown }> {
  const domain = opts.domain ?? DEFAULT_DOMAIN;
  return doRequest('POST', `/api/v1/ontology/links?domain=${encodeURIComponent(domain)}`, {
    domainId: domain,
    ...link,
  }, opts);
}

// ──────────────────────────────────────────────────────────────
//  DataObject schema introspection (sanity check)
// ──────────────────────────────────────────────────────────────

export async function getDataObjectSchema(
  label: string,
  opts: CommonOpts = {},
): Promise<{ properties?: Array<{ name: string; type: string }>; [k: string]: unknown }> {
  const path = `/api/v1/ontology/dataobjects/${encodeURIComponent(label)}`;
  return doRequest('GET', path, undefined, opts);
}

// ──────────────────────────────────────────────────────────────
//  Health
// ──────────────────────────────────────────────────────────────

export async function ping(opts: CommonOpts = {}): Promise<{ ok: boolean }> {
  try {
    await doRequest('GET', '/health', undefined, opts);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ──────────────────────────────────────────────────────────────
//  Entity search (read-only, used by global tracing chatbot)
// ──────────────────────────────────────────────────────────────

export type EntitySearchResult = {
  id: string;
  displayName: string;
  [k: string]: unknown;
};

/** Placeholder names that the writer uses when no real name is available.
 *  Treat these as "no name" so the chatbot falls back to id-suffix. */
const PLACEHOLDER_NAMES = new Set(["未命名候选人", "未命名", "Unknown", "unknown", ""]);

/** Per-entity-type ordered list of candidate fields to look at for display name. */
const NAME_FIELDS_BY_TYPE: Record<string, string[]> = {
  Candidate: ["name"],
  Resume: ["summary"], // resume has no name; fall through to filename derived below
  Job_Requisition: ["title", "position_name", "jr_name"],
  Job_Posting: ["title", "posting_title"],
  Client: ["client_name", "name"],
  // default fall-through: try common fields
};

/**
 * Extracts a display name from a raw allmeta instance row, trying multiple
 * fields in priority order. Returns null when nothing usable is found
 * (caller should fall back to id-suffix).
 */
export function pickDisplayName(type: string, row: Record<string, unknown>): string | null {
  // Allmeta may have set displayName explicitly — prefer that first
  if (typeof row.displayName === "string" && row.displayName.trim()) {
    const v = row.displayName.trim();
    if (!PLACEHOLDER_NAMES.has(v)) return v;
  }
  const fields = NAME_FIELDS_BY_TYPE[type] ?? ["name", "title"];
  for (const f of fields) {
    const v = row[f];
    if (typeof v === "string" && v.trim()) {
      const trimmed = v.trim();
      if (!PLACEHOLDER_NAMES.has(trimmed)) {
        // For Resume.summary, take only the first line and truncate
        if (type === "Resume" && f === "summary") {
          const firstLine = trimmed.split(/\r?\n/)[0].trim();
          if (firstLine) return firstLine.length > 40 ? firstLine.slice(0, 40) + "…" : firstLine;
        } else {
          return trimmed;
        }
      }
    }
  }
  // Resume special case: derive from file_path filename
  if (type === "Resume" && typeof row.file_path === "string" && row.file_path.trim()) {
    const fp = row.file_path.trim();
    const parts = fp.split(/[/\\]/);
    const filename = parts[parts.length - 1] || "";
    // strip extension
    const stem = filename.replace(/\.[^.]+$/, "").trim();
    if (stem) return stem.length > 40 ? stem.slice(0, 40) + "…" : stem;
  }
  return null;
}

/** Pick the canonical id field for the given type from a raw row. */
export function pickId(type: string, row: Record<string, unknown>): string | null {
  // try type-specific id field first
  const typeIdField = type.toLowerCase() + "_id";
  const v1 = row[typeIdField];
  if (typeof v1 === "string" && v1.trim()) return v1.trim();
  // generic fallback
  const v2 = row.id;
  if (typeof v2 === "string" && v2.trim()) return v2.trim();
  return null;
}

/**
 * GET /api/v1/ontology/instances/{label}?domain=...&q=...&limit=...
 *
 * Thin read-only helper for global-chat-tools. Returns an array of matching
 * entity instances from Neo4j via Allmeta. On any error (network / 4xx / 5xx)
 * returns an empty array so the chatbot degrades gracefully.
 */
export async function searchEntitiesNeo4j(
  { type, q, limit = 10 }: { type: string; q: string; limit?: number },
  opts: CommonOpts = {},
): Promise<EntitySearchResult[]> {
  const domain = opts.domain ?? DEFAULT_DOMAIN;
  const label = encodeURIComponent(type);
  const qs = new URLSearchParams({
    domain,
    q,
    limit: String(Math.min(limit, 30)),
  }).toString();
  const path = `/api/v1/ontology/instances/${label}?${qs}`;
  try {
    const res = await doRequest<unknown>('GET', path, undefined, opts);
    const rawRows: Array<Record<string, unknown>> =
      Array.isArray(res) ? (res as any) :
      Array.isArray((res as any)?.items) ? (res as any).items :
      Array.isArray((res as any)?.data) ? (res as any).data :
      [];
    return rawRows
      .map((row) => {
        const id = pickId(type, row);
        if (!id) return null;
        const dn = pickDisplayName(type, row) ?? id; // last resort: use id literally
        return { id, displayName: dn, ...row } as EntitySearchResult;
      })
      .filter((x): x is EntitySearchResult => x !== null);
  } catch {
    return [];
  }
}

/**
 * Resolve display names for a batch of entity ids.
 * Uses searchEntitiesNeo4j with q=id and exact-id matching.
 * Returns a Map<id, displayName>. Missing ids are simply absent from the map.
 * Failures degrade silently (returns whatever resolved before the failure).
 */
export async function resolveEntityNames(
  type: string,
  ids: string[],
  opts: CommonOpts = {},
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const unique = Array.from(new Set(ids.filter((x): x is string => typeof x === "string" && x.length > 0)));
  // Bounded concurrency 5 to avoid hammering the API
  const CONC = 5;
  for (let i = 0; i < unique.length; i += CONC) {
    const slice = unique.slice(i, i + CONC);
    const results = await Promise.all(
      slice.map(async (id) => {
        try {
          const hits = await searchEntitiesNeo4j({ type, q: id, limit: 1 }, opts);
          const match = hits.find((h) => h.id === id) ?? hits[0];
          if (!match) return null;
          // Drop if displayName is literally === id (means pickDisplayName returned null and fell through)
          if (match.displayName === id) return null;
          return [id, match.displayName] as const;
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r) out.set(r[0], r[1]);
    }
  }
  return out;
}
