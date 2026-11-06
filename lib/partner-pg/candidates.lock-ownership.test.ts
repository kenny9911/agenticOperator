// 锁权威归属校正 — saveCandidateToPartnerPg 对 locked_by_employee_id 的处理。
//
// 语义 (2026-06-11, per raas ADR-0041 "锁在他人则同步真实归属"):
//   - locked_by_employee_id 非空 = RMHR 锁持有人是归属权威:
//       · 新建候选人 → candidate.employee_id 直接写锁持有人 (而非上传者)
//       · dedup 命中 → UPDATE 无条件覆盖 employee_id 为锁持有人 ($13=true 走 CASE)
//   - locked_by_employee_id 为空 = 历史语义不变:
//       · 新建 → employee_id 写上传者
//       · dedup 命中 → COALESCE 仅填空 (公共池才填, 已有归属不动)
//   - resume.uploaded_by 永远记上传者, 不受锁影响。

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture every SQL the writer runs inside withTx.
const queries: Array<{ text: string; params: unknown[] }> = [];
let existingCandidateRow: Record<string, unknown> | undefined;

vi.mock('./client', () => ({
  withTx: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => {
    const client = {
      query: vi.fn(async (text: string, params: unknown[] = []) => {
        queries.push({ text, params });
        if (/SELECT candidate_id FROM candidate\b/i.test(text)) {
          return { rows: existingCandidateRow ? [existingCandidateRow] : [] };
        }
        return { rows: [] };
      }),
    };
    return fn(client);
  }),
  query: vi.fn(async () => ({ rows: [] })),
}));

import { saveCandidateToPartnerPg } from './candidates';

beforeEach(() => {
  queries.length = 0;
  existingCandidateRow = undefined;
});

const UPLOADER = 'EMP-UPLOADER';
const LOCK_HOLDER = 'EMP-LOCK-HOLDER';

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
  return queries.find((q) => /INSERT INTO candidate\b/i.test(q.text));
}
function findCandidateUpdate() {
  return queries.find((q) => /UPDATE candidate SET[\s\S]*employee_id/i.test(q.text));
}
function findResumeInsert() {
  return queries.find((q) => /INSERT INTO resume\b/i.test(q.text));
}

describe('saveCandidateToPartnerPg — locked_by_employee_id 锁权威归属', () => {
  it('新建候选人 + 带锁 → candidate.employee_id 写锁持有人而非上传者', async () => {
    existingCandidateRow = undefined;
    await saveCandidateToPartnerPg({
      ...baseInput,
      locked_by_employee_id: LOCK_HOLDER,
    });

    const insert = findCandidateInsert();
    expect(insert, 'should INSERT candidate').toBeTruthy();
    expect(insert!.params).toContain(LOCK_HOLDER);
    expect(insert!.params).not.toContain(UPLOADER); // candidate 行的归属位不是上传者
  });

  it('新建候选人 + 无锁 → candidate.employee_id 写上传者（历史语义）', async () => {
    existingCandidateRow = undefined;
    await saveCandidateToPartnerPg(baseInput);

    const insert = findCandidateInsert();
    expect(insert).toBeTruthy();
    expect(insert!.params).toContain(UPLOADER);
    expect(insert!.params).not.toContain(LOCK_HOLDER);
  });

  it('dedup 命中 + 带锁 → UPDATE 走锁权威覆盖分支 ($13=true, $11=锁持有人)', async () => {
    existingCandidateRow = { candidate_id: 'cand-existing' };
    await saveCandidateToPartnerPg({
      ...baseInput,
      locked_by_employee_id: LOCK_HOLDER,
    });

    expect(findCandidateInsert(), 'dedup 命中不应 INSERT candidate').toBeFalsy();
    const update = findCandidateUpdate();
    expect(update).toBeTruthy();
    // SQL 必须带 CASE WHEN $13::boolean THEN $11 ELSE COALESCE(employee_id, $11)
    expect(update!.text).toMatch(/CASE WHEN \$13::boolean THEN \$11/i);
    expect(update!.text).toMatch(/ELSE COALESCE\(employee_id, \$11\)/i);
    // $11 (index 10) = 锁持有人, $13 (index 12) = true
    expect(update!.params[10]).toBe(LOCK_HOLDER);
    expect(update!.params[12]).toBe(true);
  });

  it('dedup 命中 + 无锁 → 保持 COALESCE 仅填空语义 ($13=false, $11=上传者)', async () => {
    existingCandidateRow = { candidate_id: 'cand-existing' };
    await saveCandidateToPartnerPg(baseInput);

    const update = findCandidateUpdate();
    expect(update).toBeTruthy();
    expect(update!.params[10]).toBe(UPLOADER);
    expect(update!.params[12]).toBe(false);
  });

  it('带锁时 resume.uploaded_by 仍是上传者 (文件级语义不受锁影响)', async () => {
    existingCandidateRow = undefined;
    await saveCandidateToPartnerPg({
      ...baseInput,
      locked_by_employee_id: LOCK_HOLDER,
    });

    const resumeInsert = findResumeInsert();
    expect(resumeInsert).toBeTruthy();
    expect(resumeInsert!.params).toContain(UPLOADER);
    expect(resumeInsert!.params).not.toContain(LOCK_HOLDER);
  });

  it('锁字段是空串/空白 → 视为无锁, 不触发覆盖', async () => {
    existingCandidateRow = { candidate_id: 'cand-existing' };
    await saveCandidateToPartnerPg({
      ...baseInput,
      locked_by_employee_id: '   ',
    });

    const update = findCandidateUpdate();
    expect(update).toBeTruthy();
    expect(update!.params[10]).toBe(UPLOADER);
    expect(update!.params[12]).toBe(false);
  });
});
