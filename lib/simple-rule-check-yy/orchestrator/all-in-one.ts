/**
 * All-in-one orchestrator stub — FULL impl.
 *
 * One LLM call evaluates all rules of an action, returns RuleJudgment[].
 * Deferred to v1.1; throws if accidentally invoked in MVP.
 */

import type { Orchestrator } from "./index";

export const allInOneOrchestrator: Orchestrator = {
  name: "all-in-one",
  async run() {
    throw new Error(
      "allInOneOrchestrator is not implemented in MVP. Use singleCallOrchestrator.",
    );
  },
};
