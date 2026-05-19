/**
 * Public ABI for `lib/simple-rule-check/`.
 *
 * Consumers import `checkRule` + the type set; everything else is internal.
 * The full implementation will live in `lib/rule-check/` (separate module);
 * this MVP module is intentionally frozen as the simple baseline.
 */

export { checkRule, checkRules } from "./checker";

export type {
  CheckRuleInput,
  CheckRulesInput,
  Evidence,
  FetchedData,
  FetchedRule,
  FinalDecision,
  Instance,
  InstanceSpec,
  LLMRawResponse,
  RuleCheckBatchRun,
  RuleCheckRun,
  RuleDecision,
  RuleJudgment,
  ValidationReport,
} from "./types";
