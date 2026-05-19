/**
 * Instance fetching for the full `rule-check` impl — sibling of MVP's, but
 * wired through `tracedGetJson` so every HTTP exchange ends up in the audit
 * record's `ontologyApiTrace[]`.
 *
 * The MVP and Full impl modules are deliberately decoupled (per locked
 * decisions in SPEC §15) — drift is expected. This file copies the shape of
 * `lib/simple-rule-check/fetch-instances.ts` but evolves independently.
 *
 * Ontology labels used:
 *   - Candidate           pk = candidate_id
 *   - Candidate_Expectation  pk = candidate_expectation_id
 *   - Resume              pk = resume_id
 *   - Job_Requisition     pk = job_requisition_id
 *   - Application         pk = application_id
 *   - Blacklist           pk = blacklist_id
 */

import type { Instance } from "./types";
import {
  tracedGetJson,
  type TraceCtx,
} from "./store/ontology-trace-recorder";

export interface FetchInstanceCtx {
  apiBase: string;
  apiToken: string;
  domain: string;
  timeoutMs?: number;
  /** Optional trace accumulator — when set, every HTTP exchange is recorded. */
  traceCtx?: TraceCtx;
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

export async function listResumes(
  candidateId: string,
  ctx: FetchInstanceCtx,
): Promise<Instance[]> {
  return listInstancesByFilter("Resume", { candidate_id: candidateId }, ctx);
}

export async function listCandidateExpectations(
  candidateId: string,
  ctx: FetchInstanceCtx,
): Promise<Instance[]> {
  return listInstancesByFilter(
    "Candidate_Expectation",
    { candidate_id: candidateId },
    ctx,
  );
}

export interface ApplicationFilter {
  candidateId: string;
  jobRequisitionId?: string;
  clientId?: string;
  /** ISO-8601 lower bound on `push_timestamp`. */
  sinceDate?: string;
}

export async function listApplications(
  filter: ApplicationFilter,
  ctx: FetchInstanceCtx,
): Promise<Instance[]> {
  const query: Record<string, string> = { candidate_id: filter.candidateId };
  if (filter.jobRequisitionId) query["job_requisition_id"] = filter.jobRequisitionId;
  if (filter.clientId) query["client_id"] = filter.clientId;

  let instances = await listInstancesByFilter("Application", query, ctx);
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
  clientId?: string;
}

export async function listBlacklist(
  filter: BlacklistFilter,
  ctx: FetchInstanceCtx,
): Promise<Instance[]> {
  const query: Record<string, string> = { candidate_id: filter.candidateId };
  if (filter.clientId) query["client_id"] = filter.clientId;
  return listInstancesByFilter("Blacklist", query, ctx);
}

// ─── internals ───

async function fetchSingleInstance(
  label: string,
  pkValue: string,
  ctx: FetchInstanceCtx,
): Promise<Instance> {
  const path = `/api/v1/ontology/instances/${encodeURIComponent(label)}/${encodeURIComponent(pkValue)}?domain=${encodeURIComponent(ctx.domain)}`;
  const raw = await tracedGetJson(
    { apiBase: ctx.apiBase, apiToken: ctx.apiToken, path, timeoutMs: ctx.timeoutMs },
    ctx.traceCtx,
  );
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Unexpected instance response for ${label}/${pkValue}: not an object`);
  }
  return buildInstance(label, raw as Record<string, unknown>);
}

async function listInstancesByFilter(
  label: string,
  filter: Record<string, string>,
  ctx: FetchInstanceCtx,
): Promise<Instance[]> {
  const params = new URLSearchParams({ domain: ctx.domain, ...filter });
  const path = `/api/v1/ontology/instances/${encodeURIComponent(label)}?${params.toString()}`;
  const raw = await tracedGetJson(
    { apiBase: ctx.apiBase, apiToken: ctx.apiToken, path, timeoutMs: ctx.timeoutMs },
    ctx.traceCtx,
  );
  const list = normalizeListResponse(raw);
  return list.map((row) => buildInstance(label, row));
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
  for (const [k, v] of Object.entries(raw)) out[k] = inflateValue(v);
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
