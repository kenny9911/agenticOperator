/**
 * Instance fetching from the Ontology API (`/api/v1/ontology/instances/...`).
 *
 * Returns the typed `Instance = { objectType, objectId, data }` shape used by
 * the rest of the simple-rule-check pipeline.
 *
 * Real ontology labels used here (verified via `GET /api/v1/ontology/objects/`):
 *   - Candidate           pk = candidate_id
 *   - Resume              pk = resume_id           (carries `work_experience` string + `skill_tags` list)
 *   - Job_Requisition     pk = job_requisition_id
 *   - Application         pk = application_id      (the "ApplicationHistory" of the SPEC; status + push_timestamp)
 *   - Blacklist           pk = blacklist_id        (the "BlacklistRecord" of the SPEC)
 *
 * Property-bag inflation: the Ontology API's "flatten rule" can JSON-stringify
 * complex fields. `inflateData` undoes this defensively so downstream
 * consumers see structured arrays/objects.
 */

import { getJson } from "../ontology-gen/client";

import type { Instance } from "./types";

export interface FetchInstanceCtx {
  apiBase: string;
  apiToken: string;
  domain: string;
  timeoutMs?: number;
}

const PK_BY_LABEL: Record<string, string> = {
  Candidate: "candidate_id",
  Candidate_Expectation: "candidate_expectation_id",
  Resume: "resume_id",
  Job_Requisition: "job_requisition_id",
  Application: "application_id",
  Blacklist: "blacklist_id",
};

function pkFieldFor(label: string): string {
  return PK_BY_LABEL[label] ?? "id";
}

export async function fetchCandidate(
  id: string,
  ctx: FetchInstanceCtx,
): Promise<Instance> {
  return fetchSingleInstance("Candidate", id, ctx);
}

export async function fetchJob(
  ref: string,
  ctx: FetchInstanceCtx,
): Promise<Instance> {
  return fetchSingleInstance("Job_Requisition", ref, ctx);
}

/** List Resume(s) for a candidate. Real ontology stores resumes 1-to-many per candidate;
 *  we list-filter by `candidate_id` and return all matches. */
export async function listResumes(
  candidateId: string,
  ctx: FetchInstanceCtx,
): Promise<Instance[]> {
  const params = new URLSearchParams({
    domain: ctx.domain,
    candidate_id: candidateId,
  });
  const path = `/api/v1/ontology/instances/Resume?${params.toString()}`;
  const raw = await getJson({
    apiBase: ctx.apiBase,
    apiToken: ctx.apiToken,
    path,
    timeoutMs: ctx.timeoutMs,
  });
  const list = normalizeListResponse(raw);
  return list.map((row) => buildInstance("Resume", row));
}

/** List Candidate_Expectation record(s) for a candidate. */
export async function listCandidateExpectations(
  candidateId: string,
  ctx: FetchInstanceCtx,
): Promise<Instance[]> {
  const params = new URLSearchParams({
    domain: ctx.domain,
    candidate_id: candidateId,
  });
  const path = `/api/v1/ontology/instances/Candidate_Expectation?${params.toString()}`;
  const raw = await getJson({
    apiBase: ctx.apiBase,
    apiToken: ctx.apiToken,
    path,
    timeoutMs: ctx.timeoutMs,
  });
  const list = normalizeListResponse(raw);
  return list.map((row) => buildInstance("Candidate_Expectation", row));
}

export interface ApplicationFilter {
  candidateId: string;
  jobRequisitionId?: string;
  /** `Application` has `client_id` FK; pass the client's id (not name) when filtering. */
  clientId?: string;
  /** ISO-8601 lower bound on `push_timestamp` (inclusive). */
  sinceDate?: string;
}

