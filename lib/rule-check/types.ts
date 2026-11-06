// Rule check production module — shared types.
//
// 来源:scripts/rule-check-poc/types.ts(经过 binary PASS/FAIL 简化)
// 边界:这是 matchResumeAgent 在调 RAAS /match-resume 之前的预筛 LLM 评判,
//      不替代 Robohire 的深度打分。

export type Severity = 'terminal' | 'needs_human' | 'flag_only';

export interface Rule {
  id: string;
  specificScenarioStage: string;
  businessLogicRuleName: string;
  applicableClient: '通用' | string;
  applicableDepartment: string;
  submissionCriteria: string;
  standardizedLogicRule: string;
  relatedEntities: string[];
  businessBackgroundReason: string;
  ruleSource: string;
  executor: 'Agent' | 'Human';

  /** New v0.1.002: 是否强制执行。`mandatory` 不可跳过,`optional` 可由 HSM 跳过。 */
  enforcementLevel?: 'mandatory' | 'optional';
  /** New v0.1.002: 失败时如何处理。`block` 立即终止 matchResume,`warn` 仅记录不中断。 */
  failurePolicy?: 'block' | 'warn';
  /** @deprecated v0.1.002 后从 enforcementLevel + failurePolicy derive。保留一个 release 防止 UI 编译失败。 */
  severity?: Severity;
}

export interface OntologyDims {
  client_id: string;
  business_group: string | null;
  studio: string | null;
}

export interface ClassifiedRules {
  general: Rule[];
  client_level: Rule[];
  department_level: Rule[];
  by_severity: {
    terminal: Rule[];
    needs_human: Rule[];
    flag_only: Rule[];
  };
}

// ─── 5-block input shape (与 docs/raas/yeyang-prompt-adapter-onboarding.md §3.3 对齐) ───

export interface RuleCheckRuntimeContext {
  upload_id: string;
  candidate_id: string;
  resume_id: string;
  employee_id: string;
  filename?: string;
  received_at?: string;
  trace_id?: string | null;
}

export interface RuleCheckInput {
  runtime_context: RuleCheckRuntimeContext;
  /** @deprecated Library now fetches resume from neo4j via candidate_id; this field is ignored. */
  resume?: Record<string, unknown>;
  job_requisition: Record<string, unknown> & { job_requisition_id: string };
  job_requisition_specification?: Record<string, unknown> | null;
  hsm_feedback?: Record<string, unknown> | null;
}

// ─── Phase 3: neo4j-aware matchResume check ──────────────────────────────

export type RuleStatus =
  | 'pass'
  | 'fail'
  | 'pending'
  | 'insufficient_info'
  | 'not_triggered'
  | 'not_executed';

/**
 * 下一步动作 — 2026-05-26 起 LLM 必填,UI 因果链第②步显示(不再"(未给)")。
 *   continue   放行(pass / not_triggered)
 *   block      阻断(fail)
 *   supplement 补充材料(insufficient_info)
 *   review     人工复核(pending；不阻断,仅提示)
 */
export type RuleNextAction = 'continue' | 'block' | 'supplement' | 'review';

/**
 * 规则三层归属 + 为何纳入/排除 —— 解释"为什么抓/没抓这条规则"。
 * 由 api-rule-fetcher.ruleProvenance 计算,落 audit 供 UI 展示。
 */
export type RuleProvenance = {
  rule_id: string;
  /** 通用(CSI) / 客户级 / 客户部门级 */
  tier: 'general' | 'client' | 'department';
  included: boolean;
  reason: string;
  /** Ontology governance snapshot at selection time. */
  enforcement_level?: 'mandatory' | 'optional';
  failure_policy?: 'block' | 'warn';
  /** true means the rule is evaluated and persisted, but never affects the gate. */
  reference_only?: boolean;
};

