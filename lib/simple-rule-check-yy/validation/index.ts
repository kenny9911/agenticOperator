/**
 * Validation aggregator — runs all four checks and combines them into one
 * `ValidationReport`. Caller (orchestrator) uses `overallOk` to decide
 * whether to honor the LLM's decision or force-override to "pending_human".
 */

import type {
  FetchedRule,
  Instance,
  RuleJudgment,
  ValidationReport,
} from "../types";

import { checkBlockSemantic } from "./block-semantic";
import { checkEvidenceGrounded } from "./evidence-grounded";
import { checkRuleId } from "./rule-id";
import { checkSchema } from "./schema";

export interface RunValidationInput {
  llmRawContent: unknown;
  fetchedRules: FetchedRule[];
  fetchedInstances: Instance[];
}

export interface RunValidationOutput {
  report: ValidationReport;
  /** Zod-parsed RuleJudgment if schema check passed, else null. */
  parsedJudgment: RuleJudgment | null;
}

export function runValidation(input: RunValidationInput): RunValidationOutput {
  const failures: string[] = [];

  // 1. Schema (Zod) — gates everything else.
  const schemaResult = checkSchema(input.llmRawContent);
  failures.push(...schemaResult.failures);
  const parsed = schemaResult.parsed;

  if (!parsed) {
    // Cannot run remaining checks on unparseable output.
    const report: ValidationReport = {
      ruleIdExists: false,
      evidenceGrounded: false,
      schemaValid: false,
      blockSemanticCheck: "skipped",
      overallOk: false,
      failures,
    };
    return { report, parsedJudgment: null };
  }

  // 2. rule_id existence.
  const ruleIdResult = checkRuleId(parsed.ruleId, input.fetchedRules);
  failures.push(...ruleIdResult.failures);

  // 3. evidence grounded.
  const evidenceResult = checkEvidenceGrounded(parsed.evidence, input.fetchedInstances);
  failures.push(...evidenceResult.failures);

  // 4. block semantic (MVP: always skipped).
  const blockOutcome = checkBlockSemantic(parsed.ruleId, parsed.decision);

  const overallOk =
    ruleIdResult.ok &&
    evidenceResult.ok &&
    schemaResult.ok &&
    blockOutcome !== "warning";

  const report: ValidationReport = {
    ruleIdExists: ruleIdResult.ok,
    evidenceGrounded: evidenceResult.ok,
    schemaValid: schemaResult.ok,
    blockSemanticCheck: blockOutcome,
    overallOk,
    failures,
  };

  // Cast Zod-parsed type back to public RuleJudgment (they share shape).
  const judgment: RuleJudgment = {
    ruleId: parsed.ruleId,
    decision: parsed.decision,
    evidence: parsed.evidence,
    rootCause: parsed.rootCause,
    confidence: parsed.confidence,
    nextAction: parsed.nextAction,
  };

  return { report, parsedJudgment: judgment };
}
