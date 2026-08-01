import {
  resolveCandidateMobile,
  type CandidateMobileResolution,
  type CandidateMobileStatus,
} from './normalize-e164';

export type CandidateMobileBackfillRow = {
  candidate_id: string;
  mobile: string | null;
  mobile_normalized: string | null;
  needs_mobile_review: boolean;
};

export type CandidateMobileBackfillPlanRow = CandidateMobileBackfillRow & {
  resolution: CandidateMobileResolution;
};

export type CandidateMobileConflict = {
  mobile: string;
  candidateIds: string[];
};

export type CandidateMobileBackfillPlan = {
  rows: CandidateMobileBackfillPlanRow[];
  changed: CandidateMobileBackfillPlanRow[];
  /** Non-empty historical values that cannot be safely canonicalized. They
   * must be reviewed before apply so the backfill never erases the only copy
   * of a contact value. */
  manualReview: CandidateMobileBackfillPlanRow[];
  conflicts: CandidateMobileConflict[];
  statusCounts: Record<CandidateMobileStatus, number>;
};

/**
 * Existing `mobile` and `mobile_normalized` are two representations of one
 * stored fact, not independent contact fields. A disagreement fails closed.
 */
export function resolveStoredCandidateMobile(
  row: CandidateMobileBackfillRow,
): CandidateMobileResolution {
  return resolveCandidateMobile([row.mobile, row.mobile_normalized]);
}

export function buildCandidateMobileBackfillPlan(
  inputRows: CandidateMobileBackfillRow[],
): CandidateMobileBackfillPlan {
  const rows = inputRows.map((row) => ({
    ...row,
    resolution: resolveStoredCandidateMobile(row),
  }));
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.resolution.mobile) continue;
    const ids = groups.get(row.resolution.mobile) ?? [];
    ids.push(row.candidate_id);
    groups.set(row.resolution.mobile, ids);
  }
  const conflicts = [...groups.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([mobile, candidateIds]) => ({ mobile, candidateIds }));
  const statusCounts = rows.reduce<Record<CandidateMobileStatus, number>>(
    (counts, row) => {
      counts[row.resolution.status] += 1;
      return counts;
    },
    { valid: 0, missing: 0, invalid: 0, placeholder: 0, ambiguous: 0 },
  );
  const manualReview = rows.filter(
    (row) =>
      row.resolution.status !== 'valid' &&
      row.resolution.status !== 'missing' &&
      Boolean(row.mobile || row.mobile_normalized),
  );
  const changed = rows.filter((row) => {
    const desired = row.resolution.mobile;
    return (
      row.mobile !== desired ||
      row.mobile_normalized !== desired ||
      row.needs_mobile_review !== (row.resolution.status !== 'valid')
    );
  });

  return { rows, changed, manualReview, conflicts, statusCounts };
}

/** Candidate ids that violate the post-backfill storage invariant. */
export function candidateMobileVerificationFailures(
  rows: CandidateMobileBackfillRow[],
): string[] {
  return rows.flatMap((row) => {
    const resolution = resolveStoredCandidateMobile(row);
    const expectedReview = resolution.status !== 'valid';
    return row.mobile === row.mobile_normalized &&
      row.mobile === resolution.mobile &&
      row.needs_mobile_review === expectedReview
      ? []
      : [row.candidate_id];
  });
}
