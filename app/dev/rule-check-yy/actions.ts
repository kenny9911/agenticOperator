"use server";

/**
 * Server-action surface for `/dev/rule-check`.
 *
 * Pattern matches `app/dev/simple-rule-check/actions.ts`: types are
 * DECLARED LOCALLY (export interface / export type) — re-exporting
 * types from another module breaks Next.js 16's Turbopack "use server"
 * transform with runtime ReferenceErrors. Shapes mirror the internal
 * declarations in `lib/rule-check/server-actions.ts` (kept in sync
 * manually; that file is the source of truth for the implementation).
 */

import { runCheckBatch as _runCheckBatch } from "@/lib/rule-check/server-actions";
import type { RuleCheckBatchRunAudited } from "@/lib/rule-check";

export interface RunCheckBatchOptions {
  actionRef: string;
  candidateId: string;
  jobRef: string;
  client: string;
  clientDepartment?: string;
  domain: string;
  ruleIds?: string[];
}

export type RunCheckBatchResult =
  | { ok: true; batch: RuleCheckBatchRunAudited }
  | { ok: false; error: string; details?: unknown };

export async function runCheckBatch(
  opts: RunCheckBatchOptions,
): Promise<RunCheckBatchResult> {
  return _runCheckBatch(opts);
}
