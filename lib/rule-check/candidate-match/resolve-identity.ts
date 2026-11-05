// resolveIdentityMatch — audit-only candidate similarity resolution.
//
// Compares the incoming candidate against a pre-filtered comparison pool.
// Only a strong mainland-mobile hit is an authoritative identity match. Name /
// email / profile similarities may identify a review suspect but never merge or
// drive Candidate storage.

import { applyIdentityRules, type IdentityMatchResult } from './identity-engine';
import type { CandidateRecord } from './types';
import type { IdentityRule } from './rules-data';
import type { AiFieldJudge } from './field-equivalence';

export type DedupAction = 'phone-match' | 'pending-review' | 'no-match';

export interface IdentityResolution {
  result: IdentityMatchResult;
  poolSize: number;
  /** The matched existing candidate (even for a weak signal we know WHO). null = no match. */
  matchedCandidateId: string | null;
  matchedCandidateName: string | null;
  dedupAction: DedupAction;
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

function isAuthoritativePhoneMatch(result: IdentityMatchResult): boolean {
  if (result.matchedRule?.ruleId !== 'IDENTITY-1') return false;
  const phone = result.matchedRule.fieldResults.find((field) => field.field === 'phone');
  return Boolean(
    phone?.equivalent &&
      phone.method === 'exact' &&
      phone.valueA &&
      phone.valueA === phone.valueB,
  );
}

function forcePhoneAuthority(result: IdentityMatchResult): IdentityMatchResult {
  const ruleId = result.matchedRule?.ruleId;
  return {
    ...result,
    samePerson: true,
    needsHumanReview: false,
    matchedRule: result.matchedRule
      ? { ...result.matchedRule, needsHumanReview: false }
      : null,
    ruleOutcomes: result.ruleOutcomes.map((outcome) =>
      outcome.ruleId === ruleId ? { ...outcome, needsHumanReview: false } : outcome,
    ),
  };
}

function forcePendingReview(result: IdentityMatchResult): IdentityMatchResult {
  const ruleId = result.matchedRule?.ruleId;
  return {
    ...result,
    samePerson: false,
    needsHumanReview: true,
    matchedRule: result.matchedRule
      ? { ...result.matchedRule, needsHumanReview: true }
      : null,
    ruleOutcomes: result.ruleOutcomes.map((outcome) =>
      outcome.ruleId === ruleId ? { ...outcome, needsHumanReview: true } : outcome,
    ),
  };
}

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
  let reviewMatch:
    | { result: IdentityMatchResult; candidateId: string; candidateName: string | null }
    | null = null;

  for (const other of pool) {
    const r = await applyIdentityRules(rec, other, rules, judge);
    if (r.matchedRule) {
      if (isAuthoritativePhoneMatch(r)) {
        // Phone is the only authoritative signal and therefore wins regardless
        // of the repository's OR-prefilter row order.
        result = forcePhoneAuthority(r);
        matchedCandidateId = other.candidate_id;
        matchedCandidateName = (other.name ?? null) as string | null;
        break;
      }
      // Keep the first non-phone suspect for review, but continue scanning: a
      // later row may contain the actual mobile match.
      reviewMatch ??= {
        // Rule data is not trusted to grant identity authority: every non-phone
        // match is review-only even if a custom snapshot sets review=false.
        result: forcePendingReview(r),
        candidateId: other.candidate_id,
        candidateName: (other.name ?? null) as string | null,
      };
      continue;
    }
    // keep the richest evaluated outcome for the audit even when no dup
    if (result.ruleOutcomes.length === 0) result = r;
  }

  if (result.matchedRule?.ruleId !== 'IDENTITY-1' && reviewMatch) {
    result = reviewMatch.result;
    matchedCandidateId = reviewMatch.candidateId;
    matchedCandidateName = reviewMatch.candidateName;
  }

  const phoneMatch = result.samePerson && isAuthoritativePhoneMatch(result);
  const hasReviewSuspect = result.matchedRule !== null && !phoneMatch;
  if (hasReviewSuspect) {
    // Defense in depth for custom rule data: a review-only match can surface a
    // suspect, but it can never carry same-person authority.
    result = { ...result, samePerson: false, needsHumanReview: true };
  }

  const dedupAction: DedupAction = phoneMatch
    ? 'phone-match'
    : hasReviewSuspect
      ? 'pending-review'
      : 'no-match';

  return { result, poolSize: pool.length, matchedCandidateId, matchedCandidateName, dedupAction };
}
