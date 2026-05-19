/**
 * Prompt builder for the full `rule-check` impl.
 *
 * The critical coupling (SPEC §3): the prompt fed to the LLM is the verbatim
 * output of `generatePrompt()`, with a focusing system message prepended.
 *
 * Pipeline:
 *   1. Call `generatePrompt()` WITHOUT runtime input → templated ActionObjectV4
 *      (placeholders intact). Hash that → `actionObjectSha256`.
 *   2. Apply `fillRuntimeInput()` → resolved ActionObjectV4 (placeholders
 *      substituted with real candidate/job data). Hash that (with the
 *      `## 当前时间` block stripped) → `promptSha256`.
 *   3. Return `{ system, user, provenance, templatedActionObject, resolvedActionObject }`.
 *
 * The two hashes serve different audit purposes:
 *   - `actionObjectSha256` proves the rule set + schema + execution constraints
 *     didn't change (drift detector against generatePrompt's output over time).
 *   - `promptSha256` proves the exact bytes sent to the LLM (drift detector
 *     against the resolved per-call prompt, modulo the deliberate stripping
 *     of `## 当前时间` which is non-deterministic by construction).
 */

import { createHash } from "node:crypto";

import type { ExtraInstance } from "../../ontology-gen/v4/assemble-v4-4";
import { generatePrompt, type GeneratePromptOptions } from "../../ontology-gen/v4/generate-prompt";
import { fillRuntimeInput } from "../../ontology-gen/v4/fill-runtime-input";
import type { ActionObjectV4 } from "../../ontology-gen/v4/types";
import type {
  RuntimeInputV4,
  RuntimeScope,
} from "../../ontology-gen/v4/runtime-adapters/types";

import { FOCUSING_SYSTEM_MESSAGE } from "./focusing-system";
import { rcDebug, shortSha } from "../debug";
import type { PromptProvenance } from "../types-audited";

export interface BuildEvalPromptOptions {
  actionRef: string;
  client: string;
  clientDepartment?: string;
  domain: string;
  runtimeInput: RuntimeInputV4;
  /**
   * Optional prefetched Ontology instances rendered into `## 额外数据` section.
   * fetchedInstanceIndex begins at 2 (Job=0, Resume=1).
   */
  extraInstances?: ExtraInstance[];
  /** Override env for the upstream `generatePrompt` call. */
  apiBase?: string;
  apiToken?: string;
  timeoutMs?: number;
  /**
   * Path C: when set, build a slim per-step prompt scoped to this stepOrder
   * (forwarded to `assembleActionObjectV4_4`). Omit for full-envelope.
   */
  focusStep?: number;
}

export interface BuildEvalPromptResult {
  system: string;
  user: string;
  provenance: PromptProvenance;
  templatedActionObject: ActionObjectV4;
  resolvedActionObject: ActionObjectV4;
}

export async function buildEvalPrompt(
  opts: BuildEvalPromptOptions,
): Promise<BuildEvalPromptResult> {
  // ── Step 1: templated action object (placeholders intact).
  // Includes extraInstances so the ## 额外数据 section renders into both the
  // templated and the resolved form — that section is data-driven (not
  // placeholder-substituted), so it must be in the same shape both times.
  const templatedOpts: GeneratePromptOptions = {
    actionRef: opts.actionRef,
    client: opts.client,
    clientDepartment: opts.clientDepartment,
    domain: opts.domain,
    extraInstances: opts.extraInstances,
    apiBase: opts.apiBase,
    apiToken: opts.apiToken,
    timeoutMs: opts.timeoutMs,
    focusStep: opts.focusStep,
    // intentionally omit runtimeInput so generatePrompt returns templated form
  };
  const templated = await generatePrompt(templatedOpts);
  rcDebug("prompt-build", "templated action object", {
    actionRef: opts.actionRef,
    promptChars: templated.prompt.length,
    placeholders:
      (templated.prompt.match(/\{\{[A-Z_]+\}\}/g) ?? []).length,
  });

  // ── Step 2: resolve runtime input locally (no second fetchAction call).
  const scope: RuntimeScope = {
    client: opts.client,
    department: opts.clientDepartment,
  };
  const resolved = fillRuntimeInput(templated, opts.runtimeInput, scope);
  const remainingPlaceholders = (resolved.prompt.match(/\{\{[A-Z_]+\}\}/g) ?? []).length;
  rcDebug("prompt-build", "resolved runtime input", {
    resolvedChars: resolved.prompt.length,
    remainingPlaceholders,
  });

  // ── Step 3: capture provenance.
  const resolvedAt = new Date().toISOString();
  const provenance: PromptProvenance = {
    promptSha256: sha256(stripCurrentTimeBlock(resolved.prompt)),
    actionObjectSha256: sha256(stripCurrentTimeBlock(templated.prompt)),
    generatePromptInput: {
      actionRef: opts.actionRef,
      client: opts.client,
      clientDepartment: opts.clientDepartment,
      domain: opts.domain,
      runtimeInputDigest: sha256(
        stableStringify({
          runtimeInput: opts.runtimeInput,
          extraInstances: opts.extraInstances ?? [],
        }),
      ),
    },
    resolvedAt,
  };
  rcDebug("prompt-build", "provenance captured", {
    promptSha: shortSha(provenance.promptSha256),
    actionObjectSha: shortSha(provenance.actionObjectSha256),
    runtimeInputDigest: shortSha(provenance.generatePromptInput.runtimeInputDigest),
  });

  return {
    system: FOCUSING_SYSTEM_MESSAGE,
    user: resolved.prompt,
    provenance,
    templatedActionObject: templated,
    resolvedActionObject: resolved,
  };
}

// ─── helpers ───

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

/**
 * Strip the `## 当前时间` block (and its content) so the hash is stable across
 * runs. `assemble-v4-4.ts` emits this block with a timestamp/placeholder; the
 * block is intentionally non-deterministic, so we omit it from drift detection.
 */
function stripCurrentTimeBlock(prompt: string): string {
  // Match "## 当前时间" header through to the next "## " header or EOF.
  return prompt.replace(/##\s*当前时间[\s\S]*?(?=\n##\s|\s*$)/u, "");
}

/**
 * Deterministic JSON stringify — sorts object keys recursively. Used to make
 * the runtime input digest stable across property-iteration orderings.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
