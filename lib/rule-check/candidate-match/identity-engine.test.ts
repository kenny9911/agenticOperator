import { describe, it, expect, vi } from 'vitest';
import { applyIdentityRules } from './identity-engine';
import type { CandidateRecord } from './types';
import { loadCandidateMatchRules, identityRulesByPriority } from './rules-data';
import type { AiFieldJudge } from './field-equivalence';

const RULES = identityRulesByPriority(loadCandidateMatchRules());

const base: CandidateRecord = {
  candidate_id: 'A',
  name: '张三',
  phone: '13800138000',
  email: 'z@s.com',
  gender: '男',
  school: '清华大学',
  major: '计算机科学与技术',
  degree: '本科',
  graduationYear: '2020',
};

const judgeYes: AiFieldJudge = async () => ({ equivalent: true, confidence: 0.95, reason: '同义' });

describe('applyIdentityRules — priority short-circuit', () => {
  it('rule 1 (phone) matches → same person, no human review, stops at rule 1', async () => {
    const b: CandidateRecord = { ...base, candidate_id: 'B', name: '完全不同', email: 'x@y.com' };
    const r = await applyIdentityRules(base, b, RULES);
    expect(r.samePerson).toBe(true);
    expect(r.matchedRule?.ruleId).toBe('IDENTITY-1');
    expect(r.needsHumanReview).toBe(false);
    expect(r.ruleOutcomes.map((o) => o.ruleId)).toEqual(['IDENTITY-1']);
  });

  it('phone differs but name+email match → rule 2, rule 1 recorded as not matched', async () => {
    const b: CandidateRecord = { ...base, candidate_id: 'B', phone: '13900139000' };
    const r = await applyIdentityRules(base, b, RULES);
    expect(r.samePerson).toBe(true);
    expect(r.matchedRule?.ruleId).toBe('IDENTITY-2');
    expect(r.ruleOutcomes.map((o) => o.ruleId)).toEqual(['IDENTITY-1', 'IDENTITY-2']);
    expect(r.ruleOutcomes[0].matched).toBe(false);
  });

  it('only rule 3 (6 fields) matches → same person but flagged for human review', async () => {
    const b: CandidateRecord = { ...base, candidate_id: 'B', phone: '13900139000', email: 'other@x.com' };
    const r = await applyIdentityRules(base, b, RULES);
    expect(r.samePerson).toBe(true);
    expect(r.matchedRule?.ruleId).toBe('IDENTITY-3');
    expect(r.needsHumanReview).toBe(true);
  });

  it('nothing matches → not same person, all 3 rules evaluated', async () => {
    const b: CandidateRecord = {
      candidate_id: 'B',
      name: '李四',
      phone: '13900139000',
      email: 'other@x.com',
      gender: '女',
      school: '北大',
      major: '物理',
      degree: '硕士',
      graduationYear: '2019',
    };
    const r = await applyIdentityRules(base, b, RULES);
    expect(r.samePerson).toBe(false);
    expect(r.matchedRule).toBeNull();
    expect(r.needsHumanReview).toBe(false);
    expect(r.ruleOutcomes.map((o) => o.ruleId)).toEqual(['IDENTITY-1', 'IDENTITY-2', 'IDENTITY-3']);
  });
});

describe('applyIdentityRules — AI only for fuzzy fields', () => {
  it('uses the AI judge for a fuzzy name in rule 2 but never for the exact email field', async () => {
    const judge = vi.fn(judgeYes);
    // phone differs; name surface-differs (needs AI); email exact-equal.
    const b: CandidateRecord = { ...base, candidate_id: 'B', phone: '13900139000', name: 'Zhang San' };
    const r = await applyIdentityRules(base, b, RULES, judge);
    expect(r.samePerson).toBe(true);
    expect(r.matchedRule?.ruleId).toBe('IDENTITY-2');
    // judge consulted for name (fuzzy) — and only for fuzzy fields.
    const judgedFields = judge.mock.calls.map((c) => c[0]);
    expect(judgedFields).toContain('name');
    expect(judgedFields).not.toContain('email');
  });

  it('rule 3 fuzzy fields (school/major/degree) resolved by AI → match + review flag', async () => {
    const judge = vi.fn(judgeYes);
    const b: CandidateRecord = {
      ...base,
      candidate_id: 'B',
      phone: '13900139000',
      email: 'other@x.com',
      school: '清华', // vs 清华大学
      major: '计算机', // vs 计算机科学与技术
      degree: '学士', // vs 本科
    };
    const r = await applyIdentityRules(base, b, RULES, judge);
    expect(r.samePerson).toBe(true);
    expect(r.matchedRule?.ruleId).toBe('IDENTITY-3');
    expect(r.needsHumanReview).toBe(true);
  });
});
