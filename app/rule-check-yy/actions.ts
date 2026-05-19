"use server";

/**
 * Server actions for the commercial `/rule-check/*` UI.
 *
 * Pattern matches `app/dev/simple-rule-check/actions.ts`: types are
 * DECLARED LOCALLY — re-exporting types via `export type { ... } from ...`
 * breaks Next.js 16's Turbopack "use server" transform with runtime
 * ReferenceErrors. The shapes below mirror the internal declarations in
 * `lib/rule-check/server-actions.ts` (that file is the source of truth
 * for the implementation; keep these in sync manually).
 *
 * `getRunDetail` is intentionally NOT re-exported — the run-detail page
 * invokes it server-side directly to keep the full audit JSON off the
 * client wire when not requested.
 */

import {
  replayRun as _replayRun,
  listMatrixCells as _listMatrixCells,
  listAggregateRuns as _listAggregateRuns,
  listAggregateBatches as _listAggregateBatches,
  getRunPreview as _getRunPreview,
  getBatchSummary as _getBatchSummary,
  listActiveRules as _listActiveRules,
} from "@/lib/rule-check/server-actions";
import type {
  CheckRuleInput,
  CheckRulesInput,
  FetchedRuleClassified,
  Instance,
  RuleDecision,
  ValidationReport,
} from "@/lib/rule-check";
import type { BatchAggregateDecision } from "@/lib/rule-check/types-audited";

// ─── Public types (mirror lib internals) ─────────────────────────────────

export interface MatrixCell {
  ruleId: string;
  candidateId: string;
  runId: string;
  decision: RuleDecision;
  timestamp: string;
}

export interface AggregateRow {
  runId: string;
  batchId?: string;
  timestamp: string;
  ruleId: string;
  candidateId: string;
  client: string;
  actionRef: string;
  decision: RuleDecision;
}

export interface AggregateMetrics {
  total: number;
  passedPct: number;
  blockedPct: number;
  pendingPct: number;
  notStartedPct: number;
  avgLatencyMs: number | null;
  runsPerDay: number[];
}

export interface RunPreview {
  runId: string;
  batchId?: string;
  timestamp: string;
  input: CheckRuleInput;
  ruleName: string;
  finalDecision: { decision: RuleDecision; overrideReason?: string };
  confidence: number | null;
  conclusionText: string;
  topDecisiveEvidence: Array<{
    objectType: string;
    objectId: string;
    field: string;
    value: unknown;
    grounded?: boolean;
  }>;
  validation: ValidationReport;
  fetchedInstances: Instance[];
}

// Input shapes used only by the wrappers below — not consumed externally.
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

interface ListAggregateBatchesInput {
  client?: string;
  actionRef?: string;
  candidateId?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
}

// ─── Batch-level public types (Path C v3) ────────────────────────────────

export interface MainFieldDatum {
  label: string;
  value: string;
}

export interface BatchRow {
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
  stepProgress: Array<{ stepKey: string; stepOrder: number; status: "ok" | "skipped" }>;
}

export interface BatchAggregateMetrics {
  totalBatches: number;
  passed: number;
  blocked: number;
  pending: number;
  notStarted: number;
  shortCircuited: number;
  batchesPerDay: number[];
}

export interface BatchStepCallSlim {
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

export interface BatchRuleEntry {
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

export interface BatchStepGroup {
  stepOrder: number;
  stepKey: string;
  rules: BatchRuleEntry[];
}

export interface BatchSummary {
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

// ─── Async wrappers ──────────────────────────────────────────────────────

export async function replayRun(
  runId: string,
): Promise<{ ok: true; newRunId: string } | { ok: false; error: string }> {
  return _replayRun(runId);
}

export async function listMatrixCells(
  input: ListMatrixInput,
): Promise<MatrixCell[]> {
  return _listMatrixCells(input);
}

export async function listAggregateRuns(
  input: ListAggregateInput,
): Promise<{ rows: AggregateRow[]; aggregate: AggregateMetrics }> {
  return _listAggregateRuns(input);
}

export async function getRunPreview(
  runId: string,
): Promise<{ ok: true; preview: RunPreview } | { ok: false; error: string }> {
  return _getRunPreview(runId);
}

export async function listActiveRules(input: {
  actionRef: string;
  domain: string;
  client: string;
  clientDepartment?: string;
}): Promise<FetchedRuleClassified[]> {
  return _listActiveRules(input);
}

export async function listAggregateBatches(
  input: ListAggregateBatchesInput,
): Promise<{ rows: BatchRow[]; aggregate: BatchAggregateMetrics }> {
  return _listAggregateBatches(input);
}

export async function getBatchSummary(
  batchId: string,
): Promise<{ ok: true; summary: BatchSummary } | { ok: false; error: string }> {
  return _getBatchSummary(batchId);
}
