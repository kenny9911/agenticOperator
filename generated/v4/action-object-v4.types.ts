/**
 * Consumer-side type ABI for v4 ActionObjects.
 *
 * This file is a HAND-WRITTEN SUBSET of the types exported from
 * `@/lib/ontology-gen/v4`. It is checked into `generated/v4/` so consumers
 * can import only from this file (zero `@/lib/...` dependency, fully
 * portable to other repos).
 *
 * MAINTAINER CHECKLIST when modifying the public ActionObjectV4 shape:
 *   1. Edit `lib/ontology-gen/v4/types.ts` (internal canonical source).
 *   2. Mirror the change here (this file).
 *   3. Re-run `npm run gen:v4-snapshot -- --action <name>` for every snapshot.
 *   4. `npm run build` — any drift surfaces as a TS error at the snapshot site.
 *
 * Do NOT add types to this file that consumers don't need (EnrichedAction,
 * RuleInstruction, etc.). Keep it focused on the consumer ABI.
 */

// ───── ActionObject ─────

export interface ActionObjectV4 {
  prompt: string;
  meta: ActionObjectMetaV4;
}

export interface ActionObjectMetaV4 {
  actionId: string;
  actionName: string;
  domain: string;
  /** Set when the prompt was scoped to a specific client at compile time. */
  client?: string;
  /** ISO 8601. Frozen at codegen time. `fillRuntimeInput` does NOT update this. */
  compiledAt: string;
  templateVersion: "v4";
  promptStrategy: PromptStrategy;
  validation: ValidationReport;
}

export type PromptStrategy = "v4-1" | "v4-2" | "v4-3" | "v4-4";

export interface ValidationReport {
  driftDetected: boolean;
  roundTripFailures: string[];
  missingInstructions: string[];
}

// ───── Runtime input + scope ─────

/**
 * Tenant scope. Passed as the third arg to `fillRuntimeInput`, sourced from
 * `client` + `clientDepartment` at the `generatePrompt` call site.
 *   - `client` drives rule filtering (build-time) AND renders the
 *     `### client` block (fill-time).
 *   - `department` is rendered into the `### client` block when present.
 */
export interface RuntimeScope {
  client: string;
  department?: string;
}

export interface RuntimeJob {
  job_requisition_id: string;
  [field: string]: unknown;
}

export interface RuntimeResume {
  candidate_id: string;
  [field: string]: unknown;
}

export interface MatchResumeRuntimeInput {
  job: RuntimeJob;
  resume: RuntimeResume;
}

export type RuntimeInputV4 = string | Record<string, unknown>;
