import { describe, it, expect, vi, beforeEach } from 'vitest';

const { query, isConfigured } = vi.hoisted(() => ({ query: vi.fn(), isConfigured: vi.fn() }));
vi.mock('@/lib/partner-pg/client', () => ({
  query,
  isPartnerPgConfigured: isConfigured,
}));

import { candidateFromResumeProcessed, partnerPgCandidateRepo } from './candidate-repo';

describe('candidateFromResumeProcessed', () => {
  it('maps the RESUME_PROCESSED event nested shape into a CandidateRecord', () => {
    const ev = {
      candidate_id: 'cand_1',
      upload_id: 'up_1',
      candidate: {
        name: '张三',
        mobile: '13800138000',
        email: 'z@s.com',
        gender: '男',
        highest_acquired_degree: '本科',
      },
      resume: {
        education_history: [
          { institution: '清华大学', field: '计算机科学与技术', degree: '学士', graduationYear: '2020' },
        ],
      },
    };
    const rec = candidateFromResumeProcessed(ev);
    expect(rec).toMatchObject({
      candidate_id: 'cand_1',
      name: '张三',
      phone: '13800138000',
      email: 'z@s.com',
      gender: '男',
      school: '清华大学',
      major: '计算机科学与技术',
      degree: '学士',
      graduationYear: '2020',
    });
  });

  it('falls back to highest_acquired_degree + upload_id, tolerates missing education', () => {
    const ev = {
      upload_id: 'up_2',
      candidate: { name: '李四', mobile: null, email: 'l@s.com', gender: null, highest_acquired_degree: '硕士' },
      resume: {},
    };
    const rec = candidateFromResumeProcessed(ev);
    expect(rec.candidate_id).toBe('up_2');
    expect(rec.degree).toBe('硕士');
    expect(rec.school).toBeNull();
  });

  it('reads the real producer shape: parsed.data flat fields + education[] (candidate/resume emitted empty)', () => {
    const ev = {
      candidate_id: 'cand_3',
      candidate: {}, // production emits the nested objects empty
      resume: {},
      parsed: {
        data: {
          name: '陈思',
          phone: '13800138000',
          email: 'c@s.com',
          education: [{ school: '北京师范大学', degree: '本科', major: '汉语言文学', endDate: '2021.06' }],
        },
      },
    };
    const rec = candidateFromResumeProcessed(ev);
    expect(rec).toMatchObject({
      candidate_id: 'cand_3',
      name: '陈思',
      phone: '13800138000',
      email: 'c@s.com',
      school: '北京师范大学',
      major: '汉语言文学',
      degree: '本科',
      graduationYear: '2021.06',
    });
  });

  it('never throws on an empty event', () => {
    const rec = candidateFromResumeProcessed({});
    expect(rec.candidate_id).toBe('unknown');
    expect(rec.name).toBeNull();
  });
});

describe('partnerPgCandidateRepo.findComparisonCandidates', () => {
  beforeEach(() => {
    query.mockReset();
    isConfigured.mockReset();
    isConfigured.mockReturnValue(true);
  });

  it('returns [] when no identity signal is present (avoids a full-table scan)', async () => {
    const rows = await partnerPgCandidateRepo.findComparisonCandidates({ candidate_id: 'x' });
    expect(rows).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('prefilters name case/space-insensitively and selects the FLAT raas_v4 columns (graduation_school / highest_acquired_degree)', async () => {
    // raas_v4 candidate 表是扁平列 —— 没有 education_history JSONB。之前 SELECT 该列会
    // 报「column does not exist」,被 catch 静默成 [] → 对比池恒空 → 去重永不命中(真实 bug)。
    query.mockResolvedValue({
      rows: [
        {
          candidate_id: 'old',
          name: 'Zhang San',
          mobile: '13800138000',
          email: 'z@s.com',
          gender: '男',
          graduation_school: '清华大学',
          highest_acquired_degree: '本科',
        },
      ],
    });
    const out = await partnerPgCandidateRepo.findComparisonCandidates({
      candidate_id: 'new',
      name: 'zhang san',
      email: 'z@s.com',
      phone: '13800138000',
    });
    const sql = query.mock.calls[0][0] as string;
    // case/space-insensitive name match (superset of normalizeName)
    expect(sql.toLowerCase()).toContain('lower(replace(name');
    // 必须查实际存在的列,绝不能再 SELECT 不存在的 education_history。
    expect(sql).toContain('graduation_school');
    expect(sql).toContain('highest_acquired_degree');
    expect(sql).not.toContain('education_history');
    expect(out[0]).toMatchObject({
      candidate_id: 'old',
      school: '清华大学', // ← graduation_school
      degree: '本科',     // ← highest_acquired_degree
      major: null,        // raas_v4 candidate 不存 major → null(IDENTITY-3 因此保守不误命中)
      graduationYear: null,
    });
  });

  it('returns [] (not throw) when partner-pg is unconfigured', async () => {
    isConfigured.mockReturnValue(false);
    expect(await partnerPgCandidateRepo.findComparisonCandidates({ candidate_id: 'x', email: 'a@b.com' })).toEqual([]);
  });
});
