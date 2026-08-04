import { describe, expect, it } from 'vitest';
import { BUILTIN_SCHEMAS } from './builtin';

function schemaFor(name: string) {
  const registration = BUILTIN_SCHEMAS.find((candidate) => candidate.name === name);
  expect(registration).toBeTruthy();
  return registration!.versions[0].schema;
}

function downloadedPayload(overrides: Record<string, unknown> = {}) {
  return {
    upload_id: 'UP-1',
    bucket: 'resumes',
    object_key: 'incoming/resume.pdf',
    ...overrides,
  };
}

describe('resume-processing fallback event schemas', () => {
  it('accepts legacy RESUME_DOWNLOADED without an explicit contract', () => {
    expect(
      schemaFor('RESUME_DOWNLOADED').safeParse({ payload: downloadedPayload() }).success,
    ).toBe(true);
  });

  it('accepts the complete rmhr_deferred v2 contract', () => {
    expect(
      schemaFor('RESUME_DOWNLOADED').safeParse({
        payload: downloadedPayload({
          contract_version: 2,
          processing_mode: 'rmhr_deferred',
          processing_reason: 'rmhr_email_not_found',
          operator_id: 'EMP-OPERATOR',
        }),
      }).success,
    ).toBe(true);
  });

  it('rejects rmhr_deferred when operator_id is missing', () => {
    const parsed = schemaFor('RESUME_DOWNLOADED').safeParse({
      payload: downloadedPayload({
        contract_version: 2,
        processing_mode: 'rmhr_deferred',
        processing_reason: 'rmhr_email_not_found',
      }),
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ['payload', 'operator_id'] })]),
      );
    }
  });
});
