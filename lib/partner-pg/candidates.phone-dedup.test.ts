import { beforeEach, describe, expect, it, vi } from 'vitest';

const queries: Array<{ text: string; params: unknown[] }> = [];
let existingCandidateRows: Array<{ candidate_id: string }> = [];
let updatedCandidateRows: Array<Record<string, unknown>> = [];

vi.mock('./client', () => ({
  withTx: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => {
    const client = {
      query: vi.fn(async (text: string, params: unknown[] = []) => {
        queries.push({ text, params });
        if (/SELECT candidate_id FROM candidate\b/i.test(text)) {
          return { rows: existingCandidateRows };
        }
        if (/UPDATE candidate SET[\s\S]*RETURNING name, mobile/i.test(text)) {
          return { rows: updatedCandidateRows };
        }
        return { rows: [] };
      }),
    };
    return fn(client);
  }),
  query: vi.fn(async () => ({ rows: [] })),
}));

import {
  CandidateMobileConflictError,
  saveCandidateToPartnerPg,
} from './candidates';

const base = {
  upload_id: 'up-phone',
  bucket: 'recruit-resume-raw',
  object_key: 'resumes/phone.pdf',
  etag: 'etag-phone',
  employee_id: 'EMP-1',
};

beforeEach(() => {
  queries.length = 0;
  existingCandidateRows = [];
  updatedCandidateRows = [{
    name: '既有姓名',
    mobile: '13800138000',
    mobile_normalized: '13800138000',
    email: 'stored@example.com',
    gender: null,
    birth_date: null,
    current_location: null,
    highest_acquired_degree: null,
    work_years: null,
    employee_id: 'EMP-1',
  }];
});

const candidateInsert = () => queries.find((q) => /INSERT INTO candidate\b/i.test(q.text));
const candidateUpdate = () =>
  queries.find((q) => /UPDATE candidate SET[\s\S]*employee_id/i.test(q.text));
const mobileLookup = () =>
  queries.find(
    (q) => /SELECT candidate_id FROM candidate/i.test(q.text) && /mobile_normalized/i.test(q.text),
  );
const resumeInsert = () => queries.find((q) => /INSERT INTO resume\b/i.test(q.text));

describe('saveCandidateToPartnerPg — mainland mobile normalization', () => {
  it.each([
    '13800138000',
    '+86 138-0013-8000',
    '0086 138 0013 8000',
  ])('writes %s as the same 11 digits in both candidate columns', async (phone) => {
    const result = await saveCandidateToPartnerPg({
      ...base,
      parsed: { data: { name: '张三', phone } },
    });

    const insert = candidateInsert();
    expect(insert?.params[2]).toBe('13800138000');
    expect(insert?.params[3]).toBe('13800138000');
    expect(insert?.params[15]).toBe(false);
    expect(result.mobile_normalized).toBe('13800138000');
    expect(result.mobile_review_status).toBe('valid');
  });

  it.each([
    ['international', '+65 9123 4567'],
    ['invalid', '12'],
    ['placeholder', '13800138888'],
    ['multiple', '13800138000 / 13900139000'],
  ])('%s phone writes null candidate contact, flags review, and keeps raw resume JSON', async (_, phone) => {
    const result = await saveCandidateToPartnerPg({
      ...base,
      parsed: { data: { name: '李四', phone } },
    });

    const insert = candidateInsert();
    expect(insert?.params[2]).toBeNull();
    expect(insert?.params[3]).toBeNull();
    expect(insert?.params[15]).toBe(true);
    expect(result.mobile_normalized).toBeNull();
    expect(result.mobile_review_status).not.toBe('valid');
    expect(resumeInsert()?.params[6]).toContain(phone);
  });

  it('uses RMHR manual identity for Candidate while preserving raw RoboHire evidence', async () => {
    const result = await saveCandidateToPartnerPg({
      ...base,
      authoritative_identity: {
        source: 'rmhr_manual_refill',
        name: '人工姓名',
        phone: '13800138000',
      },
      parsed: {
        data: {
          name: null,
          phone: '13900139000',
          rawText: 'original parser result',
        },
      },
    });

    const insert = candidateInsert();
    expect(insert?.params[1]).toBe('人工姓名');
    expect(insert?.params[2]).toBe('13800138000');
    expect(insert?.params[3]).toBe('13800138000');
    expect(result.mobile_normalized).toBe('13800138000');
    expect(result.candidate_snapshot).toMatchObject({
      name: '人工姓名',
      mobile: '13800138000',
      mobile_normalized: '13800138000',
    });
    expect(resumeInsert()?.params[6]).toContain('13900139000');
    expect(resumeInsert()?.params[6]).not.toContain('人工姓名');
  });

  it('fails closed on an invalid manual phone instead of falling back to parser phone', async () => {
    const result = await saveCandidateToPartnerPg({
      ...base,
      authoritative_identity: {
        source: 'rmhr_manual_refill',
        name: null,
        phone: 'not-a-phone',
      },
      parsed: { data: { name: '解析姓名', phone: '13800138000' } },
    });

    expect(candidateInsert()?.params[2]).toBeNull();
    expect(result.mobile_normalized).toBeNull();
    expect(result.mobile_review_status).toBe('invalid');
    expect(mobileLookup()).toBeUndefined();
  });
});

