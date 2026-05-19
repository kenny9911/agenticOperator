/**
 * Validation aggregator — runs all four checks per judgment and returns a
 * single `ValidationReport`. Caller uses `overallOk` to decide whether to
 * honor the LLM's decision or force-override to "pending_human".
 *
 * Unlike the MVP aggregator, this one runs per-judgment (the orchestrator
 * iterates over the LLM's `judgments[]` array).
 *
 * Q4 lenient (locked 2026-05-13, SPEC §15):
 *   `evidenceGrounded` is computed and persisted to audit (per-evidence
 *   `grounded: true|false` + failure tags) but no longer gates `overallOk`.
 *   Rationale: byte-equal grounding has false positives (formatting / locale
 *   differences) and treating it as a hard override of the LLM's decision was
 *   over-reaching. The signal stays in the audit JSON for quality analysis;
 *   it just doesn't auto-flip judgments to `pending_human` anymore.
 */

import { rcDebug } from "../debug";
import type {
  FetchedRuleClassified,
  Instance,
  ValidationReport,
} from "../types";
import type { RuleJudgmentAudited } from "../types-audited";

import { checkBlockSemanticAudited } from "./block-semantic";
import { checkEvidenceGroundedAudited } from "./evidence-grounded";
import { checkRuleId } from "./rule-id";
import { checkSchema } from "./schema";

export interface RunValidationAuditedInput {
  /** Raw judgment object as parsed from the LLM response. */
  rawJudgment: unknown;
  /** The classified rule this judgment claims to judge. May be undefined if
   *  the LLM's ruleId doesn't match any fetched rule. */
  ruleClassified: FetchedRuleClassified | undefined;
  /** Fetched instances scoped to the run (used by evidence-grounded check). */
  fetchedInstances: Instance[];
  /** Full list of fetched rule ids (for ruleIdExists check). */
  fetchedRules: FetchedRuleClassified[];
}

export interface RunValidationAuditedOutput {
  report: ValidationReport;
  /** Zod-parsed audit judgment if schema check passed, else null. */
  parsedJudgment: RuleJudgmentAudited | null;
}

export function runValidationAudited(
  input: RunValidationAuditedInput,
): RunValidationAuditedOutput {
  const failures: string[] = [];

  // 1. Schema (Zod) — gates everything else.
  const schemaResult = checkSchema(input.rawJudgment);
  failures.push(...schemaResult.failures);
  const parsed = schemaResult.parsed;

  if (!parsed) {
    rcDebug("validation", "schema-parse failed — gating downstream checks", {
      claimedRuleId: (input.rawJudgment as { ruleId?: string })?.ruleId,
      failures: schemaResult.failures,
    });
    return {
      report: {
        ruleIdExists: false,
        evidenceGrounded: false,
        schemaValid: false,
        blockSemanticCheck: "skipped",
        overallOk: false,
        failures,
      },
      parsedJudgment: null,
    };
  }

  // 2. rule_id existence.
  const ruleIdResult = checkRuleId(parsed.ruleId, input.fetchedRules);
  failures.push(...ruleIdResult.failures);

  // 3. evidence grounded (also mutates `parsed.evidence[i].grounded` in place).
  const evidenceResult = checkEvidenceGroundedAudited(
    parsed.evidence,
    input.fetchedInstances,
  );
  failures.push(...evidenceResult.failures);

  // 4. block-semantic (runs when classification metadata available).
  let blockOutcome: "ok" | "warning" | "skipped" = "skipped";
  if (input.ruleClassified) {
    const r = checkBlockSemanticAudited(
      input.ruleClassified,
      parsed.decision,
      input.fetchedInstances,
    );
    blockOutcome = r.outcome;
    failures.push(...r.failures);
  }

  // Q4 lenient: evidenceResult.ok is NOT in this conjunction; see file docstring.
  const overallOk =
    ruleIdResult.ok &&
    schemaResult.ok &&
    blockOutcome !== "warning";

  rcDebug("validation", "checks complete", {
    ruleId: parsed.ruleId,
    ruleIdExists: ruleIdResult.ok,
    schemaValid: schemaResult.ok,
    evidenceGrounded: evidenceResult.ok,
    blockSemantic: blockOutcome,
    overallOk,
    failures: failures.length > 0 ? failures : undefined,
  });

  return {
    report: {
      ruleIdExists: ruleIdResult.ok,
      evidenceGrounded: evidenceResult.ok,
      schemaValid: schemaResult.ok,
      blockSemanticCheck: blockOutcome,
      overallOk,
      failures,
    },
    parsedJudgment: parsed,
  };
}
