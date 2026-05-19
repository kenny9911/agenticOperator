/**
 * Public entry points for `lib/rule-check` (full impl).
 *
 * - `checkRules(input)` runs `AllInOneOrchestrator`: one LLM call evaluates
 *   all rules of the action → `RuleCheckBatchRunAudited`.
 * - `checkRule(input)` is a thin convenience wrapper that filters down to a
 *   single rule and returns the corresponding per-run record.
 */

import { rcInfo } from "./debug";
import type { CheckRuleInput, CheckRulesInput } from "./types";
import type {
  RuleCheckBatchRunAudited,
  RuleCheckRunAudited,
} from "./types-audited";
import { allInOneOrchestrator } from "./orchestrator";

export async function checkRules(
  input: CheckRulesInput,
): Promise<RuleCheckBatchRunAudited> {
  rcInfo("checker", "checkRules invoked", {
    actionRef: input.actionRef,
    candidateId: input.candidateId,
    jobRef: input.jobRef,
    ruleIds: input.ruleIds ?? "(all)",
  });
  return allInOneOrchestrator.run(input);
}

export async function checkRule(
  input: CheckRuleInput,
): Promise<RuleCheckRunAudited> {
  rcInfo("checker", "checkRule invoked", {
    actionRef: input.actionRef,
    candidateId: input.candidateId,
    jobRef: input.jobRef,
    ruleId: input.ruleId,
  });
  const batch = await checkRules({
    actionRef: input.actionRef,
    candidateId: input.candidateId,
    jobRef: input.jobRef,
    scope: input.scope,
    domain: input.domain,
    apiBase: input.apiBase,
    apiToken: input.apiToken,
    openaiApiKey: input.openaiApiKey,
    openaiBaseUrl: input.openaiBaseUrl,
    llmModel: input.llmModel,
    timeoutMs: input.timeoutMs,
    ruleIds: [input.ruleId],
  });
  const single = batch.results.find((r) => r.input.ruleId === input.ruleId);
  if (!single) {
    throw new Error(
      `checkRule: rule ${input.ruleId} not present in batch results (got ${batch.results.length} results)`,
    );
  }
  return single;
}
