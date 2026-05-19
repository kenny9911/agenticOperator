/**
 * runtime-adapters barrel + adapter registration.
 *
 * Any import of `@/lib/ontology-gen/v4` transitively pulls this file in
 * (via `lib/ontology-gen/v4/index.ts`), so the side-effect call to
 * `registerAdapter(matchResumeAdapter)` always runs before consumers reach
 * `fillRuntimeInput` / `generatePrompt`.
 *
 * Registration is centralized here (rather than at the bottom of each adapter
 * module) so you can see the full list of registered adapters at a glance.
 *
 * Adding a new action:
 *   1. import its adapter from `./<action>`
 *   2. call `registerAdapter(<action>Adapter)` below
 */

import { registerAdapter } from "./registry";
import { matchResumeAdapter } from "./match-resume";

registerAdapter(matchResumeAdapter);

export type { ActionRuntimeAdapter, RuntimeInputV4, RuntimeScope } from "./types";
export {
  registerAdapter,
  findAdapterByAction,
  listAdapters,
} from "./registry";
export { substitute } from "./substitute";
export { formatBeijingTimeISO, renderJsonBlock } from "./utils";
export {
  PLACEHOLDER_CLIENT,
  PLACEHOLDER_JOB,
  PLACEHOLDER_RESUME,
  MATCH_RESUME_HIERARCHY_SENTINEL,
  isMatchResumeAction,
  matchResumeAdapter,
  type RuntimeJob,
  type RuntimeResume,
  type MatchResumeRuntimeInput,
} from "./match-resume";
