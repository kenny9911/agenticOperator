// RMHR lock snapshot persistence — candidate.employee_id / is_locked /
// lock_start_time must move as one tuple. The uploader remains resume.uploaded_by.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const queries: Array<{ text: string; params: unknown[] }> = [];
let existingCandidateRow: Record<string, unknown> | undefined;
let updatedCandidateRow: Record<string, unknown>;

vi.mock('./client', () => ({
  withTx: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => {
    const client = {
      query: vi.fn(async (text: string, params: unknown[] = []) => {
        queries.push({ text, params });
        if (/SELECT candidate_id FROM candidate\b/i.test(text)) {
          return { rows: existingCandidateRow ? [existingCandidateRow] : [] };
        }
        if (/UPDATE candidate SET[\s\S]*RETURNING name, mobile/i.test(text)) {
          return { rows: [updatedCandidateRow] };
        }
        return { rows: [] };
      }),
    };
    return fn(client);
  }),
  query: vi.fn(async () => ({ rows: [] })),
}));

import { saveCandidateToPartnerPg } from './candidates';

const UPLOADER = 'EMP-UPLOADER';
const LOCK_HOLDER = 'EMP-LOCK-HOLDER';
const OTHER_LOCK_HOLDER = 'EMP-OTHER-HOLDER';
const LOCKED_AT_RAW = '2026-07-14 18:05:33';
const LOCKED_AT_ISO = '2026-07-14T10:05:33.000Z';

beforeEach(() => {
  queries.length = 0;
  existingCandidateRow = undefined;
  updatedCandidateRow = {
    name: '张三',
    mobile: '13800001111',
    mobile_normalized: '13800001111',
    email: 'zhangsan@example.com',
    gender: null,
    birth_date: null,
    current_location: null,
    highest_acquired_degree: null,
    work_years: null,
    employee_id: LOCK_HOLDER,
    is_locked: true,
    lock_start_time: new Date(LOCKED_AT_ISO),
  };
});

const baseInput = {
  upload_id: 'up-1',
  bucket: 'recruit-resume-raw',
  object_key: 'resumes/x.pdf',
  etag: 'etag-1',
  employee_id: UPLOADER,
  parsed: {
    data: {
      name: '张三',
      mobile: '13800001111',
      email: 'zhangsan@example.com',
    },
  },
};

function findCandidateInsert() {
  return queries.find((query) => /INSERT INTO candidate\b/i.test(query.text));
}

function findCandidateUpdate() {
  return queries.find((query) =>
    /UPDATE candidate SET[\s\S]*employee_id/i.test(query.text),
  );
}

function findResumeInsert() {
  return queries.find((query) => /INSERT INTO resume\b/i.test(query.text));
}

