/**
 * Single source of truth for the matchResume eval envelope (Path B locked).
 *
 * The envelope is BOTH:
 *   (a) the LLM `response_format.json_schema` constraint consumed by
 *       `lib/rule-check/llm-client.ts`
 *   (b) the human-readable skeleton rendered into `## 最终输出 JSON 结构` by
 *       `assemble-v4-4.ts:renderFinalOutputSchema()`
 *
 * Keeping (a) and (b) in this one file is the deduplication point: if the
 * shape evolves, both the LLM contract and the prompt teaching stay in lock-step.
 *
 * Per SPEC §6.3, locked decisions 2026-05-12:
 *   - Single envelope per matchResume run; one LLM call → one envelope.
 *   - `step_results.<step_N>.rule_judgments[]` is structurally identical to
 *     `rule-check`'s `RuleJudgmentAudited`.
 *   - `final_output.aggregateDecision` is LLM-claimed; orchestrator
 *     re-derives deterministically and cross-checks.
 *   - step4 (`generateMatchResult`) temporarily omits the `score` field
 *     (locked decision, will be reintroduced when scoring spec is finalized).
 */

import { z } from "zod";

import type { Action, ActionStep } from "../types.public";

// ───── Zod (runtime parsing) ─────

const DecisionEnumZod = z.enum([
  "not_started",
  "passed",
  "blocked",
  "pending_human",
]);

const EvidenceZod = z.object({
  sourceType: z.literal("neo4j_instance"),
  objectType: z.string().min(1),
  objectId: z.string().min(1),
  field: z.string().min(1),
  value: z.unknown(),
  fetchedInstanceIndex: z.number().int().min(0),
  decisive: z.boolean(),
});

// `ruleRequirement` removed 2026-05-13 per SPEC §15: the rule's original text
// is already shown on the batch detail page; reproducing it inside every
// judgment was redundant. Three sections kept: 数据观察 / 对照推理 / 结论.
const RootCauseSectionsZod = z.object({
  dataObservation: z.string(),
  contrastReasoning: z.string(),
  conclusion: z.string(),
});

const CounterfactualZod = z.object({
  hypotheticalChange: z.string(),
  predictedDecision: DecisionEnumZod,
  confidence: z.number().min(0).max(1),
});

export const RuleJudgmentZod = z.object({
  ruleId: z.string().min(1),
  decision: DecisionEnumZod,
  evidence: z.array(EvidenceZod),
  rootCause: z.string(),
  rootCauseSections: RootCauseSectionsZod,
  confidence: z.number().min(0).max(1),
  nextAction: z.string(),
  counterfactuals: z.array(CounterfactualZod).optional(),
});

export const StepResultZod = z.object({
  rule_judgments: z.array(RuleJudgmentZod),
});

const FinalOutputZod = z.object({
  aggregateDecision: DecisionEnumZod,
  terminal: z.boolean(),
  triggeredRules: z.array(z.string()),
  notifications: z.array(
    z.object({
      recipient: z.string(),
      channel: z.enum(["InApp", "Email"]),
      trigger_rule_id: z.string(),
      reason: z.string(),
    }),
  ),
});

export const MatchResumeEvalEnvelopeZod = z.object({
  step_results: z.record(z.string(), StepResultZod),
  final_output: FinalOutputZod,
});

export type MatchResumeEvalEnvelope = z.infer<typeof MatchResumeEvalEnvelopeZod>;
export type RuleJudgmentInEnvelope = z.infer<typeof RuleJudgmentZod>;

// ───── JSON Schema (response_format strict mode + skeleton renderer source) ─────
//
// Hand-written to keep precise control over `additionalProperties: false` and
// `required: [...]` which OpenAI's strict mode is picky about. The shape MUST
// mirror MatchResumeEvalEnvelopeZod above exactly; if you edit one, edit both.

const DecisionEnumJsonSchema = {
  type: "string",
  enum: ["not_started", "passed", "blocked", "pending_human"],
} as const;

const EvidenceJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "sourceType",
    "objectType",
    "objectId",
    "field",
    "value",
    "fetchedInstanceIndex",
    "decisive",
  ],
  properties: {
    sourceType: { type: "string", enum: ["neo4j_instance"] },
    objectType: { type: "string" },
    objectId: { type: "string" },
    field: { type: "string" },
    value: {},
    fetchedInstanceIndex: { type: "integer", minimum: 0 },
    decisive: { type: "boolean" },
  },
} as const;

// `ruleRequirement` dropped 2026-05-13 — keep Zod / JSON Schema / skeleton in lock-step.
const RootCauseSectionsJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "dataObservation",
    "contrastReasoning",
    "conclusion",
  ],
  properties: {
    dataObservation: { type: "string" },
    contrastReasoning: { type: "string" },
    conclusion: { type: "string" },
  },
} as const;

const CounterfactualJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["hypotheticalChange", "predictedDecision", "confidence"],
  properties: {
    hypotheticalChange: { type: "string" },
    predictedDecision: DecisionEnumJsonSchema,
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

const RuleJudgmentJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "ruleId",
    "decision",
    "evidence",
    "rootCause",
    "rootCauseSections",
    "confidence",
    "nextAction",
  ],
  properties: {
    ruleId: { type: "string" },
    decision: DecisionEnumJsonSchema,
    evidence: { type: "array", items: EvidenceJsonSchema },
    rootCause: { type: "string" },
    rootCauseSections: RootCauseSectionsJsonSchema,
    confidence: { type: "number", minimum: 0, maximum: 1 },
    nextAction: { type: "string" },
    counterfactuals: { type: "array", items: CounterfactualJsonSchema },
  },
} as const;

export const StepResultJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rule_judgments"],
  properties: {
    rule_judgments: { type: "array", items: RuleJudgmentJsonSchema },
  },
} as const;

const FinalOutputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["aggregateDecision", "terminal", "triggeredRules", "notifications"],
  properties: {
    aggregateDecision: DecisionEnumJsonSchema,
    terminal: { type: "boolean" },
    triggeredRules: { type: "array", items: { type: "string" } },
    notifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["recipient", "channel", "trigger_rule_id", "reason"],
        properties: {
          recipient: { type: "string" },
          channel: { type: "string", enum: ["InApp", "Email"] },
          trigger_rule_id: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

/**
 * Top-level JSON Schema for `response_format.json_schema.schema`.
 *
 * NOTE: OpenAI strict mode disallows `patternProperties`, so `step_results` is
 * typed as a plain object with each step key declared by `renderFinalOutputSkeleton`
 * at prompt-render time. The runtime parse uses `MatchResumeEvalEnvelopeZod`'s
 * `z.record()` which DOES permit dynamic keys; the JSON schema is intentionally
 * looser on `step_results` (declared as `object` with `additionalProperties: <StepResult shape>`).
 */
export const matchResumeEvalEnvelopeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["step_results", "final_output"],
  properties: {
    step_results: {
      type: "object",
      additionalProperties: StepResultJsonSchema,
    },
    final_output: FinalOutputJsonSchema,
  },
} as const;

// ───── Human-readable skeleton renderer (for assemble-v4-4 `## 最终输出 JSON 结构`) ─────

/**
 * Renders a string-form skeleton of the envelope, embedded in the prompt
 * to teach the LLM the expected output shape. Step keys come from
 * `action.actionSteps`, sorted by `step.order`.
 *
 * step4 (`generateMatchResult`) currently has its `score`-bearing outputs
 * suppressed at the rule_judgments[i] level — the rule judgment itself does
 * not carry a `score` field in any step. Score is a separate concern (matchResume
 * action.outputs declare `match_results` and `overall_status`); those are
 * reflected in `final_output.notifications` / `triggeredRules` only.
 */
export function renderEnvelopeSkeleton(action: Action): string {
  const stepEntries: Array<[string, unknown]> = [...action.actionSteps]
    .sort((a, b) => a.order - b.order)
    .map((step) => [`step_${step.order}`, renderStepResultSkeleton(step)]);

  const skeleton: Record<string, unknown> = {
    step_results: Object.fromEntries(stepEntries),
    final_output: {
      aggregateDecision: "passed|blocked|pending_human|not_started",
      terminal: false,
      triggeredRules: ["<string>"],
      notifications: [
        {
          recipient: "<string>",
          channel: "InApp|Email",
          trigger_rule_id: "<string>",
          reason: "<string>",
        },
      ],
    },
  };

  return JSON.stringify(skeleton, null, 2);
}

/**
 * Renders the per-step audit shape `{ rule_judgments: [...] }` as a JSON-stable
 * string for embedding in a slim per-step prompt (Path C). The shape mirrors
 * `StepResultZod` / `StepResultJsonSchema` — change all three together.
 */
export function renderSingleStepEnvelopeSkeleton(step: ActionStep): string {
  return JSON.stringify(renderStepResultSkeleton(step), null, 2);
}

export function renderStepResultSkeleton(_step: ActionStep): Record<string, unknown> {
  return {
    rule_judgments: [
      {
        ruleId: "<string>",
        decision: "not_started|passed|blocked|pending_human",
        evidence: [
          {
            sourceType: "neo4j_instance",
            objectType: "<string>",
            objectId: "<string>",
            field: "<string>",
            value: "<unknown>",
            fetchedInstanceIndex: "<integer>",
            decisive: "<boolean>",
          },
        ],
        rootCause: "<string — 三段中文叙事，对齐 rootCauseSections>",
        rootCauseSections: {
          dataObservation: "<string — 【数据观察】>",
          contrastReasoning: "<string — 【对照推理】>",
          conclusion: "<string — 【结论】>",
        },
        confidence: "<number 0..1>",
        nextAction: "<string>",
        counterfactuals: [
          {
            hypotheticalChange: "<string>",
            predictedDecision: "passed|blocked|pending_human|not_started",
            confidence: "<number 0..1>",
          },
        ],
      },
    ],
  };
}
