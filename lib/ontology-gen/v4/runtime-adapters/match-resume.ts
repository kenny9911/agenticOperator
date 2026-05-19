/**
 * matchResume adapter — all action-specific code for `matchResume` lives here.
 *
 * Consolidates:
 *   - typed runtime input shapes (RuntimeJob / RuntimeResume /
 *     MatchResumeRuntimeInput) — part of the public consumer ABI
 *   - action-side discriminator (`isMatchResumeAction`)
 *   - placeholder tokens + hierarchical sentinel
 *   - renderer fns
 *   - the `matchResumeAdapter` object plugged into the registry
 *
 * Client scope (`client` + optional `department`) is not part of the runtime
 * input — it flows in via the `scope` parameter to `buildSubstitutions`,
 * sourced from the function-level `client` / `clientDepartment` args on
 * `generatePrompt` / `fillRuntimeInput`.
 *
 * Adding a second action = copy this file's structure into a sibling module
 * (`screen-candidate.ts` etc.) and register it in `runtime-adapters/index.ts`.
 */

import type { ActionRuntimeAdapter, RuntimeScope } from "./types";
import { renderJsonBlock } from "./utils";

// ─── runtime-input shapes (public consumer ABI) ───

export interface RuntimeJob {
  job_requisition_id: string;
  [field: string]: unknown;
}

export interface RuntimeResume {
  candidate_id: string;
  [field: string]: unknown;
}

export interface MatchResumeRuntimeInput {
  job: RuntimeJob;
  resume: RuntimeResume;
  /**
   * Open property bag — present so this type is assignable to
   * `Record<string, unknown>` (the broader `RuntimeInputV4` arm). Direct
   * property access still narrows to the explicit fields; the indexer only
   * kicks in for dynamic key access (which adapter code never does).
   */
  [key: string]: unknown;
}

// ─── placeholders + hierarchical sentinel ───

export const PLACEHOLDER_CLIENT = "{{CLIENT}}";
export const PLACEHOLDER_JOB = "{{JOB}}";
export const PLACEHOLDER_RESUME = "{{RESUME}}";

/**
 * The runtimeInput string handed to `assembleActionObjectV4_4` for matchResume.
 * The assembler wraps it under `## 运行时输入\n\n<this>`, producing a prompt
 * section with three `### ` sub-headers and three `{{...}}` placeholders for
 * `fillRuntimeInput` to substitute.
 */
export const MATCH_RESUME_HIERARCHY_SENTINEL = [
  "### client",
  "",
  PLACEHOLDER_CLIENT,
  "",
  "### 招聘岗位 (Job_Requisition)",
  "",
  PLACEHOLDER_JOB,
  "",
  "### 候选人简历 (Resume)",
  "",
  PLACEHOLDER_RESUME,
].join("\n");

// ─── discriminator (action side) ───

/**
 * Mirrors the predicate `assemble-v4-4.ts` uses internally (id === "10" ||
 * name === "matchResume"). Duplicated here intentionally — `assemble-v4-4.ts`
 * is treated as immutable (with the documented `## 当前时间` exception). If
 * the predicate ever needs to evolve, sync both sites.
 */
export function isMatchResumeAction(action: { id?: string; name?: string }): boolean {
  return action.id === "10" || action.name === "matchResume";
}

// ─── renderers ───

function renderClient(scope: RuntimeScope): string {
  const lines = [`client_name: ${scope.client}`];
  if (scope.department) lines.push(`department: ${scope.department}`);
  return lines.join("\n");
}

// ─── adapter ───

export const matchResumeAdapter: ActionRuntimeAdapter<MatchResumeRuntimeInput> = {
  matches: isMatchResumeAction,
  sentinel: MATCH_RESUME_HIERARCHY_SENTINEL,
  buildSubstitutions: (input, scope) => ({
    [PLACEHOLDER_CLIENT]: renderClient(scope),
    [PLACEHOLDER_JOB]: renderJsonBlock(input.job),
    [PLACEHOLDER_RESUME]: renderJsonBlock(input.resume),
  }),
};
