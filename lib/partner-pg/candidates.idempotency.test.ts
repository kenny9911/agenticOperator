import { beforeEach, describe, expect, it, vi } from 'vitest';

type QueryRecord = { text: string; params: unknown[] };
const queries: QueryRecord[] = [];
const externalQuery = vi.hoisted(() =>
  vi.fn(async (_text: string, _params: unknown[] = []) => ({ rows: [] })),
);
let runtimeRows: Array<{
  candidate_id: string | null;
  resume_id: string | null;
  status: string | null;
}> = [];
let transportRows: Array<{ candidate_id: string; resume_id: string }> = [];
let candidateContactRows: Array<{ mobile: string | null; mobile_normalized: string | null }> = [];

vi.mock('./client', () => ({
  withTx: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => {
    const client = {
      query: vi.fn(async (text: string, params: unknown[] = []) => {
        queries.push({ text, params });
        if (/FROM resume_upload_runtime[\s\S]*FOR UPDATE/i.test(text)) {
          return { rows: runtimeRows };
        }
        if (/SELECT resume_id, candidate_id[\s\S]*FROM resume[\s\S]*bucket_name/i.test(text)) {
          return { rows: transportRows };
        }
        if (/SELECT mobile, mobile_normalized[\s\S]*FROM candidate/i.test(text)) {
          return { rows: candidateContactRows };
        }
        if (/UPDATE resume SET[\s\S]*RETURNING resume_id/i.test(text)) {
          return { rows: [{ resume_id: params[0] }] };
        }
        if (/SELECT candidate_id FROM candidate/i.test(text)) return { rows: [] };
        return { rows: [] };
      }),
    };
    return fn(client);
  }),
  query: externalQuery,
}));

import {
  CandidateTransportConflictError,
  markResumeUploadFailed,
  saveCandidateToPartnerPg,
} from './candidates';

const base = {
  upload_id: 'upload-replay',
  bucket: 'recruit-resume-raw',
  object_key: 'resumes/replay.pdf',
  filename: 'replay.pdf',
  employee_id: 'EMP-1',
};

beforeEach(() => {
  queries.length = 0;
  runtimeRows = [];
  transportRows = [];
  candidateContactRows = [];
  externalQuery.mockClear();
});

describe('saveCandidateToPartnerPg — transport idempotency is not identity dedup', () => {
  it('same completed upload refreshes the exact resume and never rewrites Candidate identity', async () => {
    runtimeRows = [{ candidate_id: 'candidate-existing', resume_id: 'resume-existing', status: 'completed' }];
    candidateContactRows = [{ mobile: '13800138000', mobile_normalized: '13800138000' }];

    const result = await saveCandidateToPartnerPg({
      ...base,
      parsed: {
        data: {
          name: '重放时的不同姓名',
          phone: '13900139000',
          mobile: '+65 9123 4567',
          rawText: '重新解析内容',
        },
      },
    });

    expect(result).toMatchObject({
      candidate_id: 'candidate-existing',
      resume_id: 'resume-existing',
      candidate_created: false,
      resume_created: false,
      mobile_normalized: '13800138000',
      mobile_review_status: 'valid',
      idempotent_replay: true,
    });
    expect(queries[0]).toMatchObject({ params: [`upload:${base.upload_id}`] });
    expect(queries[1].text).toMatch(/FROM resume_upload_runtime[\s\S]*FOR UPDATE/i);
    expect(queries.some((q) => /FROM resume[\s\S]*bucket_name = \$1\b/i.test(q.text))).toBe(false);
    expect(queries.some((q) => /SELECT candidate_id FROM candidate/i.test(q.text))).toBe(false);
    expect(queries.some((q) => /INSERT INTO candidate/i.test(q.text))).toBe(false);
    expect(queries.some((q) => /UPDATE candidate SET/i.test(q.text))).toBe(false);
    expect(queries.some((q) => /INSERT INTO resume/i.test(q.text))).toBe(false);

    const resumeRefresh = queries.find((q) => /UPDATE resume SET[\s\S]*RETURNING resume_id/i.test(q.text));
    expect(resumeRefresh?.params[0]).toBe('resume-existing');
    expect(resumeRefresh?.params[1]).toContain('重新解析内容');
    expect(resumeRefresh?.params.slice(-3)).toEqual([
      'candidate-existing',
      base.bucket,
      base.object_key,
    ]);
  });

  it('does not trust unfinished runtime anchors without an exact transport resume', async () => {
    runtimeRows = [{ candidate_id: 'externally-prefilled', resume_id: null, status: 'pending' }];

    await expect(
      saveCandidateToPartnerPg({
        ...base,
        parsed: { data: { name: '张三', phone: '13800138000' } },
      }),
    ).rejects.toThrow(/unproven candidate\/resume anchors/);
    expect(queries.some((q) => /SELECT mobile, mobile_normalized/i.test(q.text))).toBe(false);
  });

  it('accepts unfinished runtime anchors only when the transport resume proves both', async () => {
    runtimeRows = [
      { candidate_id: 'candidate-proven', resume_id: 'resume-proven', status: 'pending' },
    ];
    transportRows = [{ candidate_id: 'candidate-proven', resume_id: 'resume-proven' }];
    candidateContactRows = [{ mobile: '13800138000', mobile_normalized: '13800138000' }];

    const result = await saveCandidateToPartnerPg({
      ...base,
      parsed: { data: { name: '不应覆盖姓名', phone: '13900139000' } },
    });

    expect(result).toMatchObject({
      candidate_id: 'candidate-proven',
      resume_id: 'resume-proven',
      idempotent_replay: true,
    });
    expect(queries.some((q) => /UPDATE candidate SET/i.test(q.text))).toBe(false);
  });

  it('fails closed when the stable transport key has multiple historical resumes', async () => {
    runtimeRows = [{ candidate_id: null, resume_id: null, status: 'pending' }];
    transportRows = [
      { candidate_id: 'candidate-a', resume_id: 'resume-a' },
      { candidate_id: 'candidate-b', resume_id: 'resume-b' },
    ];

    await expect(
      saveCandidateToPartnerPg({
        ...base,
        parsed: { data: { name: '张三', phone: '13800138000' } },
      }),
    ).rejects.toBeInstanceOf(CandidateTransportConflictError);
    expect(queries.some((q) => /INSERT INTO candidate/i.test(q.text))).toBe(false);
  });
});

describe('markResumeUploadFailed replay guard', () => {
  it('never downgrades an already completed runtime row to failed', async () => {
    await markResumeUploadFailed('upload-completed', 'replay failed');

    expect(externalQuery).toHaveBeenCalledOnce();
    const [sql, params] = externalQuery.mock.calls[0];
    expect(sql).toMatch(/status IS DISTINCT FROM 'completed'/i);
    expect(params).toEqual(['upload-completed', 'replay failed']);
  });
});
