/**
 * Adapter contract for v4 runtime-input handling.
 *
 * Each `action` (matchResume, screenCandidate, ...) provides an adapter that
 * tells the v4 core:
 *   - how to recognize the action (`matches`) — used for both sentinel
 *     selection (in `generatePrompt`) and substitution dispatch (in
 *     `fillRuntimeInput`, via `obj.meta.actionId/actionName`)
 *   - what placeholder structure to inject into the prompt (`sentinel`)
 *   - how to render typed input + scope into placeholder substitutions
 *     (`buildSubstitutions`)
 *
 * Core (`generate-prompt.ts`, `fill-runtime-input.ts`) consults the registry
 * only — it never references action-specific constants. Adding a new action =
 * one new adapter file + one `registerAdapter()` call in
 * `runtime-adapters/index.ts`.
 */

/**
 * Tenant scope — the client + optional department this prompt is being
 * generated for. Surfaced as separate function-level params on both
 * `generatePrompt` and `fillRuntimeInput`, decoupled from `runtimeInput`.
 *   - `client` drives rule filtering (via `applyClientFilter`) AND prompt
 *     rendering (the `### client` block).
 *   - `department` is for prompt rendering only (filter-side support is
 *     reserved in `applyClientFilter` but currently a no-op).
 */
export interface RuntimeScope {
  client: string;
  department?: string;
}

export interface ActionRuntimeAdapter<TInput> {
  /**
   * Match by action id or name. Used by `generatePrompt` to choose a sentinel
   * AND by `fillRuntimeInput` to choose the adapter (via `obj.meta.actionId /
   * actionName`).
   */
  matches(action: { id?: string; name?: string }): boolean;

  /**
   * Sentinel string handed to `assembleActionObjectV4_4` as `runtimeInput`.
   * The assembler embeds it verbatim under `## 运行时输入`, so this string
   * should contain any sub-headers + placeholder tokens (e.g. `{{CLIENT}}`)
   * the action's prompt needs.
   */
  sentinel: string;

  /** Map typed input + scope → `{ "{{PLACEHOLDER}}": renderedReplacement }`. */
  buildSubstitutions(input: TInput, scope: RuntimeScope): Record<string, string>;
}

/**
 * Public runtime-input union. Wider than the v1 design: per-action narrow
 * types live with their adapter; callers who want narrowing should refer
 * to those types directly (e.g. `MatchResumeRuntimeInput`).
 *
 * - `string` — substituted verbatim into the single `{{RUNTIME_INPUT}}`
 *   placeholder when no adapter matches.
 * - `Record<string, unknown>` — JSON-stringified into a ```json``` block,
 *   then substituted into `{{RUNTIME_INPUT}}` when no adapter matches; or
 *   passed to an adapter's `buildSubstitutions` when it does.
 *
 * Per-action TS narrowing is no longer available via the union itself
 * (no `kind` discriminator); import the action-specific interface
 * (`MatchResumeRuntimeInput`, etc.) for type-safe construction.
 */
export type RuntimeInputV4 = string | Record<string, unknown>;
