// 候选人写入默认值 — saveCandidateToPartnerPg 的 status / sourcing_channel_id。
//
// 语义 (2026-06-12 业务决策):
//   - candidate.status 默认 'active' (求职中):
//       · 新建候选人 → INSERT 直接写 'active'
//       · dedup 命中 → COALESCE 仅填空, 不覆盖招聘手动维护的状态
//   - sourcing_channel_id 默认 '02001034' (BOSS直聘-AI):
//       · 上游 RESUME_DOWNLOADED 带值 → 上游值优先
//       · 上游缺失 → 回填默认 (取代旧的"不回填以暴露断链"策略)

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

const BOSS_AI_CHANNEL = '02001034';
const EXPLICIT_CHANNEL = '02001001';

const baseInput = {
  upload_id: 'up-1',
  bucket: 'recruit-resume-raw',
  object_key: 'resumes/x.pdf',
  etag: 'etag-1',
  employee_id: 'EMP-UPLOADER',
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

describe('saveCandidateToPartnerPg — status / sourcing_channel_id 默认值', () => {
  it('新建候选人 → status 写 active (求职中)', async () => {
    await saveCandidateToPartnerPg(baseInput);

    const insert = findCandidateInsert();
    expect(insert).toBeTruthy();
    expect(insert!.text).toMatch(/\bstatus\b/);
    // $15 (index 14) = status
    expect(insert!.params[14]).toBe('active');
  });

  it('新建候选人 + 上游未带渠道 → sourcing_channel_id 回填 BOSS直聘-AI', async () => {
    await saveCandidateToPartnerPg(baseInput);

    const insert = findCandidateInsert();
    expect(insert).toBeTruthy();
    // $12 (index 11) = sourcing_channel_id
    expect(insert!.params[11]).toBe(BOSS_AI_CHANNEL);
  });

  it('新建候选人 + 上游带渠道 → 上游值优先, 不被默认覆盖', async () => {
    await saveCandidateToPartnerPg({
      ...baseInput,
      sourcing_channel_id: EXPLICIT_CHANNEL,
    });

    const insert = findCandidateInsert();
    expect(insert!.params[11]).toBe(EXPLICIT_CHANNEL);
  });

  it('dedup 命中 → status 走 COALESCE 仅填空, 不覆盖已有状态', async () => {
    existingCandidateRow = { candidate_id: 'cand-existing' };
    await saveCandidateToPartnerPg(baseInput);

    expect(findCandidateInsert()).toBeFalsy();
    const update = findCandidateUpdate();
    expect(update).toBeTruthy();
    expect(update!.text).toMatch(/status = COALESCE\(status, \$14\)/);
    // $14 (index 13) = 默认 status
    expect(update!.params[13]).toBe('active');
  });

  it('dedup 命中 + 上游未带渠道 → sourcing_channel_id COALESCE 回填默认', async () => {
    existingCandidateRow = { candidate_id: 'cand-existing' };
    await saveCandidateToPartnerPg(baseInput);

    const update = findCandidateUpdate();
    expect(update!.text).toMatch(/sourcing_channel_id = COALESCE\(sourcing_channel_id, \$10\)/);
    // $10 (index 9) = sourcing_channel_id
    expect(update!.params[9]).toBe(BOSS_AI_CHANNEL);
  });
});
