/**
 * Strict output schema for LLM RuleJudgment.
 *
 * Two synchronized representations:
 *   - `RuleJudgmentSchema` (Zod) — used at runtime to parse + validate the
 *     LLM's structured output before passing it downstream.
 *   - `RuleJudgmentJsonSchema` — used as `response_format.json_schema.schema`
 *     when calling OpenAI Chat Completions in strict mode.
 *
 * Both must stay in sync. Keep them adjacent in this file.
 */

import { z } from "zod";

// ─── Zod schema (runtime parsing) ───

export const EvidenceSchema = z.object({
  sourceType: z.literal("neo4j_instance"),
  objectType: z.string().min(1),
  objectId: z.string().min(1),
  field: z.string().min(1),
  value: z.unknown(),
});

export const RuleJudgmentSchema = z.object({
  ruleId: z.string().min(1),
  decision: z.enum(["not_started", "passed", "blocked", "pending_human"]),
  evidence: z.array(EvidenceSchema),
  rootCause: z.string(),
  confidence: z.number().min(0).max(1),
  nextAction: z.string(),
});

export type RuleJudgmentZod = z.infer<typeof RuleJudgmentSchema>;

// ─── JSON Schema (for OpenAI response_format) ───

export const RuleJudgmentJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ruleId", "decision", "evidence", "rootCause", "confidence", "nextAction"],
  properties: {
    ruleId: { type: "string" },
    decision: {
      type: "string",
      enum: ["not_started", "passed", "blocked", "pending_human"],
    },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sourceType", "objectType", "objectId", "field", "value"],
        properties: {
          sourceType: { type: "string", enum: ["neo4j_instance"] },
          objectType: { type: "string" },
          objectId: { type: "string" },
          field: { type: "string" },
          value: {},
        },
      },
    },
    rootCause: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    nextAction: { type: "string" },
  },
} as const;
