"use server";

/**
 * Server action — invokes the Simple Rule Checker on behalf of
 * `/dev/simple-rule-check/`.
 *
 * Kept server-side so OpenAI / Ontology API tokens never reach the browser
 * bundle. Mirrors the shape of `app/dev/generate-prompt/actions.ts`.
 */

import { checkRule, type RuleCheckRun } from "@/lib/simple-rule-check";

export interface RunCheckOptions {
  actionRef: string;
  ruleId: string;
  candidateId: string;
  jobRef?: string;
  client: string;
  clientDepartment?: string;
  domain: string;
}

export type RunCheckResult =
  | { ok: true; run: RuleCheckRun }
  | { ok: false; error: string; details?: unknown };

export async function runCheck(opts: RunCheckOptions): Promise<RunCheckResult> {
  try {
    const run = await checkRule({
      actionRef: opts.actionRef,
      ruleId: opts.ruleId,
      candidateId: opts.candidateId,
      jobRef: opts.jobRef,
      scope: { client: opts.client, department: opts.clientDepartment },
      domain: opts.domain,
    });
    return { ok: true, run };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      details: err instanceof Error && err.stack ? { stack: err.stack } : undefined,
    };
  }
}
