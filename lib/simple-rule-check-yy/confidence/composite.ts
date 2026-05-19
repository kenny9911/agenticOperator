/**
 * Composite confidence calculator stub — FULL impl.
 *
 * Formula per SPEC §7.5:
 *   confidence = 0.4 × logprob_score
 *              + 0.3 × evidence_count_factor
 *              + 0.3 × consistency_factor
 *
 * Deferred to v1.1; throws if accidentally selected in MVP.
 */

import type { ConfidenceCalculator } from "./index";

export const compositeCalculator: ConfidenceCalculator = {
  name: "composite",
  calculate() {
    throw new Error(
      "compositeCalculator is not implemented in MVP. Use llmSelfReportedCalculator.",
    );
  },
};
