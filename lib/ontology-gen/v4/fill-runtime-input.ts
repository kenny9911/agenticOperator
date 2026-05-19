/**
 * Synchronous runtime-input substitution for v4 ActionObjects.
 *
 * The dispatch path:
 *   1. Look up the adapter by action identity: `findAdapterByAction({ id:
 *      obj.meta.actionId, name: obj.meta.actionName })`. If one matches, use
 *      its `buildSubstitutions(input, scope)` to drive substitution.
 *   2. Fallback for unrecognized action: substitute the generic
 *      `{{RUNTIME_INPUT}}` placeholder with either the string verbatim or a
 *      JSON-block render.
 *   3. ALWAYS substitute `{{CURRENT_TIME}}` with the current Beijing time
 *      (ISO-8601 with `+08:00` offset) — universal across all actions.
 *
 * Pure (except for `new Date()` for `{{CURRENT_TIME}}`); never mutates input.
 */

import { CURRENT_TIME_PLACEHOLDER, RUNTIME_INPUT_PLACEHOLDER } from "./assemble";
import { findAdapterByAction } from "./runtime-adapters/registry";
import { substitute } from "./runtime-adapters/substitute";
import type { RuntimeInputV4, RuntimeScope } from "./runtime-adapters/types";
import { formatBeijingTimeISO, renderJsonBlock } from "./runtime-adapters/utils";
import type { ActionObjectV4 } from "./types";

// Ensure adapter modules execute at least once on import path —
// `runtime-adapters/index.ts` runs `registerAdapter(matchResumeAdapter)`.
import "./runtime-adapters";

export function fillRuntimeInput(
  obj: ActionObjectV4,
  input: RuntimeInputV4,
  scope: RuntimeScope,
): ActionObjectV4 {
  const adapter = findAdapterByAction({
    id: obj.meta.actionId,
    name: obj.meta.actionName,
  });

  const adapterSubs: Record<string, string> = adapter
    ? adapter.buildSubstitutions(input, scope)
    : typeof input === "string"
      ? { [RUNTIME_INPUT_PLACEHOLDER]: input }
      : { [RUNTIME_INPUT_PLACEHOLDER]: renderJsonBlock(input) };

  const subs: Record<string, string> = {
    ...adapterSubs,
    [CURRENT_TIME_PLACEHOLDER]: formatBeijingTimeISO(new Date()),
  };

  return { ...obj, prompt: substitute(obj.prompt, subs) };
}
