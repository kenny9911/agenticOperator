/**
 * Common prompt assembly — produces the final {prompt, meta} ActionObjectV4
 * given enriched action + per-step instructions + per-rule instructions.
 *
 * All three v4 strategies (V4-1, V4-2, V4-3) call this same function so the
 * resulting prompt content is identical across variants. Strategies differ
 * only in WHEN they call it and HOW they persist the inputs.
 */

import { applyClientFilter } from "../compile/filter";

import type { ActionOutput, ActionRule, ActionStep } from "../types.public";

import type {
  ActionObjectV4,
  ActionObjectMetaV4,
  AssemblePromptInput,
  PromptStrategy,
  RuleInstruction,
  StepInstruction,
  ValidationReport,
} from "./types";

const RUNTIME_INPUT_PLACEHOLDER = "{{RUNTIME_INPUT}}";
const CURRENT_TIME_PLACEHOLDER = "{{CURRENT_TIME}}";
const STEP_RESULT_STATUS = "not_started|completed|blocked|pending_human";

export interface AssembleOpts {
  strategy: PromptStrategy;
  /** When provided, replaces {{RUNTIME_INPUT}} in the final prompt. */
  runtimeInput?: string | Record<string, unknown>;
}

export function assembleActionObject(
  input: AssemblePromptInput,
  opts: AssembleOpts,
): ActionObjectV4 {
  const filteredAction = input.client
    ? applyClientFilter(input.enriched.action, { client: input.client })
    : input.enriched.action;

  const sections: string[] = [];
  sections.push(renderTaskHeader(filteredAction));
  sections.push(renderInputsBlock(input.runtimeInput));
  sections.push(renderOutputSchema(filteredAction));
  sections.push(renderProcedureOverview(filteredAction, input.stepInstructions));

  for (const step of [...filteredAction.actionSteps].sort((a, b) => a.order - b.order)) {
    const stepInstr = input.stepInstructions[step.order];
    sections.push(
      renderStep(step, stepInstr, input.ruleInstructions, filteredAction.actionSteps.length),
    );
  }

  sections.push(renderFinalConsolidation(filteredAction));
  sections.push(renderVerification());

  const prompt = sections.join("\n\n");

  const meta: ActionObjectMetaV4 = {
    actionId: filteredAction.id,
    actionName: filteredAction.name,
    domain: input.enriched.action.id ? "RAAS-v1" : "RAAS-v1", // domain is on enriched, default for now
    client: input.client,
    compiledAt: new Date().toISOString(),
    templateVersion: "v4",
    promptStrategy: opts.strategy,
    validation: buildValidation(input, filteredAction),
  };

  return { prompt, meta };
}

// ── section renderers ──

function renderTaskHeader(action: { name: string; description: string; category: string; actor: string[]; trigger: string[] }): string {
  return [
    `## Your task`,
    ``,
    `You are the decision-making agent for action \`${action.name}\`. You receive structured input data and produce a structured JSON output. The runtime executes any data writes, notifications, and flow transitions based on your output — you do NOT directly read or write data stores.`,
    ``,
    `Action context:`,
    `- Category: ${action.category || "(unspecified)"}`,
    `- Actor: ${action.actor.join(", ") || "Agent"}`,
    `- Trigger event(s): ${action.trigger.join(", ") || "(none)"}`,
    ``,
    `Action description:`,
    action.description || "(no description)",
  ].join("\n");
}

function renderInputsBlock(runtimeInput: string | Record<string, unknown> | undefined): string {
  let body: string;
  if (runtimeInput === undefined) {
    body = RUNTIME_INPUT_PLACEHOLDER;
  } else if (typeof runtimeInput === "string") {
    body = runtimeInput;
  } else {
    body = "```json\n" + JSON.stringify(runtimeInput, null, 2) + "\n```";
  }
  return [
    `## Inputs you will receive`,
    ``,
    `The runtime supplies a JSON object with the following input data:`,
    ``,
    body,
  ].join("\n");
}

function renderOutputSchema(action: {
  outputs: ActionOutput[];
  actionSteps: ActionStep[];
}): string {
  const lines = [
    `## Final output schema`,
    ``,
    `Return a single JSON object matching this shape. Keep all top-level keys shown below; do not add unrelated keys.`,
    ``,
  ];
  for (const o of action.outputs ?? []) {
    lines.push(`- \`${o.name}\` (${o.type}): ${o.description}`);
  }
  // Always-present scaffolding fields the agent maintains across steps:
  lines.push(``, `Plus these structural fields you maintain across step execution:`);
  lines.push(`- \`step_results\`: a JSON object keyed by step order, each value is that step's intermediate output`);
  lines.push(`- \`notifications\`: a JSON array of notification entries, each like \`{ "recipient": <string>, "channel": "InApp"|"Email", "trigger_rule_id": <string>, "reason": <string> }\``);
  lines.push(`- \`terminal\`: boolean — set to \`true\` when a blocker rule fires and you must stop early`);
  lines.push(``, `Use this JSON skeleton as the response contract:`, ``);
  lines.push("```json");
  lines.push(renderFinalOutputSkeleton(action));
  lines.push("```");
  return lines.join("\n");
}

