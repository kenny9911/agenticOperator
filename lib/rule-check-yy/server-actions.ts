/**
 * Server-action seam for the commercial `/rule-check-yy/*` UI.
 *
 * This file is a thin UI-layer adapter — it does NOT modify the checker
 * itself. It composes existing public surface:
 *   - `checkRules` (from `./checker`) for run + replay
 *   - `filesystemRunStore` (from `./store`) for read paths
 *   - `fetchAllRules` (from `./fetch-rules`) for rule library lookups
 *
 * Both `app/dev/rule-check-yy/actions.ts` and `app/rule-check-yy/actions.ts` wrap
 * each function below in a thin "use server" async passthrough.
 *
 * Why types are NOT exported from this module: Next.js 16 + Turbopack's
 * "use server" transform mis-handles `export type { ... }` re-export
 * syntax in downstream files (it emits runtime references to type names
 * that have already been erased), causing server-side ReferenceErrors.
 * The route actions.ts files therefore re-declare the public surface
 * locally with `export interface` / `export type` (matching the working
 * pattern in `app/dev/simple-rule-check-yy/actions.ts`). The shapes here are
 * the source of truth — keep them in sync manually.
 *
 * Per SPEC §9.3 (UI Derivations留痕): UI does not generate new result
 * content; these actions only project / aggregate / re-invoke.
 */

import { aggregateDecision } from "./aggregate-decision";
import { checkRules } from "./checker";
import {
  collectCandidateFields,
  collectJobFields,
  pickCandidateInstance,
  pickJobInstance,
  type MainFieldDatum,
} from "./instance-overview";
import { filesystemRunStore } from "./store";
import type { RunIndexEntry } from "./store";
import { fetchAllRules } from "./fetch-rules";
import type {
  CheckRuleInput,
  CheckRulesInput,
  FetchedRuleClassified,
  Instance,
  RuleDecision,
  ValidationReport,
} from "./types";
import type {
  BatchAggregateDecision,
  RuleCheckBatchRunAudited,
  RuleCheckRunAudited,
} from "./types-audited";

// ─── Internal types (NOT exported — re-exporting type from this module
// causes Next.js 16 Turbopack to emit runtime ReferenceErrors in dependent
// "use server" files. Route-level actions.ts files re-declare the public
// surface locally via `export interface` / `export type =` syntax.) ──────

interface RunCheckBatchOptions {
  actionRef: string;
  candidateId: string;
  jobRef: string;
  client: string;
  clientDepartment?: string;
  domain: string;
  ruleIds?: string[];
}

type RunCheckBatchResult =
  | { ok: true; batch: RuleCheckBatchRunAudited }
  | { ok: false; error: string; details?: unknown };

interface MatrixCell {
  ruleId: string;
  candidateId: string;
  runId: string;
  decision: RuleDecision;
  timestamp: string;
}

interface AggregateRow {
  runId: string;
  batchId?: string;
  timestamp: string;
  ruleId: string;
  candidateId: string;
  client: string;
  actionRef: string;
  decision: RuleDecision;
}

interface AggregateMetrics {
  total: number;
  passedPct: number;
  blockedPct: number;
  pendingPct: number;
  notStartedPct: number;
  /** Pure index-based stats can't compute latency without loading audit
   * files. Returned as null in v1; UI renders "—". */
  avgLatencyMs: number | null;
  /** Counts per day for the trailing 7 days, oldest → newest. */
  runsPerDay: number[];
}

interface RunPreview {
  runId: string;
  batchId?: string;
  timestamp: string;
  input: CheckRuleInput;
  ruleName: string;
  finalDecision: { decision: RuleDecision; overrideReason?: string };
  /** null when `llmParsed` is null (Zod parse failed). */
  confidence: number | null;
  /** rootCauseSections.conclusion (empty string when llmParsed is null). */
  conclusionText: string;
  /** Top 3 by `decisive=true` ordering (then by index). */
  topDecisiveEvidence: Array<{
    objectType: string;
    objectId: string;
    field: string;
    value: unknown;
    grounded?: boolean;
  }>;
  validation: ValidationReport;
  /**
   * Full prefetched Ontology instances (Job/Resume/Candidate/Expectation/etc.)
   * for the aggregate preview's D8 expanded sections. Strict subset of
   * audit JSON — no reformulation per SPEC §9.3.
   */
  fetchedInstances: Instance[];
}

