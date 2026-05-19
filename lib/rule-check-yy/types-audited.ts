/**
 * Audit-rich types for the full `rule-check` impl (SPEC §6.3).
 *
 * These extend the MVP shapes with provenance + receipts so the commercial
 * UI at `/rule-check/*` can navigate any decision back to its evidence,
 * the prompt that was sent, the LLM's raw response, and every Ontology API
 * call that fed into the judgment.
 */

import type {
  CheckRuleInput,
  CheckRulesInput,
  Evidence,
  FetchedData,
  LLMRawResponse,
  RuleDecision,
  ValidationReport,
} from "./types";

// ─── Audit-rich Evidence ──────────────────────────────────────────────

export interface EvidenceAudited extends Evidence {
  /** Index into `RuleCheckRunAudited.fetched.instances[]` that this evidence cites. */
  fetchedInstanceIndex: number;
  /** Filled by post-validation, not the LLM. Whether (objectType, objectId, field, value) was byte-equal. */
  grounded?: boolean;
  /** LLM-emitted: did the verdict pivot on this evidence, or is it just informational? */
  decisive: boolean;
}

// ─── Audit-rich RuleJudgment ──────────────────────────────────────────

/**
 * Three-section judgment basis. `ruleRequirement` removed 2026-05-13 per
 * SPEC §15 — rule's original text is shown on the batch detail page; making
 * the LLM re-emit it was redundant.
 */
export interface RootCauseSections {
  /** 【数据观察】 */
  dataObservation: string;
  /** 【对照推理】 */
  contrastReasoning: string;
  /** 【结论】 */
  conclusion: string;
}

export interface CounterfactualEntry {
  /** "如果 expected_salary_range 改为 90000-100000" */
  hypotheticalChange: string;
  /** What the LLM thinks the verdict would flip to. Labelled "speculative" in UI. */
  predictedDecision: RuleDecision;
  confidence: number;
}

export interface RuleJudgmentAudited {
  ruleId: string;
  decision: RuleDecision;
  evidence: EvidenceAudited[];
  /** Free-form 中文 narrative — must follow four-section structure (see system prompt). */
  rootCause: string;
  /** Same four sections, parsed by the LLM so the UI doesn't have to regex-split. */
  rootCauseSections: RootCauseSections;
  confidence: number;
  nextAction: string;
  /** LLM-proposed flip points. Powers Ask-Why pre-canned counterfactuals. */
  counterfactuals?: CounterfactualEntry[];
}

// ─── Provenance ───────────────────────────────────────────────────────

export interface PromptProvenance {
  /** SHA-256 of the resolved prompt with `## 当前时间` block stripped. */
  promptSha256: string;
  /** SHA-256 of normalized JSON of the `ActionObjectV4` consumed. */
  actionObjectSha256: string;
  /** Snapshot of the args we passed to `generatePrompt()`. */
  generatePromptInput: {
    actionRef: string;
    client: string;
    clientDepartment?: string;
    domain: string;
    /** Stable hash of the runtime input we synthesized. */
    runtimeInputDigest: string;
  };
  /** ISO-8601 when the prompt was resolved (right before sending to LLM). */
  resolvedAt: string;
}

// ─── Ontology API trace ───────────────────────────────────────────────

export interface OntologyApiTraceEntry {
  requestUrl: string;
  requestMethod: "GET";
  requestHeaders: Record<string, string>;
  responseStatus: number;
  /** Full response body so the UI's "View source" link can show real receipts. */
  responseBody: unknown;
  latencyMs: number;
  timestamp: string;
}

// ─── Composite confidence ────────────────────────────────────────────

export interface CompositeConfidenceBreakdown {
  evidenceCountFactor: number;
  consistencyFactor: number;
  /** null when logprobs unavailable; UI shows "degraded" tag. */
  logprobScore: number | null;
  source: "composite_full" | "composite_degraded";
}

// ─── Human override audit log ────────────────────────────────────────

export interface HumanOverride {
  overrider: string;           // operator id / email
  overrideAt: string;          // ISO-8601
  fromDecision: "pending_human";
  toDecision: "passed" | "blocked";
  reason: string;              // free text, required
}