function renderProcedureOverview(
  action: { actionSteps: ActionStep[] },
  stepInstructions: Record<number, StepInstruction>,
): string {
  const lines = [
    `## Procedure overview`,
    ``,
    `You will execute the following ${action.actionSteps.length} step(s) in order. Each step has its own intermediate output structure. After all steps complete, you consolidate intermediate outputs into the final output.`,
    ``,
  ];
  for (const s of [...action.actionSteps].sort((a, b) => a.order - b.order)) {
    const summary = summarizeStep(s, stepInstructions[s.order]);
    lines.push(`  Step ${s.order}: ${s.name}${summary ? ` — ${summary}` : ""}`);
  }
  return lines.join("\n");
}

function renderStep(
  step: ActionStep,
  stepInstr: StepInstruction | undefined,
  ruleInstructions: Record<string, RuleInstruction>,
  totalSteps: number,
): string {
  const header = `═════════════════════════════════════════════════════════════════════\n## Step ${step.order}: ${step.name} [${step.objectType || "logic"}]`;
  const stepSections = extractStepSections(step, stepInstr);

  const ruleBlocks: string[] = [];
  for (const r of step.rules) {
    const instr = ruleInstructions[r.id];
    if (instr) {
      ruleBlocks.push(`${renderRuleHeader(r)}\n\n${instr.instruction}`);
    } else {
      ruleBlocks.push(`${renderRuleHeader(r)}\n\n(no instruction generated; original prose unavailable)`);
    }
  }
  const rulesSection =
    ruleBlocks.length > 0
      ? `### Rules in Step ${step.order}\n\n${ruleBlocks.join("\n\n---\n\n")}`
      : `### Rules in Step ${step.order}\n\n(this step has no business rules; perform per the description above and produce step_${step.order} output)`;

  const intermediate = [
    `### Step ${step.order} intermediate output structure`,
    ``,
    `Initialize \`step_${step.order}_result\`:`,
    ``,
    "```json",
    renderStepResultSkeleton(step),
    "```",
  ].join("\n");

  const completion = [
    `### Step ${step.order} completion`,
    ``,
    stepSections.completion,
    ``,
    `Once you have evaluated all rules above (or stopped on a blocker), confirm:`,
    `- \`step_${step.order}_result\` is populated according to the structure shown`,
    `- If a blocker fired: set \`final_output.terminal = true\` and return \`final_output\` now`,
    `- ${step.order < totalSteps ? `Otherwise: copy \`step_${step.order}_result\` to \`final_output.step_results.step_${step.order}\`, then proceed to Step ${step.order + 1}` : `Otherwise: copy \`step_${step.order}_result\` to \`final_output.step_results.step_${step.order}\`, then proceed to Final output consolidation`}`,
  ].join("\n");

  return [
    header,
    ``,
    `### What this step accomplishes`,
    ``,
    stepSections.accomplishes,
    ``,
    intermediate,
    ``,
    `### Step ${step.order} evaluation procedure`,
    ``,
    stepSections.procedure,
    ``,
    rulesSection,
    ``,
    completion,
  ].join("\n");
}

function renderFinalConsolidation(action: { outputs: Array<{ name: string }> }): string {
  return [
    `═════════════════════════════════════════════════════════════════════`,
    `## Final output consolidation`,
    ``,
    `After all steps complete (or a blocker fired), build \`final_output\` from the per-step intermediate results:`,
    ...action.outputs.map((o) => `- \`${o.name}\`: derive from the relevant step_results entries`),
    `- \`notifications\`: aggregate all notifications appended across steps`,
    `- \`terminal\`: true if any blocker fired in any step, else false`,
    ``,
    `Your final output is a single JSON object containing all top-level fields from the schema, including \`step_results\` (for traceability).`,
  ].join("\n");
}

function renderVerification(): string {
  return [
    `## Verification before responding`,
    ``,
    `Before producing your output, verify:`,
    `1. The output JSON conforms to "Final output schema" — all required keys present, no extra keys.`,
    `2. Every \`blocking_rule_id\` (or equivalent) referenced in the output traces back to a rule in step_results that actually fired.`,
    `3. Every entry in \`notifications\` corresponds to a rule whose ACTION specified a notification.`,
    `4. \`step_results\` contains entries for every step you executed, or execution stopped early with \`terminal=true\`.`,
    `5. \`terminal\` is true if and only if a blocker rule fired during execution.`,
  ].join("\n");
}

// ── prompt-shape helpers ──