interface ListAggregateInput {
  client?: string;
  actionRef?: string;
  ruleId?: string;
  candidateId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

interface ListMatrixInput {
  client?: string;
  actionRef?: string;
  fromDate?: string;
  toDate?: string;
}

interface BatchRow {
  batchId: string;
  timestamp: string;
  candidateId: string;
  jobRef?: string;
  client: string;
  actionRef: string;
  decision: RuleDecision;
  terminal: boolean;
  terminalAtStep?: number;
  ruleCount: number;
  /** Per-step rollup. status = "ok" when LLM call ran; "skipped" when short-circuited. */
  stepProgress: Array<{ stepKey: string; stepOrder: number; status: "ok" | "skipped" }>;
}

interface BatchAggregateMetrics {
  totalBatches: number;
  passed: number;
  blocked: number;
  pending: number;
  notStarted: number;
  shortCircuited: number;
  batchesPerDay: number[];
}

interface BatchStepCallSlim {
  stepOrder: number;
  stepKey: string;
  shortCircuited: boolean;
  startedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
  promptShaShort: string;
  triggeredShortCircuit?: { byRuleId: string; reason: string };
}

interface BatchRuleEntry {
  runId: string;
  ruleId: string;
  ruleName: string;
  sourceText: string;
  decision: RuleDecision;
  overrideReason?: string;
  conclusionText: string;
  dataObservationText: string;
  contrastReasoningText: string;
}

interface BatchStepGroup {
  stepOrder: number;
  stepKey: string;
  rules: BatchRuleEntry[];
}

interface BatchSummary {
  batchId: string;
  timestamp: string;
  input: CheckRulesInput;
  aggregateDecision: BatchAggregateDecision;
  stepCalls: BatchStepCallSlim[];
  candidateOverview: { instance: Instance | null; mainFields: MainFieldDatum[] };
  jobOverview: { instance: Instance | null; mainFields: MainFieldDatum[] };
  otherInstances: Instance[];
  stepGroups: BatchStepGroup[];
}

interface ListAggregateBatchesInput {
  client?: string;
  actionRef?: string;
  candidateId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

// ─── Actions ─────────────────────────────────────────────────────────────

/**
 * Invoke a fresh rule-check batch. Original home of this function was
 * `app/dev/rule-check-yy/actions.ts`; both routes now import it from here.
 */
export async function runCheckBatch(
  opts: RunCheckBatchOptions,
): Promise<RunCheckBatchResult> {
  try {
    const batch = await checkRules({
      actionRef: opts.actionRef,
      candidateId: opts.candidateId,
      jobRef: opts.jobRef,
      scope: { client: opts.client, department: opts.clientDepartment },
      domain: opts.domain,
      ruleIds: opts.ruleIds,
    });
    return { ok: true, batch };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      details: err instanceof Error && err.stack ? { stack: err.stack } : undefined,
    };
  }
}

/**
 * Replay a prior run as a NEW independent runId (SPEC §14.2). The old run's
 * audit JSON is untouched on disk; this function only reads it to extract
 * `input` and re-issues `runCheckBatch` with the same single ruleId.
 */
export async function replayRun(
  runId: string,
): Promise<{ ok: true; newRunId: string } | { ok: false; error: string }> {
  const run = await filesystemRunStore.getRun(runId);
  if (!run) return { ok: false, error: `run_not_found:${runId}` };
  const { actionRef, ruleId, candidateId, jobRef, scope, domain } = run.input;
  if (!jobRef) return { ok: false, error: "missing_jobRef" };
  if (!domain) return { ok: false, error: "missing_domain" };
  const res = await runCheckBatch({
    actionRef,
    candidateId,
    jobRef,
    client: scope.client,
    clientDepartment: scope.department,
    domain,
    ruleIds: [ruleId],
  });
  if (!res.ok) return { ok: false, error: res.error };
  const first = res.batch.results[0];
  if (!first) return { ok: false, error: "no_run_produced" };
  return { ok: true, newRunId: first.runId };
}

/**
 * Build matrix cells: latest run per `(ruleId, candidateId)` pair (D4).
 * Returns ONLY slim cell records — no full audit JSON read.
 */
export async function listMatrixCells(
  input: ListMatrixInput,
): Promise<MatrixCell[]> {
  const entries = await filesystemRunStore.listRuns({
    client: input.client,
    actionRef: input.actionRef,
    fromDate: input.fromDate,
    toDate: input.toDate,
  });
  // Latest by `(ruleId, candidateId)`, lexicographic runId DESC tiebreak (D4).
  const latestByPair = new Map<string, RunIndexEntry>();
  for (const e of entries) {
    const key = `${e.ruleId} ${e.candidateId}`;
    const prev = latestByPair.get(key);
    if (!prev) {
      latestByPair.set(key, e);
      continue;
    }
    if (e.timestamp > prev.timestamp) {
      latestByPair.set(key, e);
    } else if (e.timestamp === prev.timestamp && e.runId > prev.runId) {
      latestByPair.set(key, e);
    }
  }
  return Array.from(latestByPair.values()).map((e) => ({
    ruleId: e.ruleId,
    candidateId: e.candidateId,
    runId: e.runId,
    decision: e.decision,
    timestamp: e.timestamp,
  }));
}

/**
 * Aggregate page data: slim rows + index-level metrics (D3).
 * `avgLatencyMs` is null in v1 (would require loading each audit JSON).
 */
export async function listAggregateRuns(
  input: ListAggregateInput,
): Promise<{ rows: AggregateRow[]; aggregate: AggregateMetrics }> {
  const entries = await filesystemRunStore.listRuns({
    client: input.client,
    actionRef: input.actionRef,
    ruleId: input.ruleId,
    candidateId: input.candidateId,
    fromDate: input.fromDate,
    toDate: input.toDate,
  });
  entries.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  const limit = input.limit ?? 500;
  const sliced = entries.slice(0, limit);
  const rows: AggregateRow[] = sliced.map((e) => ({
    runId: e.runId,
    batchId: e.batchId,
    timestamp: e.timestamp,
    ruleId: e.ruleId,
    candidateId: e.candidateId,
    client: e.client,
    actionRef: e.actionRef,
    decision: e.decision,
  }));
  const aggregate = computeAggregateMetrics(entries);
  return { rows, aggregate };
}

/**
 * Preview projection for the aggregate page's right panel (D7). Strict
 * subset of audit JSON — no reformulation, no AI summarization.
 */
export async function getRunPreview(
  runId: string,
): Promise<{ ok: true; preview: RunPreview } | { ok: false; error: string }> {
  const run = await filesystemRunStore.getRun(runId);
  if (!run) return { ok: false, error: `run_not_found:${runId}` };
  const sections = run.llmParsed?.rootCauseSections;
  const evidence = run.llmParsed?.evidence ?? [];
  const top = evidence
    .filter((e) => e.decisive)
    .slice(0, 3)
    .map((e) => ({
      objectType: e.objectType,
      objectId: e.objectId,
      field: e.field,
      value: e.value,
      grounded: e.grounded,
    }));
  return {
    ok: true,
    preview: {
      runId: run.runId,
      batchId: run.batchId,
      timestamp: run.timestamp,
      input: run.input,
      ruleName: run.fetched.rule.name,
      finalDecision: run.finalDecision,
      confidence: run.llmParsed?.confidence ?? null,
      conclusionText: sections?.conclusion ?? "",
      topDecisiveEvidence: top,
      validation: run.validation,
      fetchedInstances: run.fetched.instances,
    },
  };
}

/**
 * Full audit JSON for the run detail page. Invoked server-side from the
 * page server component; payload is ~50-100KB and includes prompt +
 * ontologyApiTrace + llmRaw.response.
 */
export async function getRunDetail(
  runId: string,
): Promise<{ ok: true; run: RuleCheckRunAudited } | { ok: false; error: string }> {
  const run = await filesystemRunStore.getRun(runId);
  if (!run) return { ok: false, error: `run_not_found:${runId}` };
  return { ok: true, run };
}

/**
 * Path C v3 — Aggregate batches: 1 row per (candidate, job, time) operation.
 * Reads the per-rule index, groups by batchId, then lazy-loads each batch
 * JSON for the terminal flag + step-call status. Returns rows sorted DESC.
 *
 * Acceptable cost for v1 (filesystem; ≲100 batches). Future: extend
 * index.jsonl with a batch-summary line to avoid the lazy load.
 */
export async function listAggregateBatches(
  input: ListAggregateBatchesInput,
): Promise<{ rows: BatchRow[]; aggregate: BatchAggregateMetrics }> {
  const entries = await filesystemRunStore.listRuns({
    client: input.client,
    actionRef: input.actionRef,
    candidateId: input.candidateId,
    fromDate: input.fromDate,
    toDate: input.toDate,
  });

  // Group per batchId; sub-bucket per ruleId so we don't recount duplicates.
  const grouped = new Map<string, RunIndexEntry[]>();
  for (const e of entries) {
    if (!e.batchId) continue;
    const bucket = grouped.get(e.batchId) ?? [];
    bucket.push(e);
    grouped.set(e.batchId, bucket);
  }

  const rows: BatchRow[] = [];
  for (const [batchId, perBatchEntries] of grouped.entries()) {
    // Aggregate from per-rule decisions.
    const agg = aggregateDecision(
      perBatchEntries.map((e) => ({ ruleId: e.ruleId, decision: e.decision })),
    );
    // Pick a representative entry for metadata.
    const head = [...perBatchEntries].sort((a, b) =>
      a.timestamp < b.timestamp ? -1 : 1,
    )[0]!;
    // Load batch JSON to read stepCalls + terminal accurately.
    const batch = await filesystemRunStore.getBatch(batchId);
    let terminal = false;
    let terminalAtStep: number | undefined;
    const stepProgress: BatchRow["stepProgress"] = [];
    if (batch) {
      terminal = batch.aggregateDecision.terminal;
      terminalAtStep = batch.aggregateDecision.terminalAtStep;
      for (const sc of batch.stepCalls) {
        stepProgress.push({
          stepKey: sc.stepKey,
          stepOrder: sc.stepOrder,
          status: sc.shortCircuited ? "skipped" : "ok",
        });
      }
    }
    rows.push({
      batchId,
      timestamp: head.timestamp,
      candidateId: head.candidateId,
      jobRef: batch?.input.jobRef,
      client: head.client,
      actionRef: head.actionRef,
      decision: agg.decision,
      terminal,
      terminalAtStep,
      ruleCount: perBatchEntries.length,
      stepProgress,
    });
  }

  rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  const limit = input.limit ?? 200;
  const sliced = rows.slice(0, limit);

  const aggregate = computeBatchAggregateMetrics(rows);
  return { rows: sliced, aggregate };
}

/**
 * Full batch summary for `/rule-check-yy/batches/[batchId]` detail page.
 * Projects `batches/<id>.json` into a slim shape (drops `llmRaw.response`
 * raw body to keep payload manageable; keeps usage + latency + provenance).
 */
export async function getBatchSummary(
  batchId: string,
): Promise<{ ok: true; summary: BatchSummary } | { ok: false; error: string }> {
  const batch = await filesystemRunStore.getBatch(batchId);
  if (!batch) return { ok: false, error: `batch_not_found:${batchId}` };

  const stepCalls: BatchStepCallSlim[] = batch.stepCalls.map((sc) => ({
    stepOrder: sc.stepOrder,
    stepKey: sc.stepKey,
    shortCircuited: sc.shortCircuited,
    startedAt: sc.startedAt,
    inputTokens: sc.llmRaw?.inputTokens ?? 0,
    outputTokens: sc.llmRaw?.outputTokens ?? 0,
    latencyMs: sc.llmRaw?.latencyMs ?? 0,
    model: sc.llmRaw?.model ?? "—",
    promptShaShort: sc.promptProvenance?.promptSha256.slice(0, 12) ?? "",
    triggeredShortCircuit: sc.triggeredShortCircuit
      ? {
          byRuleId: sc.triggeredShortCircuit.byRuleId,
          reason: sc.triggeredShortCircuit.reason,
        }
      : undefined,
  }));

  // Find candidate + job instances from any result's fetched.instances
  // (they are denormalized identically across rules of the same batch).
  const firstResult = batch.results[0];
  const instances: Instance[] = firstResult?.fetched.instances ?? [];
  const candInst = pickCandidateInstance(instances);
  const jobInst = pickJobInstance(instances);
  const candidateOverview = {
    instance: candInst,
    mainFields: candInst ? collectCandidateFields(candInst.data) : [],
  };
  const jobOverview = {
    instance: jobInst,
    mainFields: jobInst ? collectJobFields(jobInst.data) : [],
  };
  const otherInstances = instances.filter(
    (i) =>
      i.objectType !== "Candidate" &&
      i.objectType !== "Resume" &&
      i.objectType !== "Job_Requisition",
  );

  // Group results by step.order.
  const groupMap = new Map<number, BatchRuleEntry[]>();
  for (const r of batch.results) {
    const so = r.fetched.rule.stepOrder;
    const sections = r.llmParsed?.rootCauseSections;
    const entry: BatchRuleEntry = {
      runId: r.runId,
      ruleId: r.fetched.rule.id,
      ruleName: r.fetched.rule.name,
      sourceText: r.fetched.rule.sourceText,
      decision: r.finalDecision.decision,
      overrideReason: r.finalDecision.overrideReason,
      conclusionText: sections?.conclusion ?? "",
      dataObservationText: sections?.dataObservation ?? "",
      contrastReasoningText: sections?.contrastReasoning ?? "",
    };
    const bucket = groupMap.get(so) ?? [];
    bucket.push(entry);
    groupMap.set(so, bucket);
  }
  const stepGroups: BatchStepGroup[] = Array.from(groupMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([stepOrder, rules]) => ({
      stepOrder,
      stepKey: `step_${stepOrder}`,
      rules,
    }));

  const summary: BatchSummary = {
    batchId: batch.batchId,
    timestamp: batch.timestamp,
    input: batch.input,
    aggregateDecision: batch.aggregateDecision,
    stepCalls,
    candidateOverview,
    jobOverview,
    otherInstances,
    stepGroups,
  };
  return { ok: true, summary };
}

/**
 * Active rule list for matrix row grouping + rule library.
 */
export async function listActiveRules(input: {
  actionRef: string;
  domain: string;
  client: string;
  clientDepartment?: string;
}): Promise<FetchedRuleClassified[]> {
  const { rules } = await fetchAllRules({
    actionRef: input.actionRef,
    domain: input.domain,
    client: input.client,
    clientDepartment: input.clientDepartment,
  });
  return rules;
}

// ─── helpers ─────────────────────────────────────────────────────────────

function computeAggregateMetrics(entries: RunIndexEntry[]): AggregateMetrics {
  const total = entries.length;
  if (total === 0) {
    return {
      total: 0,
      passedPct: 0,
      blockedPct: 0,
      pendingPct: 0,
      notStartedPct: 0,
      avgLatencyMs: null,
      runsPerDay: [0, 0, 0, 0, 0, 0, 0],
    };
  }
  let passed = 0;
  let blocked = 0;
  let pending = 0;
  let notStarted = 0;
  for (const e of entries) {
    switch (e.decision) {
      case "passed": passed++; break;
      case "blocked": blocked++; break;
      case "pending_human": pending++; break;
      case "not_started": notStarted++; break;
    }
  }
  const pct = (n: number) => Math.round((n / total) * 1000) / 10;
  return {
    total,
    passedPct: pct(passed),
    blockedPct: pct(blocked),
    pendingPct: pct(pending),
    notStartedPct: pct(notStarted),
    avgLatencyMs: null,
    runsPerDay: computeRunsPerDay(entries),
  };
}

function computeBatchAggregateMetrics(rows: BatchRow[]): BatchAggregateMetrics {
  const total = rows.length;
  let passed = 0;
  let blocked = 0;
  let pending = 0;
  let notStarted = 0;
  let shortCircuited = 0;
  for (const r of rows) {
    switch (r.decision) {
      case "passed": passed++; break;
      case "blocked": blocked++; break;
      case "pending_human": pending++; break;
      case "not_started": notStarted++; break;
    }
    if (r.terminal) shortCircuited++;
  }
  return {
    totalBatches: total,
    passed,
    blocked,
    pending,
    notStarted,
    shortCircuited,
    batchesPerDay: computeBatchesPerDay(rows),
  };
}

function computeBatchesPerDay(rows: BatchRow[]): number[] {
  const buckets = [0, 0, 0, 0, 0, 0, 0];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  for (const r of rows) {
    const t = new Date(r.timestamp);
    if (Number.isNaN(t.getTime())) continue;
    t.setUTCHours(0, 0, 0, 0);
    const diff = Math.floor((today.getTime() - t.getTime()) / dayMs);
    if (diff < 0 || diff > 6) continue;
    buckets[6 - diff]++;
  }
  return buckets;
}

function computeRunsPerDay(entries: RunIndexEntry[]): number[] {
  const buckets = [0, 0, 0, 0, 0, 0, 0];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  for (const e of entries) {
    const t = new Date(e.timestamp);
    if (Number.isNaN(t.getTime())) continue;
    t.setUTCHours(0, 0, 0, 0);
    const diff = Math.floor((today.getTime() - t.getTime()) / dayMs);
    if (diff < 0 || diff > 6) continue;
    buckets[6 - diff]++;
  }
  return buckets;
}
