/**
 * Output schema for the LLM in the full `rule-check` impl.
 *
 * Path B (locked 2026-05-12): the LLM emits ONE `MatchResumeEvalEnvelope` per
 * run — `{ step_results: { step_N: { rule_judgments[] } }, final_output }` —
 * structurally identical to the envelope rendered by `generatePrompt`'s
 * `## 最终输出 JSON 结构` section. The orchestrator parses the envelope and
 * iterates `step_results[*].rule_judgments[]` to produce per-rule
 * `RuleCheckRunAudited` records.
 *
 * Single source of truth for the envelope shape lives at
 * `lib/ontology-gen/v4/envelope-schema.ts` — this file just re-exports the
 * pieces `rule-check` needs (Zod for parsing, JSON Schema for response_format).
 *
 * Note: `evidence[i].grounded` is intentionally NOT in the LLM-side schema —
 * it is set in-place by post-validation (`validation/evidence-grounded.ts`).
 * Letting the LLM declare itself "grounded" would defeat the validator.
 */

import {
  MatchResumeEvalEnvelopeZod,
  RuleJudgmentZod,
  StepResultJsonSchema as StepResultJsonSchemaInternal,
  StepResultZod as StepResultZodInternal,
  matchResumeEvalEnvelopeJsonSchema,
  type MatchResumeEvalEnvelope as MatchResumeEvalEnvelopeType,
  type RuleJudgmentInEnvelope,
} from "../ontology-gen/v4/envelope-schema";

// Per-judgment shape (kept for validation pipeline, which validates one
// judgment at a time after the envelope is parsed)
export const RuleJudgmentAuditedSchema = RuleJudgmentZod;
export type RuleJudgmentAuditedZod = RuleJudgmentInEnvelope;

// Envelope shapes
export const MatchResumeEvalEnvelopeSchema = MatchResumeEvalEnvelopeZod;
export type MatchResumeEvalEnvelope = MatchResumeEvalEnvelopeType;

/**
 * JSON Schema for OpenAI `response_format.json_schema.schema`. Strict mode
 * compatible. Top-level shape: `{ step_results: { ...stepKeys: {rule_judgments[]}... }, final_output }`.
 */
export const MatchResumeEvalEnvelopeJsonSchema = matchResumeEvalEnvelopeJsonSchema;

/**
 * Per-step output shape used by Path C: each per-step LLM call returns just
 * `{ rule_judgments: [...] }`. Sub-shape of the full envelope's `step_results.<key>`.
 */
export const StepResultJsonSchema = StepResultJsonSchemaInternal;
export const StepResultSchema = StepResultZodInternal;
export type StepResultParsed = ReturnType<typeof StepResultZodInternal.parse>;