export type RuleResult = {
  rule_id: string;
  rule_name: string;
  step_id: string;
  status: RuleStatus;
  /**
   * 详细判定依据。fail/pending/insufficient_info 写详细(触发判定→字段取值→
   * 逻辑套用含极性→结论);pass/not_triggered 写简短。
   * Required when status ≠ 'pass' and ≠ 'not_triggered'.
   */
  reason?: string;
  /** 下一步动作；缺省时由 status 推导(fail→block, pass→continue, …)。 */
  next_action?: RuleNextAction;
  /** Server-side governance metadata; never trusted from the LLM response. */
  enforcement_level?: 'mandatory' | 'optional';
  failure_policy?: 'block' | 'warn';
  severity?: Severity;
  /** false for optional/reference-only rules, even when their status is fail. */
  blocking?: boolean;
};

export type RuleExplanation = {
  rule_id: string;
  rule_name: string;
  step_id: string;
  status: Exclude<RuleStatus, 'pass' | 'not_triggered'>;
  reason: string;
  next_action?: RuleNextAction;
  enforcement_level?: 'mandatory' | 'optional';
  failure_policy?: 'block' | 'warn';
  severity?: Severity;
  blocking?: boolean;
};

export type MatchResumeCheckStats = {
  total: number;
  pass: number;
  fail: number;
  pending: number;
  insufficient_info: number;
  not_triggered: number;
  not_executed: number;
};

export type MatchResumeCheckResult = {
  decision: 'PASS' | 'FAIL' | 'REVIEW';
  stats: MatchResumeCheckStats;
  /** Every evaluated rule's status, in Set + within-Set order. Use for debug; the runner derives `explanations` from this. */
  rule_results: RuleResult[];
  explanations: RuleExplanation[];
  /** Pre-fetched graph slots used to evaluate this run. UI consumers (the
   *  /rule-check page) read this to build the drawer's graph view and
   *  inference chain without re-fetching from neo4j. */
  graph_context?: import('./graph-context').GraphContext;
  audit: {
    rules_evaluated: number;
    graph_calls: number;
    llm_model: string;
    llm_duration_ms: number;
    llm_round_trips: number;
    llm_prompt_tokens?: number;
    llm_completion_tokens?: number;
    rule_source: 'ontology-api' | 'json-fallback';
    /** Readable client name resolved during rule fetch (partner-pg / ontology).
     *  Persisted into the audit row so reads don't re-query partner-pg. */
    client_name_resolved?: string | null;
    /** Business group resolved during rule fetch (graph Client_Department lookup
     *  + string fallbacks). Superset of the JR's own bg field — persist this so
     *  audits whose JR lacks an explicit bg still record the resolved value. */
    business_group_resolved?: string | null;
    fail_reason?:
      | 'llm-call-error'
      | 'ontology-graph-unavailable'
      | 'tool-use-loop-exceeded'
      | 'parse-error'
      | string;
    /** Full raw LLM output. Populated when fail_reason='parse-error'
     *  so callers can diagnose what the model actually emitted. */
    raw_llm_text?: string;
    /** Parser failure detail persisted with parked audits. */
    parse_error?: string;
    /** OpenAI-protocol finish_reason on the last LLM response. "length" =
     *  max_tokens cap hit (truncation); "stop" = model finished cleanly. */
    llm_finish_reason?: string;
    /** Raw error message from a failed LLM gateway call (fail_reason
     *  ='llm-call-error'). Lets the dependency-health classifier tell apart
     *  没钱(quota) / 故障(5xx/timeout) / 说不准(auth). */
    llm_error_detail?: string;
    /** Full user prompt sent to LLM (markdown) — for /rule-check audit UI. */
    user_prompt?: string;
    /** Full LLM raw response text — for /rule-check audit UI Rule Flags / LLM Response tabs. */
    llm_raw_text?: string;
    /** System prompt used (constant per release) — for audit display. */
    system_prompt?: string;
    /** 每条 API rule 的三层归属 + 纳入/排除证据(含被排除的)。 */
    rule_provenance?: RuleProvenance[];
  };
};

/** Action_step group used by prompt rendering (Set ordering). */
export interface MatchResumeStepGroup {
  step_id: string;
  order: number;
  name: string;
  description: string;
  condition: string;
  rules: Rule[];
}