function extractStepSections(step: ActionStep, stepInstr: StepInstruction | undefined): {
  accomplishes: string;
  procedure: string;
  completion: string;
} {
  const fallbackAccomplishes = step.description || "(no step description available)";
  const ruleIds = step.rules.map((r) => r.id).join(", ") || "(none)";
  const fallbackProcedure = [
    `Evaluate this step's rules in the order shown below: ${ruleIds}.`,
    `Maintain \`step_${step.order}_result\` as the step-local working object and \`final_output\` as the top-level response object.`,
    `If a blocker rule fires, stop evaluating further rules and return immediately as instructed by that rule. Otherwise, accumulate non-blocker findings into \`step_${step.order}_result\` and continue.`,
  ].join(" ");
  const fallbackCompletion = `This step is complete when all rules above have been evaluated, or when a blocker fired and execution stopped.`;

  if (!stepInstr?.description) {
    return {
      accomplishes: fallbackAccomplishes,
      procedure: fallbackProcedure,
      completion: fallbackCompletion,
    };
  }

  return {
    accomplishes:
      extractSection(stepInstr.description, "What this step accomplishes:", "How to perform this step:") ||
      fallbackAccomplishes,
    procedure:
      extractSection(stepInstr.description, "How to perform this step:", "When this step is complete:") ||
      fallbackProcedure,
    completion:
      extractSection(stepInstr.description, "When this step is complete:") ||
      fallbackCompletion,
  };
}

function extractSection(text: string, start: string, end?: string): string {
  const startIdx = text.indexOf(start);
  if (startIdx < 0) return "";
  const bodyStart = startIdx + start.length;
  const endIdx = end ? text.indexOf(end, bodyStart) : -1;
  const raw = text.slice(bodyStart, endIdx >= 0 ? endIdx : undefined).trim();
  return raw;
}

function summarizeStep(step: ActionStep, stepInstr: StepInstruction | undefined): string {
  const sections = extractStepSections(step, stepInstr);
  const seed = sections.accomplishes || step.description || "";
  const firstLine = seed.split(/\n+/)[0]?.trim() ?? "";
  const firstSentence = firstLine.split(/(?<=[.!?。！？])\s+/)[0]?.trim() ?? firstLine;
  return truncate(firstSentence, 120);
}

function renderRuleHeader(rule: ActionRule): string {
  const label = rule.businessLogicRuleName ? ` ${rule.businessLogicRuleName}` : "";
  const meta = [
    rule.severity || "advisory",
    rule.executor || "Agent",
    rule.applicableClient || "通用",
  ].filter(Boolean);
  return `[Rule ${rule.id}]${label} (${meta.join(", ")})`;
}

function renderFinalOutputSkeleton(action: { outputs: ActionOutput[]; actionSteps: ActionStep[] }): string {
  const skeleton: Record<string, unknown> = {};
  for (const output of action.outputs) {
    skeleton[output.name] = placeholderForType(output.type);
  }
  skeleton.notifications = [
    {
      recipient: "<string>",
      channel: "InApp|Email",
      trigger_rule_id: "<string>",
      reason: "<string>",
    },
  ];
  skeleton.terminal = false;
  skeleton.step_results = Object.fromEntries(
    [...action.actionSteps]
      .sort((a, b) => a.order - b.order)
      .map((step) => [`step_${step.order}`, stepResultObject(step)]),
  );
  return JSON.stringify(skeleton, null, 2);
}

function renderStepResultSkeleton(step: ActionStep): string {
  return JSON.stringify(stepResultObject(step), null, 2);
}

function stepResultObject(step: ActionStep): Record<string, unknown> {
  const base: Record<string, unknown> = {
    status: STEP_RESULT_STATUS,
    fired_rule_ids: [],
    blocking_rule_ids: [],
    notifications: [],
  };
  for (const output of step.outputs) {
    if (!(output.name in base)) {
      base[output.name] = placeholderForType(output.type);
    }
  }
  if (step.outputs.length === 0) {
    base.findings = [];
  }
  return base;
}

function placeholderForType(type: string): unknown {
  const normalized = type.trim();
  const listMatch = /^List<(.+)>$/i.exec(normalized);
  if (listMatch) return [`<${listMatch[1]}>`];
  if (/^Map<.+>$/i.test(normalized)) return { "<key>": "<value>" };
  if (/^(Number|Integer|Float)$/i.test(normalized)) return 0;
  if (/^Boolean$/i.test(normalized)) return false;
  if (/^JSON$/i.test(normalized)) return {};
  return `<${normalized || "value"}>`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── meta helpers ──

function buildValidation(
  input: AssemblePromptInput,
  filteredAction: { actionSteps: Array<{ rules: Array<{ id: string }> }> },
): ValidationReport {
  const expectedRuleIds = new Set<string>();
  for (const s of filteredAction.actionSteps) {
    for (const r of s.rules) expectedRuleIds.add(r.id);
  }
  const haveIds = new Set(Object.keys(input.ruleInstructions));
  const missing = [...expectedRuleIds].filter((id) => !haveIds.has(id));
  const failures = Object.values(input.ruleInstructions)
    .filter((ri) => ri.meta.roundTripCheck === "failed")
    .map((ri) => ri.id);
  return {
    driftDetected: false,
    roundTripFailures: failures,
    missingInstructions: missing,
  };
}

export { RUNTIME_INPUT_PLACEHOLDER, CURRENT_TIME_PLACEHOLDER };
