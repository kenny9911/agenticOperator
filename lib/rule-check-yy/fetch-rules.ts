/**
 * Rule retrieval for the full `rule-check` impl.
 *
 * Sibling of MVP's `lib/simple-rule-check/fetch-rules.ts`, extended to surface
 * **classification metadata** (`canBlock`, `requiredInstances`) at runtime per
 * locked decision #6.
 *
 * Sources for classification:
 *   - `canBlock` — derived from `ActionRule.severity === "blocker"` (best-effort,
 *     uses existing field today). When the ontology repo adds an explicit
 *     `can_block` Rule node property in v1.1, this fetcher will read it
 *     directly without code change (the dynamic-property fallback below).
 *   - `requiredInstances` — read from a future `(:Rule).required_instances`
 *     property. Absent today → `undefined` → block-semantic returns "skipped".
 */

import { OntologyNotFoundError } from "../ontology-gen/errors";
import { fetchAction } from "../ontology-gen/fetch";
import { applyClientFilter } from "../ontology-gen/compile/filter";
import type { Action, ActionRule } from "../ontology-gen/types.public";

import { rcDebug, rcInfo } from "./debug";
import type { FetchedRuleClassified } from "./types";

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
  /** Client-filtered flat list, each rule classified with optional metadata. */
  rules: FetchedRuleClassified[];
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
  rcDebug("fetch-rules", "fetchAction", {
    actionRef: input.actionRef,
    domain: input.domain,
    client: input.client,
    department: input.clientDepartment,
  });
  const action = await fetchAction({
    actionRef: input.actionRef,
    domain: input.domain,
    apiBase: input.apiBase,
    apiToken,
    timeoutMs: input.timeoutMs,
  });
  const totalSteps = action.actionSteps?.length ?? 0;
  const totalRules = action.actionSteps?.reduce((sum, s) => sum + (s.rules?.length ?? 0), 0) ?? 0;

  const filtered = applyClientFilter(action, {
    client: input.client,
    clientDepartment: input.clientDepartment,
  });
  const filteredRules = filtered.actionSteps.reduce((sum, s) => sum + s.rules.length, 0);
  rcInfo("fetch-rules", "client filter applied", {
    actionRef: input.actionRef,
    client: input.client,
    department: input.clientDepartment,
    rawSteps: totalSteps,
    rawRules: totalRules,
    filteredSteps: filtered.actionSteps.length,
    filteredRules,
  });

  const rules: FetchedRuleClassified[] = [];
  for (const step of filtered.actionSteps) {
    for (const rule of step.rules) {
      rules.push({
        id: rule.id,
        name: rule.businessLogicRuleName ?? rule.id,
        sourceText: rule.description || rule.standardizedLogicRule || "",
        stepOrder: step.order,
        applicableScope: rule.applicableClient || "通用",
        canBlock: deriveCanBlock(rule),
        requiredInstances: deriveRequiredInstances(rule),
      });
    }
  }

  return { action, rules };
}

/** Pick a single rule by id; throws `OntologyNotFoundError("rule")` if absent. */
export function selectRule(
  rules: FetchedRuleClassified[],
  ruleId: string,
): FetchedRuleClassified {
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

// ─── classification derivation ───

/**
 * `canBlock` resolution priority:
 *   1. Explicit `can_block` property on the raw rule (v1.1 ontology repo schema)
 *   2. Fallback: `severity === "blocker"` (today's data)
 *   3. `undefined` if neither — block-semantic returns "skipped"
 */
function deriveCanBlock(rule: ActionRule): boolean | undefined {
  const raw = rule as ActionRule & { can_block?: unknown; canBlock?: unknown };
  if (typeof raw.can_block === "boolean") return raw.can_block;
  if (typeof raw.canBlock === "boolean") return raw.canBlock;
  if (rule.severity === "blocker") return true;
  if (rule.severity === "advisory") return false;
  return undefined;
}

function deriveRequiredInstances(rule: ActionRule): string[] | undefined {
  const raw = rule as ActionRule & {
    required_instances?: unknown;
    requiredInstances?: unknown;
  };
  const candidate = raw.required_instances ?? raw.requiredInstances;
  if (Array.isArray(candidate) && candidate.every((s) => typeof s === "string")) {
    return candidate as string[];
  }
  return undefined;
}
