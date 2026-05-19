/**
 * ConfidenceCalculator interface — pluggable confidence sourcing.
 *
 * MVP uses `LLMSelfReported` (pass through LLM's `confidence` field).
 * FULL impl will introduce `Composite` (logprobs + evidence count + multi-
 * evidence consistency).
 */

import type { Evidence } from "../types";

export interface ConfidenceInput {
  /** Whatever the LLM reported in its `confidence` field. */
  llmReportedConfidence: number;
  evidence: Evidence[];
  /** Pass-through from LLM client — may be undefined in non-strict providers. */
  logprobs?: unknown;
}

export interface ConfidenceOutput {
  value: number;          // [0, 1]
  source: "llm_self_reported" | "composite";
  breakdown?: Record<string, number>;
}

export interface ConfidenceCalculator {
  name: string;
  calculate(input: ConfidenceInput): ConfidenceOutput;
}

export { llmSelfReportedCalculator } from "./self-reported";
export { compositeCalculator } from "./composite";
