/**
 * Public Rule Checker entrypoint.
 *
 * MVP: `checkRule()` delegates to the single-call orchestrator.
 * FULL: `checkRules()` will delegate to the all-in-one orchestrator (or a
 * batch wrapper around single-call). Throws in MVP — interface reserved.
 */

import { singleCallOrchestrator } from "./orchestrator";
import type {
  CheckRuleInput,
  CheckRulesInput,
  RuleCheckBatchRun,
  RuleCheckRun,
} from "./types";

export async function checkRule(input: CheckRuleInput): Promise<RuleCheckRun> {
  return singleCallOrchestrator.run(input);
}

export async function checkRules(
  _input: CheckRulesInput,
): Promise<RuleCheckBatchRun> {
  throw new Error(
    "checkRules() is reserved for the full implementation. MVP supports only checkRule().",
  );
}
