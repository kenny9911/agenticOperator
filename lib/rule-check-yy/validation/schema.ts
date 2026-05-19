/**
 * Validation #3 — Zod schema parse against the audit-rich shape.
 *
 * The LLM's response went through OpenAI's strict json_schema, so it should
 * already be shape-correct. This is a defense-in-depth check for providers
 * with looser strict-mode semantics + a parser for downstream consumers.
 */

import { RuleJudgmentAuditedSchema } from "../output-schema-audited";
import type { RuleJudgmentAudited } from "../types-audited";

export interface SchemaCheckOutput {
  ok: boolean;
  failures: string[];
  parsed: RuleJudgmentAudited | null;
}

export function checkSchema(rawJudgment: unknown): SchemaCheckOutput {
  const result = RuleJudgmentAuditedSchema.safeParse(rawJudgment);
  if (result.success) {
    return {
      ok: true,
      failures: [],
      parsed: result.data as RuleJudgmentAudited,
    };
  }
  // Zod v4: `result.error.issues[]` carries field paths + messages.
  const failureTags = result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `schema_invalid:${path}:${issue.message}`;
  });
  return { ok: false, failures: failureTags, parsed: null };
}
