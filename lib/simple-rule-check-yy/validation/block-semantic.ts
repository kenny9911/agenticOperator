/**
 * Validation #4 — does the LLM's "block" decision align with the rule's
 * declared blocking semantics?
 *
 * MVP: returns "skipped" unconditionally. v1.1 will consume rule
 * classification metadata (e.g. `rule.canBlock: boolean`) stored on the Rule
 * node in the Ontology API. The function is scaffolded now so callers can
 * already wire it in.
 */

import type { RuleDecision } from "../types";

export type BlockSemanticOutcome = "ok" | "warning" | "skipped";

export function checkBlockSemantic(
  _ruleId: string,
  _decision: RuleDecision,
  _classification?: { canBlock?: boolean },
): BlockSemanticOutcome {
  // MVP: skip.
  return "skipped";
}