describe('saveCandidateToPartnerPg — RMHR lock tuple', () => {
  it('new Candidate with lock evidence atomically writes holder, true and Beijing-normalized time', async () => {
    const result = await saveCandidateToPartnerPg({
      ...baseInput,
      locked_by_employee_id: LOCK_HOLDER,
      locked_at: LOCKED_AT_RAW,
    });

    const insert = findCandidateInsert();
    expect(insert, 'should INSERT candidate').toBeTruthy();
    expect(insert!.text).toMatch(/employee_id[\s\S]*is_locked, lock_start_time/i);
    expect(insert!.params[12]).toBe(LOCK_HOLDER);
    expect(insert!.params[16]).toBe(true);
    expect((insert!.params[17] as Date).toISOString()).toBe(LOCKED_AT_ISO);
    expect(insert!.params).not.toContain(UPLOADER);
    expect(result.candidate_lock_snapshot).toEqual({
      employee_id: LOCK_HOLDER,
      is_locked: true,
      lock_start_time: new Date(LOCKED_AT_ISO),
    });
  });

  it('new Candidate without lock evidence stays in the public pool', async () => {
    const result = await saveCandidateToPartnerPg(baseInput);

    const insert = findCandidateInsert();
    expect(insert).toBeTruthy();
    expect(insert!.params[12]).toBeNull();
    expect(insert!.params[16]).toBe(false);
    expect(insert!.params[17]).toBeNull();
    expect(insert!.params).not.toContain(UPLOADER);
    expect(result.candidate_lock_snapshot).toEqual({
      employee_id: null,
      is_locked: false,
      lock_start_time: null,
    });
  });

  it('phone dedup with lock evidence updates all three fields through one freshness gate', async () => {
    existingCandidateRow = { candidate_id: 'cand-existing' };
    const result = await saveCandidateToPartnerPg({
      ...baseInput,
      locked_by_employee_id: LOCK_HOLDER,
      locked_at: LOCKED_AT_RAW,
    });

    expect(findCandidateInsert()).toBeFalsy();
    const update = findCandidateUpdate();
    expect(update).toBeTruthy();
    expect(update!.text).toMatch(/employee_id = CASE[\s\S]*is_locked = CASE[\s\S]*lock_start_time = CASE/i);
    expect(update!.text).toMatch(/lock_start_time <= \(\$15::timestamptz AT TIME ZONE 'UTC'\)/i);
    expect(update!.params[10]).toBe(LOCK_HOLDER);
    expect(update!.params[12]).toBe(true);
    expect((update!.params[14] as Date).toISOString()).toBe(LOCKED_AT_ISO);
    expect(result.candidate_lock_snapshot).toEqual({
      employee_id: LOCK_HOLDER,
      is_locked: true,
      lock_start_time: new Date(LOCKED_AT_ISO),
    });
  });

  it('phone dedup without lock evidence preserves the existing lock tuple and never uses uploader as owner', async () => {
    existingCandidateRow = { candidate_id: 'cand-existing' };
    updatedCandidateRow = {
      ...updatedCandidateRow,
      employee_id: OTHER_LOCK_HOLDER,
      lock_start_time: new Date('2026-07-15T10:05:33.000Z'),
    };

    const result = await saveCandidateToPartnerPg(baseInput);

    const update = findCandidateUpdate();
    expect(update).toBeTruthy();
    expect(update!.params[10]).toBeNull();
    expect(update!.params[12]).toBe(false);
    expect(update!.params[14]).toBeNull();
    expect(update!.text).toMatch(/ELSE employee_id/i);
    expect(update!.text).not.toMatch(/COALESCE\(employee_id/i);
    expect(result.candidate_lock_snapshot).toEqual({
      employee_id: OTHER_LOCK_HOLDER,
      is_locked: true,
      lock_start_time: new Date('2026-07-15T10:05:33.000Z'),
    });
  });

  it('guards an existing newer lock from an older cross-upload lock snapshot', async () => {
    existingCandidateRow = { candidate_id: 'cand-existing' };
    updatedCandidateRow = {
      ...updatedCandidateRow,
      employee_id: OTHER_LOCK_HOLDER,
      lock_start_time: new Date('2026-07-15T10:05:33.000Z'),
    };

    const result = await saveCandidateToPartnerPg({
      ...baseInput,
      locked_by_employee_id: LOCK_HOLDER,
      locked_at: LOCKED_AT_RAW,
    });

    const update = findCandidateUpdate();
    expect(update!.text).toMatch(
      /lock_start_time <= \(\$15::timestamptz AT TIME ZONE 'UTC'\)/i,
    );
    expect(update!.text).toMatch(
      /lock_start_time AT TIME ZONE 'UTC' AS lock_start_time/i,
    );
    expect((update!.params[14] as Date).toISOString()).toBe(LOCKED_AT_ISO);
    expect(result.candidate_lock_snapshot).toEqual({
      employee_id: OTHER_LOCK_HOLDER,
      is_locked: true,
      lock_start_time: new Date('2026-07-15T10:05:33.000Z'),
    });
  });

  it('uses the event observation time when a positive legacy lock omitted locked_at', async () => {
    await saveCandidateToPartnerPg({
      ...baseInput,
      locked_by_employee_id: LOCK_HOLDER,
      lock_observed_at: '2026-07-14T10:06:00.000Z',
    });

    const insert = findCandidateInsert();
    expect((insert!.params[17] as Date).toISOString()).toBe('2026-07-14T10:06:00.000Z');
  });

  it('keeps resume.uploaded_by as uploader even when Candidate is locked', async () => {
    await saveCandidateToPartnerPg({
      ...baseInput,
      locked_by_employee_id: LOCK_HOLDER,
      locked_at: LOCKED_AT_RAW,
    });

    const resumeInsert = findResumeInsert();
    expect(resumeInsert).toBeTruthy();
    expect(resumeInsert!.params).toContain(UPLOADER);
    expect(resumeInsert!.params).not.toContain(LOCK_HOLDER);
  });

  it('blank holder is not lock evidence even if a lock time is present', async () => {
    existingCandidateRow = { candidate_id: 'cand-existing' };
    await saveCandidateToPartnerPg({
      ...baseInput,
      locked_by_employee_id: '   ',
      locked_at: LOCKED_AT_RAW,
    });

    const update = findCandidateUpdate();
    expect(update!.params[10]).toBeNull();
    expect(update!.params[12]).toBe(false);
    expect(update!.params[14]).toBeNull();
  });
});
