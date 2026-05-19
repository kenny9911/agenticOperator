/**
 * Re-export shim. Real content lives in `./runtime-adapters/match-resume`.
 *
 * Kept at this path to preserve existing deep imports (e.g.
 * `scripts/gen-v4-snapshot.ts`).
 */

export {
  PLACEHOLDER_CLIENT,
  PLACEHOLDER_JOB,
  PLACEHOLDER_RESUME,
  MATCH_RESUME_HIERARCHY_SENTINEL,
  isMatchResumeAction,
} from "./runtime-adapters/match-resume";
