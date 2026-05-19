/**
 * `generatePrompt` — canonical async entry for v4 prompt generation.
 *
 * Internally uses the v4-4 assembler (`assembleActionObjectV4_4`) but exposes
 * a clean signature with no `strategy` concept and typed runtime input. Three
 * usage modes:
 *
 *   1. Static snapshot import + later fill (recommended for production):
 *        import obj from "@/generated/v4/match-resume.action-object";
 *        const ready = fillRuntimeInput(obj, { job, resume }, { client, department });
 *      → no fetch; use the pre-generated snapshot.
 *
 *   2. Runtime resolve with no input → returns prompt with placeholders:
 *        await generatePrompt({ actionRef: "matchResume", client: "腾讯" });
 *
 *   3. Runtime resolve with typed input → returns substituted prompt:
 *        await generatePrompt({
 *          actionRef: "matchResume",
 *          client: "腾讯",
 *          clientDepartment: "互动娱乐事业群",
 *          runtimeInput: { job, resume },
 *        });
 *
 * `client` is required: it drives rule filtering (`applyClientFilter`) AND
 * renders the `### client` block. `clientDepartment` is optional and adds a
 * `department:` line.
 *
 * Sentinel selection is delegated to the adapter registry: whichever adapter
 * `matches(action)` provides the sentinel; falls back to the single
 * `{{RUNTIME_INPUT}}` placeholder when no adapter matches.
 */

import { fetchAction } from "../fetch";

import { RUNTIME_INPUT_PLACEHOLDER } from "./assemble";
import { assembleActionObjectV4_4, type ExtraInstance } from "./assemble-v4-4";
import { fillRuntimeInput } from "./fill-runtime-input";
import { findAdapterByAction } from "./runtime-adapters/registry";
import type { RuntimeInputV4 } from "./runtime-adapters/types";
import type { ActionObjectV4, EnrichedAction } from "./types";

// Ensure adapter modules execute at least once on import path.
import "./runtime-adapters";

export interface GeneratePromptOptions {
  /** Action selector — name (e.g. "matchResume") or id (e.g. "10"). */
  actionRef: string;
  /**
   * Client name. Required — drives rule filtering AND renders the
   * `### client` block. Use the canonical tenant name (e.g. "腾讯", "字节").
   */
  client: string;
  /** Optional department for the `### client` block (no filtering effect). */
  clientDepartment?: string;
  /** Default "RAAS-v1". */
  domain?: string;
  /** Runtime input. When omitted, the prompt retains placeholders unchanged. */
  runtimeInput?: RuntimeInputV4;
  /**
   * Optional prefetched Ontology instances (per-rule data dependencies resolved
   * by `rule-check`'s 含义 A1 fetch layer). When non-empty, an extra
   * `## 额外数据 (按 rule 依赖预取)` section is rendered between `## 运行时输入`
   * and `## 最终输出 JSON 结构`. fetchedInstanceIndex begins at 2 (Job=0, Resume=1).
   */
  extraInstances?: ExtraInstance[];
  /** Override env. */
  apiBase?: string;
  apiToken?: string;
  timeoutMs?: number;
  /**
   * Path C: when set, the assembler produces a slim prompt scoped to the focus
   * step only (`rule_judgments[]` output, no `final_output`). Omit for the
   * Path B / full-envelope form used by `/dev/generate-prompt`.
   */
  focusStep?: number;
}

const DEFAULT_DOMAIN = "RAAS-v1";

export async function generatePrompt(
  opts: GeneratePromptOptions,
): Promise<ActionObjectV4> {
  const domain = opts.domain ?? DEFAULT_DOMAIN;

  const action = await fetchAction({
    actionRef: opts.actionRef,
    domain,
    apiBase: opts.apiBase,
    apiToken: opts.apiToken ?? process.env["ONTOLOGY_API_TOKEN"] ?? "",
    timeoutMs: opts.timeoutMs,
  });

  const enriched: EnrichedAction = {
    action,
    dataObjectSchemas: {},
    eventSchemas: {},
  };

  const adapter = findAdapterByAction(action);
  const sentinel = adapter?.sentinel ?? RUNTIME_INPUT_PLACEHOLDER;

  const obj = assembleActionObjectV4_4({
    enriched,
    client: opts.client,
    domain,
    runtimeInput: sentinel,
    extraInstances: opts.extraInstances,
    focusStep: opts.focusStep,
  });

  if (opts.runtimeInput === undefined) return obj;
  return fillRuntimeInput(obj, opts.runtimeInput, {
    client: opts.client,
    department: opts.clientDepartment,
  });
}
