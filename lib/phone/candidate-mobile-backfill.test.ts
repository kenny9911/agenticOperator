import { describe, expect, it } from 'vitest';
import {
  buildCandidateMobileBackfillPlan,
  candidateMobileVerificationFailures,
  type CandidateMobileBackfillRow,
} from './candidate-mobile-backfill';

function row(
  candidate_id: string,
  mobile: string | null,
  mobile_normalized: string | null,
  needs_mobile_review: boolean,
): CandidateMobileBackfillRow {
  return { candidate_id, mobile, mobile_normalized, needs_mobile_review };
}

describe('candidate mainland-mobile backfill plan', () => {
  it('plans canonical updates without mutating input and blocks destructive placeholder cleanup', () => {
    const input = [
      row('canonicalize', '+86 138-0013-8000', null, true),
      row('placeholder', '13800138888', '13800138888', false),
      row('unchanged', '13900139000', '13900139000', false),
    ];
    const plan = buildCandidateMobileBackfillPlan(input);

    expect(plan.conflicts).toEqual([]);
    expect(plan.changed.map((item) => item.candidate_id)).toEqual([
      'canonicalize',
      'placeholder',
    ]);
    expect(plan.rows[0].resolution).toEqual({ mobile: '13800138000', status: 'valid' });
    expect(plan.rows[1].resolution).toEqual({ mobile: null, status: 'placeholder' });
    expect(plan.manualReview.map((item) => item.candidate_id)).toEqual(['placeholder']);
    expect(input[0].mobile).toBe('+86 138-0013-8000');
  });

  it('reports every candidate id in a canonical-phone conflict instead of choosing a winner', () => {
    const plan = buildCandidateMobileBackfillPlan([
      row('candidate-a', '+86 13800138000', null, true),
      row('candidate-b', '13800138000', '13800138000', false),
    ]);

    expect(plan.conflicts).toEqual([
      { mobile: '13800138000', candidateIds: ['candidate-a', 'candidate-b'] },
    ]);
  });

  it('fails closed when one stored representation is valid but the other is non-empty invalid data', () => {
    const plan = buildCandidateMobileBackfillPlan([
      row('representation-drift', '13800138000', 'not-a-phone', false),
    ]);

    expect(plan.rows[0].resolution).toEqual({ mobile: null, status: 'ambiguous' });
    expect(plan.manualReview.map((item) => item.candidate_id)).toEqual([
      'representation-drift',
    ]);
    expect(plan.changed).toHaveLength(1);
  });

  it('allows a genuinely missing row to set the review flag without treating it as data loss', () => {
    const plan = buildCandidateMobileBackfillPlan([
      row('missing', null, null, false),
    ]);

    expect(plan.manualReview).toEqual([]);
    expect(plan.changed.map((item) => item.candidate_id)).toEqual(['missing']);
  });

  it('verification fails closed for unequal columns or an inconsistent review flag', () => {
    expect(
      candidateMobileVerificationFailures([
        row('ok-valid', '13800138000', '13800138000', false),
        row('ok-review', null, null, true),
        row('drift', '+8613900139000', '13900139000', false),
        row('wrong-review', null, null, false),
      ]),
    ).toEqual(['drift', 'wrong-review']);
  });
});
