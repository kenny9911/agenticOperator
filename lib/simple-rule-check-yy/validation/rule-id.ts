/**
 * Validation #1 — does the LLM's `ruleId` match a rule actually fetched?
 * Catches LLM rule-id hallucination (e.g. inventing "10-99").
 */

import type { FetchedRule } from "../types";

export interface RuleIdCheckOutput {
  ok: boolean;
  failures: string[];
}

export function checkRuleId(
  parsedRuleId: string,
  fetchedRules: FetchedRule[],
): RuleIdCheckOutput {
  if (fetchedRules.some((r) => r.id === parsedRuleId)) {
    return { ok: true, failures: [] };
  }
  return {
    ok: false,
    failures: [`unknown_rule_id:${parsedRuleId}`],
  };
}
