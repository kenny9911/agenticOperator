/**
 * Validation #3 — does the LLM's raw JSON parse against the Zod schema?
 * The OpenAI strict json_schema mode should prevent shape violations, but
 * we Zod-parse defensively in case a non-strict-supporting provider is used.
 */

import { RuleJudgmentSchema, type RuleJudgmentZod } from "../output-schema";

export interface SchemaCheckOutput {
  ok: boolean;
  parsed: RuleJudgmentZod | null;
  failures: string[];
}

export function checkSchema(raw: unknown): SchemaCheckOutput {
  const result = RuleJudgmentSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, parsed: result.data, failures: [] };
  }
  const issues = result.error.issues
    .map((iss) => `${iss.path.join(".") || "(root)"}: ${iss.message}`)
    .join("; ");
  return {
    ok: false,
    parsed: null,
    failures: [`schema_invalid:${issues}`],
  };
}
