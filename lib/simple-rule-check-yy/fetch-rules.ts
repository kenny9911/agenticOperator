/**
 * Rule retrieval — wraps `fetchAction` and exposes a single-rule selector.
 *
 * Returns a flat list with each rule annotated with its parent step's
 * `order` (1-based). SPEC §6.1 refers to this as `stepOrder` (the SPEC
 * sometimes says "stepId" — same semantic, named differently to match the
 * `ActionStep.order` field that already exists in `types.public.ts`).
 */

import { OntologyNotFoundError } from "../ontology-gen/errors";
import { fetchAction } from "../ontology-gen/fetch";
import { applyClientFilter } from "../ontology-gen/compile/filter";
import type { Action } from "../ontology-gen/types.public";

import type { FetchedRule } from "./types";

export interface FetchAllRulesInput {
  actionRef: string;
  domain: string;
  client: string;
  clientDepartment?: string;
  apiBase?: string;
  apiToken?: string;
  timeoutMs?: number;
}

export interface FetchAllRulesOutput {
  action: Action;
  /** Client-filtered flat list, each rule tagged with `stepOrder` from its parent step. */
  rules: FetchedRule[];
}

export async function fetchAllRules(
  input: FetchAllRulesInput,
): Promise<FetchAllRulesOutput> {
  const apiToken = input.apiToken ?? process.env["ONTOLOGY_API_TOKEN"] ?? "";
  if (!apiToken) {
    throw new Error(
      "fetchAllRules: missing apiToken (set ONTOLOGY_API_TOKEN env or pass via input)",
    );
  }
  const action = await fetchAction({
    actionRef: input.actionRef,
    domain: input.domain,
    apiBase: input.apiBase,
    apiToken,
    timeoutMs: input.timeoutMs,
  });

  const filtered = applyClientFilter(action, {
    client: input.client,
    clientDepartment: input.clientDepartment,
  });

  const rules: FetchedRule[] = [];
  for (const step of filtered.actionSteps) {
    for (const rule of step.rules) {
      rules.push({
        id: rule.id,
        name: rule.businessLogicRuleName ?? rule.id,
        sourceText: rule.description || rule.standardizedLogicRule || "",
        stepOrder: step.order,
        applicableScope: rule.applicableClient || "通用",
      });
    }
  }

  return { action, rules };
}

/** Pick a single rule by id; throws `OntologyNotFoundError("rule")` if absent. */
export function selectRule(rules: FetchedRule[], ruleId: string): FetchedRule {
  const found = rules.find((r) => r.id === ruleId);
  if (!found) {
    throw new OntologyNotFoundError(
      "rule",
      `Rule ${ruleId} not found in action's filtered rule set (${rules.length} rules available)`,
      { ruleId, availableRuleIds: rules.map((r) => r.id) },
    );
  }
  return found;
}
