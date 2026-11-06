// saveCandidateToPartnerPg — mobile 列存 E.164 规范形(2026-07-21 决策)。
//
// 决策:候选人手机号归一化后写进 candidate.mobile 列,替代原始串。
// 关键不变量:
//   - mobile          = E.164 规范形(号码有效时),无效号退回原始串(绝不丢号);
//   - mobile_normalized(去重键)= 仍从【原始号】计算,逐字节不变(零去重回归)。

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

const base = {
  upload_id: 'up-1',
  bucket: 'recruit-resume-raw',
  object_key: 'resumes/x.pdf',
  etag: 'etag-1',
};

const findInsert = () => queries.find((q) => /INSERT INTO candidate\b/i.test(q.text));
const findUpdate = () => queries.find((q) => /UPDATE candidate SET[\s\S]*employee_id/i.test(q.text));

describe('saveCandidateToPartnerPg — mobile 列存 E.164', () => {
  it('新建:有效中国手机 → mobile 存 E.164,mobile_normalized 仍从原始号算', async () => {
    // 原始号 "138 0000 1111"(带空格);toE164 → +8613800001111
    await saveCandidateToPartnerPg({
      ...base,
      parsed: { data: { name: '张三', mobile: '138 0000 1111' } },
    });
    const insert = findInsert();
    expect(insert).toBeTruthy();
    expect(insert!.params[2]).toBe('+8613800001111'); // $3 = mobile → E.164
    expect(insert!.params[3]).toBe('13800001111'); // $4 = mobile_normalized(原始号去数字,不变)
  });

  it('新建:无效/无法解析号 → mobile 退回原始串(不丢号)', async () => {
    await saveCandidateToPartnerPg({
      ...base,
      parsed: { data: { name: '李四', mobile: '12' } },
    });
    const insert = findInsert();
    expect(insert!.params[2]).toBe('12'); // toE164 失败 → 保留原始
    expect(insert!.params[3]).toBeNull(); // mobile_normalized: <7 位 → null(不变)
  });

  it('新建:国际号 → mobile 存该国 E.164(不盲目补 +86)', async () => {
    await saveCandidateToPartnerPg({
      ...base,
      parsed: { data: { name: 'Alex', mobile: '+65 9123 4567' } },
    });
    const insert = findInsert();
    expect(insert!.params[2]).toBe('+6591234567');
  });

  it('dedup 命中(UPDATE 路径):mobile 也存 E.164', async () => {
    existingCandidateRow = { candidate_id: 'cand-existing' };
    await saveCandidateToPartnerPg({
      ...base,
      parsed: { data: { name: '张三', mobile: '13800001111' } },
    });
    const update = findUpdate();
    expect(update).toBeTruthy();
    expect(update!.params[1]).toBe('+8613800001111'); // $2 = mobile(COALESCE 入参)→ E.164
  });
});