export async function listApplications(
  filter: ApplicationFilter,
  ctx: FetchInstanceCtx,
): Promise<Instance[]> {
  const params = new URLSearchParams({
    domain: ctx.domain,
    candidate_id: filter.candidateId,
  });
  if (filter.jobRequisitionId) params.set("job_requisition_id", filter.jobRequisitionId);
  if (filter.clientId) params.set("client_id", filter.clientId);
  const path = `/api/v1/ontology/instances/Application?${params.toString()}`;

  const raw = await getJson({
    apiBase: ctx.apiBase,
    apiToken: ctx.apiToken,
    path,
    timeoutMs: ctx.timeoutMs,
  });
  const list = normalizeListResponse(raw);
  let instances = list.map((row) => buildInstance("Application", row));

  if (filter.sinceDate) {
    const since = new Date(filter.sinceDate).getTime();
    instances = instances.filter((inst) => {
      const v = inst.data["push_timestamp"];
      if (typeof v !== "string" && typeof v !== "number") return true;
      const t = new Date(v as string | number).getTime();
      return Number.isFinite(t) ? t >= since : true;
    });
  }
  return instances;
}

export interface BlacklistFilter {
  candidateId: string;
  /** Filter by client_id (FK on Blacklist). */
  clientId?: string;
}

export async function listBlacklist(
  filter: BlacklistFilter,
  ctx: FetchInstanceCtx,
): Promise<Instance[]> {
  const params = new URLSearchParams({
    domain: ctx.domain,
    candidate_id: filter.candidateId,
  });
  if (filter.clientId) params.set("client_id", filter.clientId);
  const path = `/api/v1/ontology/instances/Blacklist?${params.toString()}`;
  const raw = await getJson({
    apiBase: ctx.apiBase,
    apiToken: ctx.apiToken,
    path,
    timeoutMs: ctx.timeoutMs,
  });
  const list = normalizeListResponse(raw);
  return list.map((row) => buildInstance("Blacklist", row));
}

/** DataObject schema introspection — used by seed script. Path is
 *  `/api/v1/ontology/objects/{label}`, NOT `/schema/objects/{label}`. */
export async function fetchObjectSchema(
  label: string,
  ctx: FetchInstanceCtx,
): Promise<Record<string, unknown>> {
  const path = `/api/v1/ontology/objects/${encodeURIComponent(label)}?domain=${encodeURIComponent(ctx.domain)}`;
  const raw = await getJson({
    apiBase: ctx.apiBase,
    apiToken: ctx.apiToken,
    path,
    timeoutMs: ctx.timeoutMs,
  });
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Unexpected schema response for ${label}: not an object`);
  }
  return raw as Record<string, unknown>;
}

// ─── internals ───

async function fetchSingleInstance(
  label: string,
  pkValue: string,
  ctx: FetchInstanceCtx,
): Promise<Instance> {
  const path = `/api/v1/ontology/instances/${encodeURIComponent(label)}/${encodeURIComponent(pkValue)}?domain=${encodeURIComponent(ctx.domain)}`;
  const raw = await getJson({
    apiBase: ctx.apiBase,
    apiToken: ctx.apiToken,
    path,
    timeoutMs: ctx.timeoutMs,
  });
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Unexpected instance response for ${label}/${pkValue}: not an object`);
  }
  return buildInstance(label, raw as Record<string, unknown>);
}

function buildInstance(label: string, raw: Record<string, unknown>): Instance {
  const data = inflateData(raw);
  const pkField = pkFieldFor(label);
  const objectId = typeof data[pkField] === "string"
    ? (data[pkField] as string)
    : String(data[pkField] ?? "");
  return { objectType: label, objectId, data };
}

function normalizeListResponse(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw.filter(isPlainObject) as Record<string, unknown>[];
  if (isPlainObject(raw)) {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r["items"])) return r["items"].filter(isPlainObject) as Record<string, unknown>[];
    if (Array.isArray(r["data"])) return r["data"].filter(isPlainObject) as Record<string, unknown>[];
    if (Array.isArray(r["results"])) return r["results"].filter(isPlainObject) as Record<string, unknown>[];
  }
  return [];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function inflateData(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = inflateValue(v);
  }
  return out;
}

function inflateValue(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (trimmed.length < 2) return v;
  const first = trimmed[0];
  if (first !== "[" && first !== "{") return v;
  try {
    return JSON.parse(trimmed);
  } catch {
    return v;
  }
}