describe('saveCandidateToPartnerPg — phone is the only identity key', () => {
  it('serializes and looks up by mobile only, independent of name/email', async () => {
    existingCandidateRows = [{ candidate_id: 'cand-existing' }];
    await saveCandidateToPartnerPg({
      ...base,
      parsed: { data: { name: '完全不同', email: 'other@example.com', phone: '+86 13800138000' } },
    });

    const lock = queries.find(
      (q) => /pg_advisory_xact_lock/i.test(q.text) && q.params[0] === '13800138000',
    );
    const lookup = mobileLookup();
    expect(lock?.params).toEqual(['13800138000']);
    expect(lookup?.text).not.toMatch(/\bname\b/i);
    expect(lookup?.params).toEqual(['13800138000']);
    expect(candidateInsert()).toBeUndefined();
    expect(candidateUpdate()).toBeTruthy();
  });

  it('locks upload and transport identity before taking the canonical-phone lock', async () => {
    await saveCandidateToPartnerPg({
      ...base,
      parsed: { data: { name: '张三', phone: '13800138000' } },
    });

    const uploadLock = queries.findIndex(
      (q) => /pg_advisory_xact_lock/i.test(q.text) && q.params[0] === `upload:${base.upload_id}`,
    );
    const runtimeLookup = queries.findIndex((q) => /FROM resume_upload_runtime/i.test(q.text));
    const transportLock = queries.findIndex(
      (q) =>
        /pg_advisory_xact_lock/i.test(q.text) &&
        typeof q.params[0] === 'string' &&
        q.params[0].startsWith('transport:'),
    );
    const transportLookup = queries.findIndex(
      (q) => /FROM resume\b/i.test(q.text) && /bucket_name = \$1/i.test(q.text),
    );
    const phoneLock = queries.findIndex(
      (q) => /pg_advisory_xact_lock/i.test(q.text) && q.params[0] === '13800138000',
    );
    const phoneLookup = queries.findIndex((q) => q === mobileLookup());

    const ordered = [
      uploadLock,
      runtimeLookup,
      transportLock,
      transportLookup,
      phoneLock,
      phoneLookup,
    ];
    expect(ordered.every((index) => index >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
  });

  it('does not fall back to email+name when there is no strong phone', async () => {
    await saveCandidateToPartnerPg({
      ...base,
      parsed: { data: { name: '张三', email: 'same@example.com', phone: null } },
    });

    expect(mobileLookup()).toBeUndefined();
    expect(
      queries.some((q) => /SELECT candidate_id FROM candidate/i.test(q.text) && /email/i.test(q.text)),
    ).toBe(false);
    expect(candidateInsert()).toBeTruthy();
  });

  it('fails closed instead of choosing one of two historical phone duplicates', async () => {
    existingCandidateRows = [{ candidate_id: 'cand-old-1' }, { candidate_id: 'cand-old-2' }];

    await expect(
      saveCandidateToPartnerPg({
        ...base,
        parsed: { data: { name: '张三', phone: '13800138000' } },
      }),
    ).rejects.toBeInstanceOf(CandidateMobileConflictError);
    expect(candidateInsert()).toBeUndefined();
    expect(mobileLookup()?.text).toMatch(/LIMIT 2/i);
  });

  it('protects an established name on a phone hit', async () => {
    existingCandidateRows = [{ candidate_id: 'cand-existing' }];
    const result = await saveCandidateToPartnerPg({
      ...base,
      parsed: { data: { name: '新解析姓名', phone: '13800138000' } },
    });

    expect(candidateUpdate()?.text).toMatch(
      /name = CASE WHEN name = '未命名候选人' OR name IS NULL/i,
    );
    expect(result.candidate_snapshot?.name).toBe('既有姓名');
  });
});
