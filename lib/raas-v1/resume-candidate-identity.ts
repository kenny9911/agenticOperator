export const RMHR_MANUAL_IDENTITY_SOURCE = 'rmhr_manual_refill' as const;

export type RmhrManualCandidateIdentity = {
  source: typeof RMHR_MANUAL_IDENTITY_SOURCE;
  name: string | null;
  phone: string | null;
};

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Read the operator-supplied identity that RAAS sends only after an RMHR
 * identity-refill request succeeds. Legacy candidate display fields without
 * this source marker are deliberately not authoritative.
 */
export function readRmhrManualCandidateIdentity(
  payload: Record<string, unknown>,
): RmhrManualCandidateIdentity | null {
  const source = payload.candidate_identity_source ?? payload.candidateIdentitySource;
  if (source !== RMHR_MANUAL_IDENTITY_SOURCE) return null;

  const name = nonEmpty(payload.candidate_name) ?? nonEmpty(payload.candidateName);
  const phone = nonEmpty(payload.candidate_phone) ?? nonEmpty(payload.candidatePhone);
  if (!name && !phone) return null;

  return { source: RMHR_MANUAL_IDENTITY_SOURCE, name, phone };
}

const IDENTITY_LOG_KEYS = [
  'candidate_name',
  'candidate_phone',
  'candidateName',
  'candidatePhone',
  'name',
  'phone',
  'mobile',
  'phoneNumber',
  'email',
] as const;

function redactIdentityRecord(input: Record<string, unknown>): Record<string, unknown> {
  const output = { ...input };
  for (const key of IDENTITY_LOG_KEYS) {
    if (key in output && output[key] != null) output[key] = '[REDACTED]';
  }
  if (output.parsed && typeof output.parsed === 'object' && !Array.isArray(output.parsed)) {
    const parsed = { ...(output.parsed as Record<string, unknown>) };
    if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
      parsed.data = redactIdentityRecord(parsed.data as Record<string, unknown>);
    } else {
      // Legacy events sometimes put RoboHire fields directly under `parsed`.
      Object.assign(parsed, redactIdentityRecord(parsed));
    }
    output.parsed = parsed;
  }
  if (
    output.parsed_data &&
    typeof output.parsed_data === 'object' &&
    !Array.isArray(output.parsed_data)
  ) {
    output.parsed_data = redactIdentityRecord(
      output.parsed_data as Record<string, unknown>,
    );
  }
  if (output.parser && typeof output.parser === 'object' && !Array.isArray(output.parser)) {
    const parser = { ...(output.parser as Record<string, unknown>) };
    if (parser.data && typeof parser.data === 'object' && !Array.isArray(parser.data)) {
      parser.data = redactIdentityRecord(parser.data as Record<string, unknown>);
    }
    output.parser = parser;
  }
  return output;
}

/** Redact Candidate identity before RESUME_DOWNLOADED is copied into logs. */
export function redactResumeDownloadedIdentityForLog(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const output = redactIdentityRecord(value as Record<string, unknown>);
  if (output.payload && typeof output.payload === 'object' && !Array.isArray(output.payload)) {
    output.payload = redactIdentityRecord(output.payload as Record<string, unknown>);
  }
  return output;
}
