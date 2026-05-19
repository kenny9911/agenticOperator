/**
 * Validation #1 — the rule_id the LLM emitted must exist in the fetched
 * rule set. Catches LLM hallucinating a rule that was never in scope.
 */

import type { FetchedRuleClassified } from "../types";

export interface RuleIdCheckOutput {
  ok: boolean;
  failures: string[];
}

export function checkRuleId(
  ruleId: string,
  fetchedRules: FetchedRuleClassified[],
): RuleIdCheckOutput {
  if (fetchedRules.some((r) => r.id === ruleId)) {
    return { ok: true, failures: [] };
  }
  return {
    ok: false,
    failures: [`unknown_rule_id:${ruleId}`],
  };
}
