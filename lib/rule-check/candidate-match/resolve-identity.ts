// resolveIdentityMatch — shared identity-dedup resolution used by BOTH the
// candidate-identity rule-check agent AND the resume-parser ingestion seam
// (so the dedup verdict can drive storage BEFORE save).
//
// Compares the incoming candidate against a pre-filtered comparison pool with the
// three-tier identity rules (phone → name+email → 6-field). The engine compares
// per-pair and does NOT return WHICH existing candidate matched, so we capture
// other.candidate_id here at the hit — the SOLE source of same_as_candidate_id.

import { applyIdentityRules, type IdentityMatchResult } from './identity-engine';
import type { CandidateRecord } from './types';
import type { IdentityRule } from './rules-data';
import type { AiFieldJudge } from './field-equivalence';

export type DedupAction = 'auto-merged' | 'pending-review' | 'new-candidate';

export interface IdentityResolution {
  result: IdentityMatchResult;
  poolSize: number;
  /** The matched existing candidate (even for a weak signal we know WHO). null = no match. */
  matchedCandidateId: string | null;
  matchedCandidateName: string | null;
  dedupAction: DedupAction;
  /** ONLY set for a strong (auto-merge) match — the candidate_id to file the resume under.
   *  A weak signal surfaces the suspect for review but must never silently merge. */
  sameAsCandidateId: string | null;
}

/** Minimal repo shape — just the comparison-pool fetch (keeps callers decoupled). */
export interface ComparisonPool {
  findComparisonCandidates(rec: CandidateRecord): Promise<CandidateRecord[]>;
}

const NO_MATCH: IdentityMatchResult = {
  samePerson: false,
  matchedRule: null,
  needsHumanReview: false,
  ruleOutcomes: [],
};

export async function resolveIdentityMatch(
  rec: CandidateRecord,
  repo: ComparisonPool,
  rules: IdentityRule[],
  judge?: AiFieldJudge,
): Promise<IdentityResolution> {
  const pool = await repo.findComparisonCandidates(rec);
  let result: IdentityMatchResult = NO_MATCH;
  let matchedCandidateId: string | null = null;
  let matchedCandidateName: string | null = null;

  for (const other of pool) {
    const r = await applyIdentityRules(rec, other, rules, judge);
    if (r.samePerson) {
      result = r;
      matchedCandidateId = other.candidate_id;
      matchedCandidateName = (other.name ?? null) as string | null;
      break;
    }
    // keep the richest evaluated outcome for the audit even when no dup
    if (result.ruleOutcomes.length === 0) result = r;
  }

  // auto-merged   = strong match (rule 1/2) → file the resume under the existing candidate.
  // pending-review = weak match (rule 3, 6-field) → we know the suspect but NEVER auto-merge.
  // new-candidate  = no match → create a new candidate.
  const dedupAction: DedupAction = result.samePerson
    ? result.needsHumanReview
      ? 'pending-review'
      : 'auto-merged'
    : 'new-candidate';
  const sameAsCandidateId = dedupAction === 'auto-merged' ? matchedCandidateId : null;

  return { result, poolSize: pool.length, matchedCandidateId, matchedCandidateName, dedupAction, sameAsCandidateId };
}
