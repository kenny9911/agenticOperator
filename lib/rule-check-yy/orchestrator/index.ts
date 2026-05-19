/**
 * Orchestrator interface — pluggable batch pipeline.
 *
 * The full impl ships `AllInOneOrchestrator` (one LLM call, all rules).
 * A future per-step batching variant would conform to the same interface.
 */

import type { CheckRulesInput } from "../types";
import type { RuleCheckBatchRunAudited } from "../types-audited";

export interface Orchestrator {
  name: string;
  run(input: CheckRulesInput): Promise<RuleCheckBatchRunAudited>;
}

export { allInOneOrchestrator } from "./all-in-one";
