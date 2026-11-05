import { describe, expect, it } from 'vitest';
import { BUILTIN_SCHEMAS } from './builtin';

describe('JD_APPROVED fallback event contract', () => {
  it('accepts the current RAAS approval envelope used by TaskAssigner', () => {
    const registration = BUILTIN_SCHEMAS.find(
      (candidate) => candidate.name === 'JD_APPROVED',
    );

    expect(registration).toBeTruthy();
    expect(
      registration!.versions[0].schema.safeParse({
        entity_type: 'Job_Requisition',
        entity_id: 'JR-1',
        event_id: 'event-1',
        payload: {
          jd_id: 'JD-1',
          job_requisition_id: 'JR-1',
          approver_id: 'EMP-HSM',
          target_hiring_manager_id: null,
          headcount_total: 3,
          is_confidential: false,
        },
        trace: { trace_id: 'trace-1' },
      }).success,
    ).toBe(true);
  });

  it('rejects approval events without the requisition anchor', () => {
    const registration = BUILTIN_SCHEMAS.find(
      (candidate) => candidate.name === 'JD_APPROVED',
    );

    expect(
      registration!.versions[0].schema.safeParse({
        payload: { jd_id: 'JD-1' },
      }).success,
    ).toBe(false);
  });
});