// ─── Ask why Q&A audit log ───────────────────────────────────────────

export interface AskWhyEntry {
  askedAt: string;
  asker: string;
  question: string;
  answer: string;
  /** Hash of trace JSON state at time of asking, for reproducibility. */
  traceSha256AtAsk: string;
}

// ─── Audit-rich RuleCheckRun ─────────────────────────────────────────

export interface RuleCheckRunAudited {
  runId: string;
  /** Set when this run was produced as part of a `checkRules` batch call. */
  batchId?: string;
  timestamp: string;
  input: CheckRuleInput;
  fetched: FetchedData;
  /** The full resolved prompt sent to the LLM. */
  prompt: string;
  promptProvenance: PromptProvenance;
  ontologyApiTrace: OntologyApiTraceEntry[];
  llmRaw: LLMRawResponse;
  /** null if Zod schema parse failed — `validation.schemaValid` is then false. */
  llmParsed: RuleJudgmentAudited | null;
  validation: ValidationReport;
  confidenceBreakdown: CompositeConfidenceBreakdown;
  finalDecision: {
    decision: RuleDecision;
    overrideReason?: string;
  };
  humanOverrides?: HumanOverride[];
  askWhyHistory?: AskWhyEntry[];
  /** Filesystem path of the audit JSON written by the store. */
  auditPath?: string;
}

// ─── Audit-rich Batch run ────────────────────────────────────────────

export interface BatchAggregateDecision {
  decision: RuleDecision;
  triggeredRules: string[];
  /**
   * True when a `canBlock !== false` rule was `blocked` in some step, causing
   * subsequent steps to skip their LLM call (Path C short-circuit). Replaces
   * the previously LLM-claimed `final_output.terminal` field — orchestrator
   * derives this deterministically.
   */
  terminal: boolean;
  /** When `terminal === true`, the stepOrder that triggered the short-circuit. */
  terminalAtStep?: number;
}

/**
 * Per-step audit entry for Path C (per-step sequential LLM calls).
 *
 * The orchestrator emits one `StepCallRecord` per step in `actionSteps` that
 * has `rules.length > 0`, in execution order. Skipped steps (after a
 * short-circuit) still appear as elements but with `shortCircuited: true` and
 * `llmRaw / promptProvenance: null` — order semantics are preserved and the
 * audit explicitly records the "this step was decided not to run" event.
 */
export interface StepCallRecord {
  /** matchResume step order (1, 2, 3, …) */
  stepOrder: number;
  /** Stable key — "step_<order>" (matches envelope's `step_results` keys). */
  stepKey: string;
  /** True when this step was skipped due to an earlier short-circuit. */
  shortCircuited: boolean;
  /** ISO-8601 when the LLM call started; null when shortCircuited. */
  startedAt: string | null;
  /** null when shortCircuited. */
  llmRaw: LLMRawResponse | null;
  /** null when shortCircuited. */
  promptProvenance: PromptProvenance | null;
  /** Present only on the step that TRIGGERED a short-circuit. */
  triggeredShortCircuit?: {
    byRuleId: string;
    /** Currently always `"canBlock+blocked"`; future short-circuit reasons can extend the union. */
    reason: "canBlock+blocked";
  };
}

export interface RuleCheckBatchRunAudited {
  batchId: string;
  timestamp: string;
  input: CheckRulesInput;
  results: RuleCheckRunAudited[];
  /** Deterministic aggregate derived from `results[*].finalDecision.decision`. Source of truth. */
  aggregateDecision: BatchAggregateDecision;
  /**
   * Per-step LLM call audit (Path C). One entry per executed-or-skipped step
   * in ascending `stepOrder`. Per-rule `RuleCheckRunAudited` records
   * denormalize their step's prompt / llmRaw / promptProvenance so per-rule
   * replay stays self-contained without joining against this array.
   */
  stepCalls: StepCallRecord[];
  /** Same trace shared by all results, kept once at the batch level. */
  ontologyApiTrace: OntologyApiTraceEntry[];
  auditPath?: string;
}
