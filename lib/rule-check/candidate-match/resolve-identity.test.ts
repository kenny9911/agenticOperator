import { describe, expect, it } from 'vitest';
import { resolveIdentityMatch } from './resolve-identity';
import { identityRulesByPriority, loadCandidateMatchRules } from './rules-data';
import type { CandidateRecord } from './types';
import type { AiFieldJudge } from './field-equivalence';

const rules = identityRulesByPriority(loadCandidateMatchRules());
const judgeYes: AiFieldJudge = async () => ({ equivalent: true, confidence: 0.95, reason: 'ok' });
const rec: CandidateRecord = {
  candidate_id: 'new',
  name: '张三',
  phone: '13800138000',
  email: 'z@s.com',
};

describe('resolveIdentityMatch — audit-only phone authority', () => {
  it('mainland phone match is the only authoritative identity result', async () => {
    const repo = {
      findComparisonCandidates: async (): Promise<CandidateRecord[]> => [
        { candidate_id: 'old', name: '不同', phone: '+86 13800138000', email: 'x@y.com' },
      ],
    };
    const r = await resolveIdentityMatch(rec, repo, rules, judgeYes);
    expect(r.dedupAction).toBe('phone-match');
    expect(r.result.samePerson).toBe(true);
    expect(r.matchedCandidateId).toBe('old');
    expect(r).not.toHaveProperty('sameAsCandidateId');
  });

  it('name+email match is only a review suspect, never same-person authority', async () => {
    const repo = {
      findComparisonCandidates: async (): Promise<CandidateRecord[]> => [
        { candidate_id: 'old', name: '张三', phone: '13900139000', email: 'z@s.com' },
      ],
    };
    const r = await resolveIdentityMatch(rec, repo, rules, judgeYes);
    expect(r.dedupAction).toBe('pending-review');
    expect(r.result.samePerson).toBe(false);
    expect(r.result.needsHumanReview).toBe(true);
    expect(r.matchedCandidateId).toBe('old');
  });

  it('six-field match is only a review suspect', async () => {
    const repo = {
      findComparisonCandidates: async (): Promise<CandidateRecord[]> => [
        {
          candidate_id: 'old', name: '张三', phone: '13900139000', email: 'o@x.com',
          gender: '男', school: '清华', major: 'CS', degree: '本科', graduationYear: '2020',
        },
      ],
    };
    const r = await resolveIdentityMatch(
      { ...rec, email: 'new@x.com', gender: '男', school: '清华大学', major: 'CS', degree: '本科', graduationYear: '2020' },
      repo,
      rules,
      judgeYes,
    );
    expect(r.dedupAction).toBe('pending-review');
    expect(r.result.samePerson).toBe(false);
    expect(r.matchedCandidateId).toBe('old');
  });

  it('continues past an earlier profile suspect and selects a later phone match', async () => {
    const repo = {
      findComparisonCandidates: async (): Promise<CandidateRecord[]> => [
        { candidate_id: 'suspect', name: '张三', phone: '13900139000', email: 'z@s.com' },
        { candidate_id: 'phone-owner', name: '李四', phone: '13800138000', email: 'other@x.com' },
      ],
    };
    const r = await resolveIdentityMatch(rec, repo, rules, judgeYes);
    expect(r.dedupAction).toBe('phone-match');
    expect(r.matchedCandidateId).toBe('phone-owner');
    expect(r.result.matchedRule?.ruleId).toBe('IDENTITY-1');
  });

  it('demotes a custom non-phone rule even when its data incorrectly disables review', async () => {
    const customRules = [
      {
        id: 'CUSTOM-NAME',
        businessLogicRuleName: '自定义姓名规则',
        priority: 1,
        applicableClient: '通用',
        matchFields: ['name' as const],
        fuzzyFields: [],
        needsHumanReview: false,
        standardizedLogicRule: '姓名一致',
        enforcementLevel: 'mandatory',
      },
    ];
    const repo = {
      findComparisonCandidates: async (): Promise<CandidateRecord[]> => [
        { candidate_id: 'custom-suspect', name: '张三', phone: '13900139000' },
      ],
    };

    const r = await resolveIdentityMatch(rec, repo, customRules, judgeYes);

    expect(r.dedupAction).toBe('pending-review');
    expect(r.result.samePerson).toBe(false);
    expect(r.result.needsHumanReview).toBe(true);
    expect(r.result.matchedRule?.needsHumanReview).toBe(true);
    expect(r.matchedCandidateId).toBe('custom-suspect');
  });

  it('does not trust an IDENTITY-1 label when the matched rule has no canonical phone evidence', async () => {
    const mislabeledRules = [
      {
        id: 'IDENTITY-1',
        businessLogicRuleName: '错误标记的姓名规则',
        priority: 1,
        applicableClient: '通用',
        matchFields: ['name' as const],
        fuzzyFields: [],
        needsHumanReview: false,
        standardizedLogicRule: '姓名一致',
        enforcementLevel: 'mandatory',
      },
    ];
    const repo = {
      findComparisonCandidates: async (): Promise<CandidateRecord[]> => [
        { candidate_id: 'mislabeled-suspect', name: '张三', phone: '13900139000' },
      ],
    };

    const r = await resolveIdentityMatch(rec, repo, mislabeledRules, judgeYes);

    expect(r.dedupAction).toBe('pending-review');
    expect(r.result.samePerson).toBe(false);
    expect(r.result.needsHumanReview).toBe(true);
  });

  it('empty pool produces a no-match audit', async () => {
    const repo = { findComparisonCandidates: async (): Promise<CandidateRecord[]> => [] };
    const r = await resolveIdentityMatch(rec, repo, rules, judgeYes);
    expect(r.dedupAction).toBe('no-match');
    expect(r.result.samePerson).toBe(false);
    expect(r.matchedCandidateId).toBeNull();
  });
});
