/**
 * Confidence calculator interface — pluggable so we can A/B different
 * scoring formulas. The full impl ships `composite.ts`.
 */

import type { EvidenceAudited, CompositeConfidenceBreakdown } from "../types-audited";
import type { LogprobToken } from "../llm-client";

export interface ConfidenceCalculateInput {
  /** Value the LLM emitted in its judgment. */
  llmReportedConfidence: number;
  evidence: EvidenceAudited[];
  /** null when the LLM provider didn't return logprobs — degrades formula. */
  logprobs: LogprobToken[] | null;
}

export interface ConfidenceCalculateOutput {
  /** Final composite value in [0, 1]. */
  value: number;
  breakdown: CompositeConfidenceBreakdown;
}

export interface ConfidenceCalculator {
  name: string;
  calculate(input: ConfidenceCalculateInput): ConfidenceCalculateOutput;
}

export { compositeCalculator } from "./composite";
