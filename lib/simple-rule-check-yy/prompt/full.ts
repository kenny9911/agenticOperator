/**
 * Full-prompt strategy stub.
 *
 * FULL impl will use `generatePrompt`'s entire output as the LLM input (with
 * a focusing system message limiting evaluation to the requested rule).
 * Deferred per SPEC §3 to v1.1; throws so the orchestrator's strategy selector
 * fails loudly if accidentally pointed at this strategy in MVP.
 */

import type { PromptStrategy } from "./index";

export const fullActionPromptStrategy: PromptStrategy = {
  name: "full-action",
  build() {
    throw new Error(
      "fullActionPromptStrategy is not implemented in MVP. Use extractedRulePromptStrategy.",
    );
  },
};
