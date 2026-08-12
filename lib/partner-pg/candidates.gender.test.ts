// 回归护栏 —— 生产事故 2026-08-12:
//   error: new row for relation "candidate" violates check constraint
//          "candidate_gender_canonical_check"
//
// partner 侧约束:
//   CHECK (gender IS NULL OR gender = ANY (ARRAY['male','female']))
// 而解析器吐的是简历原文('男' / '⼥' / '♂' / '性别：邱杰')。写穿 → 整笔 ingest
// 事务回滚, Candidate + Resume 全丢。这里锁死"落库前必须规范化"。

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
        if (/UPDATE candidate SET[\s\S]*RETURNING name, mobile/i.test(text)) {
          return {
            rows: [
              {
                name: '张三', mobile: '13800001111', mobile_normalized: '13800001111',
                email: null, gender: null, birth_date: null, current_location: null,
                highest_acquired_degree: null, work_years: null,
                employee_id: null, is_locked: false, lock_start_time: null,
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };
    return fn(client);
  }),
  query: vi.fn(async () => ({ rows: [] })),
}));

import { saveCandidateToPartnerPg, type SaveCandidateInput } from './candidates';

beforeEach(() => {
  queries.length = 0;
  existingCandidateRow = undefined;
});

/** partner 的 CHECK 约束,原样搬过来当断言。 */
const ACCEPTED_BY_PARTNER = [null, 'male', 'female'];

const GENDER_PARAM_INDEX = 5; // INSERT INTO candidate (…, email, gender, …) → $6

// gender 声明成 string | null,但运行时是上游 JSON,类型不保真 —— 断言外的
// 非字符串取值正是护栏要挡的,所以这里显式绕过静态类型灌进去。
function inputWithGender(gender: unknown, uploadId: string): SaveCandidateInput {
  return {
    upload_id: uploadId,
    bucket: 'recruit-resume-raw',
    object_key: `resumes/${uploadId}.pdf`,
    etag: 'etag-1',
    employee_id: 'EMP-UPLOADER',
    parsed: { data: { name: '张三', mobile: '13800001111', gender } },
  } as SaveCandidateInput;
}

function candidateInsert() {
  const insert = queries.find((q) => /INSERT INTO candidate\b/i.test(q.text));
  expect(insert, 'expected an INSERT INTO candidate').toBeTruthy();
  return insert!;
}

describe('saveCandidateToPartnerPg — candidate.gender 规范化', () => {
  it('解析器给中文 → 落库写 partner 认的 male/female', async () => {
    await saveCandidateToPartnerPg(inputWithGender('男', 'up-male'));
    expect(candidateInsert().params[GENDER_PARAM_INDEX]).toBe('male');

    queries.length = 0;
    await saveCandidateToPartnerPg(inputWithGender('女', 'up-female'));
    expect(candidateInsert().params[GENDER_PARAM_INDEX]).toBe('female');
  });

  it('无法判定的值 → 落 NULL, 不把整笔简历入库拖崩', async () => {
    // 全部来自 raas_db.resume.raw_parse_result 的真实取值
    for (const [i, raw] of ['性别：邱杰', '未知', '', '   ', null, 42].entries()) {
      queries.length = 0;
      await saveCandidateToPartnerPg(inputWithGender(raw, `up-junk-${i}`));
      expect(candidateInsert().params[GENDER_PARAM_INDEX]).toBeNull();
    }
  });

  it('任何输入下写进 SQL 的值都满足 candidate_gender_canonical_check', async () => {
    const raws = ['男', '女', '⼥', '♂', 'Femenino', 'Male', 'M', '未知', '性别：邱杰', 'x', ''];
    for (const [i, raw] of raws.entries()) {
      queries.length = 0;
      await saveCandidateToPartnerPg(inputWithGender(raw, `up-all-${i}`));
      expect(
        ACCEPTED_BY_PARTNER,
        `gender=${JSON.stringify(raw)} 写出了 partner 不接受的值`,
      ).toContain(candidateInsert().params[GENDER_PARAM_INDEX]);
    }
  });

  it('dedup 命中的 UPDATE 不碰 gender 列(既有值归招聘维护)', async () => {
    existingCandidateRow = { candidate_id: 'cand-existing' };
    await saveCandidateToPartnerPg(inputWithGender('男', 'up-dedup'));

    const update = queries.find((q) => /UPDATE candidate SET[\s\S]*RETURNING name, mobile/i.test(q.text));
    expect(update).toBeTruthy();
    expect(update!.text).not.toMatch(/^\s*gender\s*=/m);
  });
});
