/**
 * Public ABI for `lib/rule-check/` (full implementation).
 *
 * The full impl is parallel to (not a rewrite of) `lib/simple-rule-check/`.
 * MVP stays as the frozen baseline; this module evolves independently and
 * adds: batched evaluation, audit-rich output schema, composite confidence,
 * commercial Prove UI surface.
 */

export { checkRule, checkRules } from "./checker";

// Base types (re-exported from MVP for symmetry).
export type {
  CheckRuleInput,
  CheckRulesInput,
  InstanceSpec,
  Instance,
  FetchedRule,
  FetchedData,
  RuleDecision,
  Evidence,
  RuleJudgment,
  ValidationReport,
  LLMRawResponse,
  FinalDecision,
  RuleCheckRun,
  RuleCheckBatchRun,
  FetchedRuleClassified,
} from "./types";

// Audit-rich types (full impl specific).
export type {
  EvidenceAudited,
  RootCauseSections,
  CounterfactualEntry,
  RuleJudgmentAudited,
  PromptProvenance,
  OntologyApiTraceEntry,
  CompositeConfidenceBreakdown,
  HumanOverride,
  AskWhyEntry,
  RuleCheckRunAudited,
  BatchAggregateDecision,
  RuleCheckBatchRunAudited,
} from "./types-audited";
