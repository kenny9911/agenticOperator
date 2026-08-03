export type ResumeDownloadedLockEvidence = {
  locked_by_employee_id: string | null;
  locked_at: string | number | null;
  lock_observed_at: string | number | null;
};

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function timestampValue(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return nonEmptyString(value);
}

/**
 * Read the RMHR lock evidence carried by RESUME_DOWNLOADED.
 *
 * Holder presence is positive lock evidence. Holder absence is never treated
 * as an unlock command. `received_at` is retained as an ordering fallback for
 * legacy RMHR responses that omitted `locked_at`.
 */
export function readResumeDownloadedLockEvidence(
  raw: Record<string, unknown>,
): ResumeDownloadedLockEvidence {
  return {
    locked_by_employee_id:
      nonEmptyString(raw.locked_by_employee_id) ??
      nonEmptyString(raw.lockedByEmployeeId),
    locked_at:
      timestampValue(raw.locked_at) ?? timestampValue(raw.lockedAt),
    lock_observed_at:
      timestampValue(raw.received_at) ?? timestampValue(raw.receivedAt),
  };
}
