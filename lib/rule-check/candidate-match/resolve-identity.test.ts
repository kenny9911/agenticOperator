import { describe, it, expect } from 'vitest';
import { resolveIdentityMatch } from './resolve-identity';
import { loadCandidateMatchRules, identityRulesByPriority } from './rules-data';
import type { CandidateRecord } from './types';
import type { AiFieldJudge } from './field-equivalence';

const rules = identityRulesByPriority(loadCandidateMatchRules());
const judgeYes: AiFieldJudge = async () => ({ equivalent: true, confidence: 0.95, reason: 'ok' });
const rec: CandidateRecord = { candidate_id: 'new', name: '张三', phone: '13800138000', email: 'z@s.com' };

describe('resolveIdentityMatch', () => {
  it('strong dup (phone) → auto-merged, sameAsCandidateId = matched old id', async () => {
    const repo = {
      findComparisonCandidates: async (): Promise<CandidateRecord[]> => [
        { candidate_id: 'old', name: '不同', phone: '13800138000', email: 'x@y.com' },
      ],
    };
    const r = await resolveIdentityMatch(rec, repo, rules, judgeYes);
    expect(r.dedupAction).toBe('auto-merged');
    expect(r.matchedCandidateId).toBe('old');
    expect(r.sameAsCandidateId).toBe('old'); // the id the resume should be filed under
  });

  it('weak dup (6-field) → pending-review: knows who, but sameAsCandidateId null (no auto-merge)', async () => {
    const repo = {
      findComparisonCandidates: async (): Promise<CandidateRecord[]> => [
        { candidate_id: 'old', name: '张三', phone: '139', email: 'o@x.com', gender: '男', school: '清华', major: 'CS', degree: '本科', graduationYear: '2020' },
      ],
    };
    const r = await resolveIdentityMatch(
      { ...rec, gender: '男', school: '清华大学', major: 'CS', degree: '本科', graduationYear: '2020' },
      repo, rules, judgeYes,
    );
    expect(r.dedupAction).toBe('pending-review');
    expect(r.matchedCandidateId).toBe('old');
    expect(r.sameAsCandidateId).toBeNull();
  });

  it('no dup → new-candidate, sameAsCandidateId null', async () => {
    const repo = { findComparisonCandidates: async (): Promise<CandidateRecord[]> => [] };
    const r = await resolveIdentityMatch(rec, repo, rules, judgeYes);
    expect(r.dedupAction).toBe('new-candidate');
    expect(r.matchedCandidateId).toBeNull();
    expect(r.sameAsCandidateId).toBeNull();
  });
});
