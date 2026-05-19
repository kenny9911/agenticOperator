/**
 * Aggregates N per-rule final decisions into a single action-level verdict.
 *
 * Cascade (highest priority first):
 *   1. Any rule `blocked`         → batch `blocked`         (triggered = blocked ids)
 *   2. Any rule `pending_human`   → batch `pending_human`   (triggered = pending ids)
 *   3. Any rule `passed`          → batch `passed`
 *   4. All rules `not_started`    → batch `not_started`
 *
 * Rationale: safety + audit. A single blocking rule must dominate (you cannot
 * recommend a candidate whom any rule blocks). Pending dominates passed
 * because pending means "we don't know yet" — human must look.
 *
 * Terminal flag: this function always returns `terminal: false`. The Path C
 * orchestrator overrides `terminal` + `terminalAtStep` post-call when a
 * short-circuit has occurred.
 */

import type { RuleDecision } from "./types";
import type { BatchAggregateDecision } from "./types-audited";

export interface AggregateInput {
  ruleId: string;
  decision: RuleDecision;
}

export function aggregateDecision(
  judgments: AggregateInput[],
): BatchAggregateDecision {
  if (judgments.length === 0) {
    return { decision: "not_started", triggeredRules: [], terminal: false };
  }

  const blocked = judgments.filter((j) => j.decision === "blocked");
  if (blocked.length > 0) {
    return { decision: "blocked", triggeredRules: blocked.map((j) => j.ruleId), terminal: false };
  }

  const pending = judgments.filter((j) => j.decision === "pending_human");
  if (pending.length > 0) {
    return { decision: "pending_human", triggeredRules: pending.map((j) => j.ruleId), terminal: false };
  }

  const passed = judgments.filter((j) => j.decision === "passed");
  if (passed.length > 0) {
    return { decision: "passed", triggeredRules: [], terminal: false };
  }

  return { decision: "not_started", triggeredRules: [], terminal: false };
}
