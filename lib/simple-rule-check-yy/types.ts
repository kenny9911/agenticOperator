/**
 * Public types for `lib/simple-rule-check`.
 *
 * Mirrors the SPEC at `docs/RUNTIME-RULE-CHECKER-SPEC.md` §6.1 and §7.
 * Kept in one file because the module's surface is small and the types are
 * tightly coupled (RuleCheckRun composes the rest).
 */

// ─── Public entry input ───

export interface CheckRuleInput {
  /** Action selector (e.g. "matchResume"). */
  actionRef: string;
  /** Rule id (e.g. "10-7"). */
  ruleId: string;
  /** Candidate PK to evaluate. */
  candidateId: string;
  /** Optional job context. Some rules need this; the switch decides. */
  jobRef?: string;
  /** Tenant scope. `client` is required for rule filtering. */
  scope: { client: string; department?: string };
  /** Default "TEST-RAAS-v1" for MVP — isolation from production. */
  domain?: string;
  /** Env overrides (optional; falls back to `ONTOLOGY_API_BASE` / `ONTOLOGY_API_TOKEN`). */
  apiBase?: string;
  apiToken?: string;
  /** LLM provider overrides. */
  openaiApiKey?: string;
  openaiBaseUrl?: string;
  llmModel?: string;
  /** Defaults to 8000ms via `client.ts`. */
  timeoutMs?: number;
}

// ─── Instance fetch shapes ───

export interface InstanceSpec {
  needsCandidate: boolean;
  /** Fetch the candidate's Resume (separate DataObject in the real ontology;
   *  holds `work_experience`, `skill_tags`, etc.). */
  needsResume?: boolean;
  /** Fetch the candidate's Candidate_Expectation record (separate DataObject;
   *  holds `expected_salary_range`, `outsourcing_acceptance_level`, etc.). */
  needsCandidateExpectation?: boolean;
  needsJob?: boolean;
  /** Fetch Application records (the real ontology label is `Application`,
   *  conceptually a candidate's application history). */
  needsApplications?: {
    byClient?: boolean;
    byJob?: boolean;
    lookbackMonths?: number;
    /** Filter by `Application.status` ∈ this list. */
    onlyStatuses?: string[];
  };
  /** Fetch Blacklist records (real ontology label is `Blacklist`). */
  needsBlacklist?: {
    byClient?: boolean;
  };
  needsLocks?: boolean;
}

export interface Instance {
  objectType: string;          // e.g. "Candidate"
  objectId: string;            // value of PK field
  data: Record<string, unknown>;
}

// ─── Fetched data bundle (input to prompt + validation) ───

export interface FetchedRule {
  id: string;
  name: string;
  sourceText: string;
  /** 1-based index from `ActionStep.order`; the SPEC's "stepId" maps to this. */
  stepOrder: number;
  applicableScope: string;     // e.g. "通用" | "腾讯" | "腾讯/WXG"
}

export interface FetchedData {
  rule: FetchedRule;
  instances: Instance[];
}

// ─── LLM-emitted judgment (the contract enforced by Zod) ───

/**
 * Final routing verdict the Checker emits.
 *
 * - `not_started`     — 该 rule 不适用 / 前置条件未满足 / 不需要触发判定（替代旧的 not_applicable）。
 * - `passed`          — candidate 数据明确满足/未触犯 rule。
 * - `blocked`         — candidate 数据明确触犯 rule，必须拦截。
 * - `pending_human`   — 数据不足、存在风险、或自动判定不可信，需要人工复核（覆盖旧的 pending + warning）。
 */
export type RuleDecision =
  | "not_started"
  | "passed"
  | "blocked"
  | "pending_human";

export interface Evidence {
  sourceType: "neo4j_instance";  // FULL impl may add "external_api"
  objectType: string;
  objectId: string;
  field: string;
  value: unknown;
}

export interface RuleJudgment {
  ruleId: string;
  decision: RuleDecision;
  evidence: Evidence[];
  rootCause: string;
  confidence: number;            // [0, 1]
  nextAction: string;
}

// ─── Validation (deterministic post-LLM check) ───

export interface ValidationReport {
  ruleIdExists: boolean;
  evidenceGrounded: boolean;
  schemaValid: boolean;
  blockSemanticCheck: "ok" | "warning" | "skipped";
  overallOk: boolean;
  failures: string[];            // tags like "evidence_unknown_instance:Candidate/C-X"
}

// ─── Final per-run record (what's persisted to disk) ───

export interface LLMRawResponse {
  model: string;
  /** Raw API response body — kept verbatim for audit replay. */
  response: unknown;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface FinalDecision {
  decision: RuleDecision;
  /** Populated when validation fails and decision is forced to "pending_human". */
  overrideReason?: string;
}

export interface RuleCheckRun {
  runId: string;                 // UUIDv7 if available else v4
  timestamp: string;             // ISO-8601
  input: CheckRuleInput;
  fetched: FetchedData;
  prompt: string;
  llmRaw: LLMRawResponse;
  /** null if Zod schema parse failed — `validation.schemaValid` is then false. */
  llmParsed: RuleJudgment | null;
  validation: ValidationReport;
  finalDecision: FinalDecision;
  /** Absolute path of the audit JSON written by the store. */
  auditPath?: string;
}

// ─── Reserved (FULL impl) ───

export interface CheckRulesInput extends Omit<CheckRuleInput, "ruleId"> {
  ruleIds?: string[];
  concurrency?: number;
}

export interface RuleCheckBatchRun {
  batchId: string;
  timestamp: string;
  input: CheckRulesInput;
  results: RuleCheckRun[];
  aggregateDecision: {
    decision: RuleDecision;
    triggeredRules: string[];
  };
}
