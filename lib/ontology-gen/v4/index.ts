/**
 * v4 entry point — slim public ABI for the canonical generate-prompt flow.
 *
 * Exposes:
 *   - `generatePrompt` (async) / `fillRuntimeInput` (sync)
 *   - adapter registry surface for adding new actions
 *   - matchResume's concrete types, placeholders, sentinel, predicate and
 *     adapter (re-exported from `./runtime-adapters/match-resume`)
 *   - public v4 types (ActionObjectV4 etc.)
 *
 * The v4-1/2/3 strategy router and LLM-driven pipeline are NOT re-exported
 * here; import from those modules directly if needed.
 */

export { generatePrompt, type GeneratePromptOptions } from "./generate-prompt";
export { fillRuntimeInput } from "./fill-runtime-input";
export { CURRENT_TIME_PLACEHOLDER, RUNTIME_INPUT_PLACEHOLDER } from "./assemble";

// Adapter infrastructure — for adding new actions without touching core.
export {
  registerAdapter,
  findAdapterByAction,
  listAdapters,
  substitute,
  formatBeijingTimeISO,
  renderJsonBlock,
  type ActionRuntimeAdapter,
  type RuntimeInputV4,
  type RuntimeScope,
} from "./runtime-adapters";

// matchResume-specific surface (re-exported from runtime-adapters/match-resume).
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
} from "./runtime-adapters";

export type {
  ActionObjectV4,
  ActionObjectMetaV4,
  EnrichedAction,
  ValidationReport,
  PromptStrategy,
} from "./types";
