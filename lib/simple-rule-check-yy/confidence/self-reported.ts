/**
 * MVP confidence calculator — pass through the LLM's self-reported value.
 *
 * Clamps to [0, 1] defensively in case schema-strict mode didn't catch an
 * out-of-range value (some non-OpenAI providers run lax).
 */

import type { ConfidenceCalculator, ConfidenceInput, ConfidenceOutput } from "./index";

export const llmSelfReportedCalculator: ConfidenceCalculator = {
  name: "llm-self-reported",
  calculate(input: ConfidenceInput): ConfidenceOutput {
    const v = clamp01(input.llmReportedConfidence);
    return {
      value: v,
      source: "llm_self_reported",
      breakdown: { llm_reported: v },
    };
  },
};

function clamp01(n: number): number {
  if (Number.isNaN(n) || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
