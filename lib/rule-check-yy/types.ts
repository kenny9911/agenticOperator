/**
 * Public types for `lib/rule-check` (full impl).
 *
 * Re-exports the primitive shapes from `lib/simple-rule-check/types` to avoid
 * duplication; the audit-rich extensions live in `./types-audited.ts`.
 *
 * Note: `lib/simple-rule-check/` is intentionally treated as a SIBLING module
 * (we re-export from it, but the implementations are deliberately decoupled —
 * the MVP is frozen, the full impl evolves independently).
 */

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
} from "../simple-rule-check/types";

/**
 * Extends `FetchedRule` with optional classification metadata that the
 * Ontology repo may add to Rule nodes in v1.1 (see SPEC §15 locked decision).
 *
 * The Checker reads these fields at runtime; if absent on a rule node,
 * downstream block-semantic validation returns `"skipped"` (per locked
 * decision #6 — no local JSON fallback).
 */
export interface FetchedRuleClassified {
  id: string;
  name: string;
  sourceText: string;
  stepOrder: number;
  applicableScope: string;
  /** Whether this rule is allowed to produce `blocked` verdicts. v1.1 metadata. */
  canBlock?: boolean;
  /** Object types this rule expects to have in scope. v1.1 metadata. */
  requiredInstances?: string[];
}
