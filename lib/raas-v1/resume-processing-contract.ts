export const RESUME_PROCESSING_MODES = ['full', 'rmhr_deferred'] as const;
export type ResumeProcessingMode = (typeof RESUME_PROCESSING_MODES)[number];

export const RESUME_PROCESSING_CONTRACT_VERSION = 2;
export const RMHR_EMAIL_NOT_FOUND_PROCESSING_REASON = 'rmhr_email_not_found';

export type ResumeProcessingContract = {
  contract_version: number;
  processing_mode: ResumeProcessingMode;
  processing_reason: typeof RMHR_EMAIL_NOT_FOUND_PROCESSING_REASON | null;
  operator_id: string | null;
};

export type ResumeProcessingContractIssue = {
  path: 'contract_version' | 'processing_mode' | 'processing_reason' | 'operator_id';
  message: string;
};

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Validate the explicit v2 resume-processing contract. A completely absent
 * contract remains valid for legacy events; operator_id alone does not opt an
 * old event into v2 validation.
 */
export function validateResumeProcessingContract(
  value: Record<string, unknown>,
): ResumeProcessingContractIssue[] {
  const hasContract =
    hasOwn(value, 'contract_version') ||
    hasOwn(value, 'processing_mode') ||
    hasOwn(value, 'processing_reason');
  if (!hasContract) return [];

  const issues: ResumeProcessingContractIssue[] = [];
  const version = value.contract_version;
  const mode = value.processing_mode;
  const reason = value.processing_reason;
  const operatorId = nonEmptyString(value.operator_id);

  if (!Number.isInteger(version) || Number(version) < RESUME_PROCESSING_CONTRACT_VERSION) {
    issues.push({
      path: 'contract_version',
      message: `resume processing contract requires contract_version >= ${RESUME_PROCESSING_CONTRACT_VERSION}`,
    });
  }
  if (!RESUME_PROCESSING_MODES.includes(mode as ResumeProcessingMode)) {
    issues.push({
      path: 'processing_mode',
      message: 'resume processing contract requires processing_mode=full or rmhr_deferred',
    });
    return issues;
  }
  if (mode === 'full' && reason != null) {
    issues.push({
      path: 'processing_reason',
      message: 'full processing requires a null processing_reason',
    });
  }
  if (mode === 'rmhr_deferred') {
    if (reason !== RMHR_EMAIL_NOT_FOUND_PROCESSING_REASON) {
      issues.push({
        path: 'processing_reason',
        message: `rmhr_deferred requires processing_reason=${RMHR_EMAIL_NOT_FOUND_PROCESSING_REASON}`,
      });
    }
    if (!operatorId) {
      issues.push({
        path: 'operator_id',
        message: 'rmhr_deferred requires a non-empty operator_id',
      });
    }
  }
  return issues;
}

export function parseResumeProcessingContract(
  value: Record<string, unknown>,
): ResumeProcessingContract | null {
  const hasContract =
    hasOwn(value, 'contract_version') ||
    hasOwn(value, 'processing_mode') ||
    hasOwn(value, 'processing_reason');
  if (!hasContract) return null;

  const issues = validateResumeProcessingContract(value);
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
  }

  return {
    contract_version: value.contract_version as number,
    processing_mode: value.processing_mode as ResumeProcessingMode,
    processing_reason:
      value.processing_mode === 'rmhr_deferred'
        ? RMHR_EMAIL_NOT_FOUND_PROCESSING_REASON
        : null,
    operator_id: nonEmptyString(value.operator_id),
  };
}
