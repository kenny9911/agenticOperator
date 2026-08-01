/**
 * Candidate mainland-mobile normalization backfill / conflict audit.
 *
 * DEFAULT = READ-ONLY DRY RUN:
 *   npx tsx --env-file=.env.local scripts/backfill-candidate-mainland-mobile.ts
 *
 * APPLY requires an explicit confirmation token and must only run after all AO +
 * RAAS candidate writers are paused and the partner DB is backed up:
 *   npx tsx --env-file=.env.local scripts/backfill-candidate-mainland-mobile.ts \
 *     --apply --confirm=BACKFILL_CANDIDATE_MAINLAND_MOBILE
 *
 * The script never guesses through historical duplicate groups. Any canonical
 * mobile mapped to 2+ candidate_ids aborts apply and prints masked remediation
 * evidence. It does not merge/delete Candidate rows or their downstream records.
 * It also does NOT create a partner-wide UNIQUE index. Cross-writer uniqueness
 * remains a coordinated RAAS/AO schema-and-rollout gate after conflicts are cleared.
 */

import { Pool } from 'pg';
import {
  buildCandidateMobileBackfillPlan,
  candidateMobileVerificationFailures,
  type CandidateMobileBackfillRow,
} from '../lib/phone/candidate-mobile-backfill';

const APPLY = process.argv.includes('--apply');
const CONFIRMED = process.argv.includes('--confirm=BACKFILL_CANDIDATE_MAINLAND_MOBILE');

function partnerUrl(): string {
  const value = process.env.RAAS_PG_URL?.trim() || process.env.RAAS_POSTGRES_URL?.trim();
  if (!value) throw new Error('RAAS_PG_URL / RAAS_POSTGRES_URL is required');
  return value;
}

function masked(mobile: string): string {
  const digits = mobile.replace(/\D/g, '');
  if (digits.length >= 7) return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
  return `<redacted:${mobile.length} chars>`;
}

function maskedStored(value: string | null): string {
  return value ? masked(value) : '<null>';
}

async function main(): Promise<void> {
  if (APPLY && !CONFIRMED) {
    throw new Error(
      '--apply requires --confirm=BACKFILL_CANDIDATE_MAINLAND_MOBILE (dry-run is the default)',
    );
  }

  const pool = new Pool({
    connectionString: partnerUrl(),
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    options: '-c timezone=UTC',
  });

  try {
    const result = await pool.query<CandidateMobileBackfillRow>(
      `SELECT candidate_id, mobile, mobile_normalized, needs_mobile_review
         FROM candidate
        ORDER BY candidate_id`,
    );
    const plan = buildCandidateMobileBackfillPlan(result.rows);

    console.log(
      JSON.stringify(
        {
          mode: APPLY ? 'apply' : 'dry-run',
          total_candidates: plan.rows.length,
          rows_requiring_change: plan.changed.length,
          status_counts: plan.statusCounts,
          manual_review_rows: plan.manualReview.length,
          conflict_groups: plan.conflicts.length,
          conflict_rows: plan.conflicts.reduce(
            (sum, conflict) => sum + conflict.candidateIds.length,
            0,
          ),
        },
        null,
        2,
      ),
    );
    console.log(
      'BOUNDARY: this script does not create a partner-wide UNIQUE index; cross-writer uniqueness still requires a coordinated RAAS/AO rollout.',
    );

    for (const conflict of plan.conflicts) {
      console.error(
        `[CONFLICT] mobile=${masked(conflict.mobile)} candidate_ids=${conflict.candidateIds.join(',')}`,
      );
    }
    for (const row of plan.manualReview) {
      console.error(
        `[REVIEW] candidate_id=${row.candidate_id} status=${row.resolution.status} mobile=${maskedStored(row.mobile)} mobile_normalized=${maskedStored(row.mobile_normalized)}`,
      );
    }

    if (!APPLY) {
      console.log('DRY RUN ONLY: no rows were written.');
      return;
    }
    if (plan.conflicts.length > 0) {
      throw new Error(
        `apply refused: ${plan.conflicts.length} normalized-mobile conflict group(s) require reviewed candidate merge plans`,
      );
    }
    if (plan.manualReview.length > 0) {
      throw new Error(
        `apply refused: ${plan.manualReview.length} non-canonical row(s) require manual evidence review; historical contact values will not be erased automatically`,
      );
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('ao:candidate-mainland-mobile-backfill'))`,
      );
      // This table lock conflicts with ordinary INSERT/UPDATE/DELETE writers.
      // It turns the documented maintenance window into an enforced database
      // boundary, including writers that do not participate in AO advisory locks.
      await client.query('LOCK TABLE candidate IN SHARE ROW EXCLUSIVE MODE');
      // Re-read and re-plan under the migration lock. The first read is only the
      // operator preview; apply must never act on a stale plan.
      const applySnapshot = await client.query<CandidateMobileBackfillRow>(
        `SELECT candidate_id, mobile, mobile_normalized, needs_mobile_review
           FROM candidate
          ORDER BY candidate_id`,
      );
      const applyPlan = buildCandidateMobileBackfillPlan(applySnapshot.rows);
      if (applyPlan.conflicts.length > 0) {
        throw new Error(
          `apply refused after locked recheck: ${applyPlan.conflicts.length} normalized-mobile conflict group(s) require reviewed candidate merge plans`,
        );
      }
      if (applyPlan.manualReview.length > 0) {
        throw new Error(
          `apply refused after locked recheck: ${applyPlan.manualReview.length} non-canonical row(s) require manual evidence review`,
        );
      }

      for (const row of applyPlan.changed) {
        const desired = row.resolution.mobile;
        const update = await client.query(
          `UPDATE candidate
              SET mobile = $2,
                  mobile_normalized = $2,
                  needs_mobile_review = $3,
                  updated_at = NOW()
            WHERE candidate_id = $1`,
          [row.candidate_id, desired, row.resolution.status !== 'valid'],
        );
        if (update.rowCount !== 1) {
          throw new Error(
            `apply update expected 1 row for candidate_id=${row.candidate_id}, received ${update.rowCount ?? 0}`,
          );
        }
      }

      // Verify inside the transaction so any mismatch still rolls every update
      // back. Every row must use one canonical value in both columns, and the
      // review flag must be false exactly for canonical mainland mobiles.
      const verify = await client.query<CandidateMobileBackfillRow>(
        `SELECT candidate_id, mobile, mobile_normalized, needs_mobile_review
           FROM candidate
          ORDER BY candidate_id`,
      );
      const verifyPlan = buildCandidateMobileBackfillPlan(verify.rows);
      if (verifyPlan.conflicts.length > 0) {
        throw new Error(
          `pre-commit verification found ${verifyPlan.conflicts.length} normalized-mobile conflict group(s)`,
        );
      }
      if (verifyPlan.manualReview.length > 0) {
        throw new Error(
          `pre-commit verification found ${verifyPlan.manualReview.length} unresolved manual-review row(s)`,
        );
      }
      const verificationFailures = candidateMobileVerificationFailures(verify.rows);
      if (verificationFailures.length > 0) {
        throw new Error(
          `pre-commit verification failed for ${verificationFailures.length} row(s); sample candidate_ids=${verificationFailures.slice(0, 20).join(',')}`,
        );
      }
      await client.query('COMMIT');
      console.log(
        `APPLIED: ${applyPlan.changed.length} candidate row(s) updated after ${verify.rowCount ?? verify.rows.length} row(s) passed the pre-commit invariant and conflict checks.`,
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
