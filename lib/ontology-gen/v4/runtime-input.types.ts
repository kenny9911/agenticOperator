/**
 * Re-export shim. Real content lives in `./runtime-adapters/match-resume`
 * (action-specific types) and `./runtime-adapters/types` (`RuntimeInputV4`
 * generic union + `RuntimeScope`).
 *
 * Kept at this path to preserve existing deep imports (e.g.
 * `scripts/fill-result-prompts.ts`).
 */

export {
  type RuntimeJob,
  type RuntimeResume,
  type MatchResumeRuntimeInput,
} from "./runtime-adapters/match-resume";

export type { RuntimeInputV4, RuntimeScope } from "./runtime-adapters/types";
