/**
 * Composite confidence — full impl formula per SPEC §7.5.
 *
 *   evidenceCountFactor = clamp01(evidence.length / 3)
 *     (3 pieces saturates; sparse evidence drops confidence)
 *
 *   consistencyFactor = decisive.length / max(1, evidence.length)
 *     (proxy for "does the evidence directly support the verdict?")
 *
 *   logprobScore = exp(avgLogprob(logprobs)) ∈ [0, 1]
 *     (token-level probability of the LLM's output)
 *
 *   FULL formula:     0.4·logprob + 0.3·evidenceCount + 0.3·consistency
 *   DEGRADED formula: 0.5·evidenceCount + 0.5·consistency
 *     (when provider doesn't return logprobs — locked decision #4)
 */

import { rcDebug } from "../debug";
import type {
  ConfidenceCalculator,
  ConfidenceCalculateInput,
  ConfidenceCalculateOutput,
} from "./index";

export const compositeCalculator: ConfidenceCalculator = {
  name: "composite",
  calculate(input: ConfidenceCalculateInput): ConfidenceCalculateOutput {
    const evidenceCountFactor = clamp01(input.evidence.length / 3);
    const decisiveCount = input.evidence.filter((e) => e.decisive).length;
    const consistencyFactor = decisiveCount / Math.max(1, input.evidence.length);

    if (input.logprobs && input.logprobs.length > 0) {
      const avgLogprob =
        input.logprobs.reduce((sum, t) => sum + t.logprob, 0) /
        input.logprobs.length;
      const logprobScore = clamp01(Math.exp(avgLogprob));
      const value = clamp01(
        0.4 * logprobScore +
          0.3 * evidenceCountFactor +
          0.3 * consistencyFactor,
      );
      rcDebug("confidence", "composite_full", {
        value: value.toFixed(3),
        logprobScore: logprobScore.toFixed(3),
        evidenceCountFactor: evidenceCountFactor.toFixed(3),
        consistencyFactor: consistencyFactor.toFixed(3),
        evidence: input.evidence.length,
        decisive: decisiveCount,
        logprobTokens: input.logprobs.length,
        avgLogprob: avgLogprob.toFixed(3),
      });
      return {
        value,
        breakdown: {
          evidenceCountFactor,
          consistencyFactor,
          logprobScore,
          source: "composite_full",
        },
      };
    }

    // Degraded: no logprobs available.
    const value = clamp01(0.5 * evidenceCountFactor + 0.5 * consistencyFactor);
    rcDebug("confidence", "composite_degraded (no logprobs)", {
      value: value.toFixed(3),
      evidenceCountFactor: evidenceCountFactor.toFixed(3),
      consistencyFactor: consistencyFactor.toFixed(3),
      evidence: input.evidence.length,
      decisive: decisiveCount,
    });
    return {
      value,
      breakdown: {
        evidenceCountFactor,
        consistencyFactor,
        logprobScore: null,
        source: "composite_degraded",
      },
    };
  },
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
