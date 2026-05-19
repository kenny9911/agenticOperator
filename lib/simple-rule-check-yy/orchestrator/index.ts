/**
 * Orchestrator interface — pluggable run shapes.
 *
 * MVP: `SingleCallOrchestrator` (one rule, one LLM call).
 * FULL: `AllInOneOrchestrator` (all rules of an action, one LLM call returning
 *   an array of judgments).
 */

import type { CheckRuleInput, RuleCheckRun } from "../types";

export interface Orchestrator {
  name: string;
  run(input: CheckRuleInput): Promise<RuleCheckRun>;
}

export { singleCallOrchestrator } from "./single-call";
export { allInOneOrchestrator } from "./all-in-one";
