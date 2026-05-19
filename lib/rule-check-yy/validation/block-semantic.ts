/**
 * Validation #4 — block-semantic check (full impl actually runs this).
 *
 * Cases:
 *   - `canBlock === undefined` → return "skipped" (no metadata available;
 *     ontology repo hasn't extended Rule schema yet — locked decision #6)
 *   - `canBlock === false && decision === "blocked"` → return "warning"
 *     (the LLM blocked a rule that's classified as advisory-only)
 *   - `requiredInstances` present, but the fetched bundle lacks one or more
 *     of those object types → return "warning" with `missing_required_instance`
 *     tags (the LLM should have output `pending_human`, not a verdict)
 *   - otherwise → "ok"
 */

import type { Instance, RuleDecision } from "../types";
import type { FetchedRuleClassified } from "../types";

export type BlockSemanticOutcome = "ok" | "warning" | "skipped";

export interface BlockSemanticCheckOutput {
  outcome: BlockSemanticOutcome;
  failures: string[];
}

export function checkBlockSemanticAudited(
  rule: FetchedRuleClassified,
  decision: RuleDecision,
  fetchedInstances: Instance[],
): BlockSemanticCheckOutput {
  // No classification metadata → skip.
  if (rule.canBlock === undefined && !rule.requiredInstances) {
    return { outcome: "skipped", failures: [] };
  }

  const failures: string[] = [];

  if (rule.canBlock === false && decision === "blocked") {
    failures.push(
      `block_semantic_violation:rule_${rule.id}_marked_non_blocking_but_decision_is_blocked`,
    );
  }

  if (rule.requiredInstances && rule.requiredInstances.length > 0) {
    const presentTypes = new Set(fetchedInstances.map((i) => i.objectType));
    for (const required of rule.requiredInstances) {
      if (!presentTypes.has(required)) {
        failures.push(`missing_required_instance:${required}`);
      }
    }
  }

  if (failures.length > 0) return { outcome: "warning", failures };
  return { outcome: "ok", failures: [] };
}
