import { describe, it, expect } from 'vitest';
import { identityToCheck, ownershipToCheck } from './to-ontology-check';
import { applyIdentityRules } from './identity-engine';
import { decideOwnership } from './ownership-engine';
import { loadCandidateMatchRules, identityRulesByPriority } from './rules-data';
import type { CandidateRecord } from './types';

const ruleset = loadCandidateMatchRules();
const RULES = identityRulesByPriority(ruleset);
const base: CandidateRecord = {
  candidate_id: 'A', name: '张三', phone: '13800138000', email: 'z@s.com',
  gender: '男', school: '清华大学', major: 'CS', degree: '本科', graduationYear: '2020',
};

describe('identityToCheck', () => {
  it('strong-rule duplicate (rule 1) → VALIDATED, selectionOk, no redline; matched eval PASS', async () => {
    const b = { ...base, candidate_id: 'B', name: 'x', email: 'y@z.com' };
    const res = await applyIdentityRules(base, b, RULES);
    const check = identityToCheck(res, RULES.length);
    expect(check.decision).toBe('VALIDATED');
    expect(check.redlineFlag).toBe(false);
    expect(check.selectionOk).toBe(true);
    expect(check.rulesTotal).toBe(3);
    const e1 = check.evals.find((e) => e.ruleId === 'IDENTITY-1')!;
    expect(e1.result).toBe('PASS');
  });

  it('weak-rule duplicate (rule 3) → VIOLATED with the rule-3 eval flagged FAIL', async () => {
    const b = { ...base, candidate_id: 'B', phone: '139', email: 'other@x.com' };
    const res = await applyIdentityRules(base, b, RULES);
    const check = identityToCheck(res, RULES.length);
    expect(check.decision).toBe('VIOLATED');
    const e3 = check.evals.find((e) => e.ruleId === 'IDENTITY-3')!;
    expect(e3.result).toBe('FAIL');
    expect(e3.hardSoft).toBe('soft');
  });

  it('no duplicate found → VALIDATED, all evaluated rules NA', async () => {
    const b: CandidateRecord = {
      candidate_id: 'B', name: '李四', phone: '139', email: 'o@x.com',
      gender: '女', school: '北大', major: '物理', degree: '硕士', graduationYear: '2019',
    };
    const res = await applyIdentityRules(base, b, RULES);
    const check = identityToCheck(res, RULES.length);
    expect(check.decision).toBe('VALIDATED');
    expect(check.evals.every((e) => e.result === 'NA')).toBe(true);
  });

  it('weaves matched candidate + dedupAction into the matched eval checkPoint (UI display)', async () => {
    const b = { ...base, candidate_id: 'cand_old', name: 'x', email: 'y@z.com' }; // phone match → IDENTITY-1
    const res = await applyIdentityRules(base, b, RULES);
    const check = identityToCheck(res, RULES.length, {
      matchedCandidateId: 'cand_old',
      matchedCandidateName: '张三',
      dedupAction: 'phone-match',
    });
    const e1 = check.evals.find((e) => e.ruleId === 'IDENTITY-1')!;
    expect(e1.checkPoint).toContain('cand_old');
    expect(e1.checkPoint).toContain('张三');
    expect(e1.checkPoint).toContain('phone-match');
    // un-matched rules carry no link suffix
    const na = check.evals.find((e) => e.result === 'NA');
    if (na) expect(na.checkPoint).not.toContain('关联');
  });

  it('ontologyRule (从 Neo4j 抓取的 9-15)→ 审计显示原规则 9-15,命中的三级折进 checkPoint', async () => {
    const b = { ...base, candidate_id: 'cand_old', name: 'x', email: 'y@z.com' }; // 手机号一致 → IDENTITY-1
    const res = await applyIdentityRules(base, b, RULES);
    const check = identityToCheck(
      res,
      RULES.length,
      { matchedCandidateId: 'cand_old', matchedCandidateName: '张三', dedupAction: 'phone-match' },
      { id: '9-15', name: '同一候选人判定规则' },
    );
    // 单条 eval = 本体原规则 9-15(三级是它的子判定,折进 checkPoint)。
    expect(check.evals).toHaveLength(1);
    expect(check.evals[0].ruleId).toBe('9-15');
    expect(check.evals[0].ruleName).toBe('同一候选人判定规则');
    expect(check.rulesTotal).toBe(1);
    expect(check.evals[0].result).toBe('PASS');
    expect(check.evals[0].checkPoint).toContain('9-15');
    expect(check.evals[0].checkPoint).toContain('手机号'); // 命中的那一级
    expect(check.evals[0].checkPoint).toContain('张三'); // 关联候选人
  });

  it('ontologyRule + 无重复 → 9-15 单条 eval,result=NA,checkPoint 标三级均未命中', async () => {
    const b: CandidateRecord = {
      candidate_id: 'B', name: '李四', phone: '139', email: 'o@x.com',
      gender: '女', school: '北大', major: '物理', degree: '硕士', graduationYear: '2019',
    };
    const res = await applyIdentityRules(base, b, RULES);
    const check = identityToCheck(res, RULES.length, {}, { id: '9-15', name: '同一候选人判定规则' });
    expect(check.evals).toHaveLength(1);
    expect(check.evals[0].ruleId).toBe('9-15');
    expect(check.evals[0].result).toBe('NA');
  });

  it('ontologyRule + pending-review → soft FAIL，展示疑似候选人但不标成关联', async () => {
    const b = { ...base, candidate_id: 'cand-suspect', phone: '13900139000' };
    const res = await applyIdentityRules(base, b, RULES);
    const check = identityToCheck(
      res,
      RULES.length,
      {
        matchedCandidateId: 'cand-suspect',
        matchedCandidateName: '张三',
        dedupAction: 'pending-review',
      },
      { id: '9-15', name: '同一候选人判定规则' },
    );
    expect(res.samePerson).toBe(false);
    expect(res.needsHumanReview).toBe(true);
    expect(check.decision).toBe('VIOLATED');
    expect(check.evals[0].result).toBe('FAIL');
    expect(check.evals[0].hardSoft).toBe('soft');
    expect(check.evals[0].checkPoint).toContain('待复核疑似候选人');
    expect(check.evals[0].checkPoint).not.toContain('关联到候选人');
  });

  it('ontologyRule + 安全的 llmRationale → checkPoint 用审计文案,机械文案进 evidence', async () => {
    const b = { ...base, candidate_id: 'cand_old', name: 'x', email: 'y@z.com' };
    const res = await applyIdentityRules(base, b, RULES);
    const llm = '规范中国大陆手机号一致,依据同一候选人判定规则记录为同一人审计结论';
    const check = identityToCheck(
      res, RULES.length, { matchedCandidateId: 'cand_old', matchedCandidateName: '张三', dedupAction: 'phone-match' },
      { id: '9-15', name: '同一候选人判定规则' }, llm,
    );
    expect(check.evals[0].checkPoint).toBe(llm);
    expect(check.evals[0].checkPoint).not.toMatch(/自动关联|自动合并|复用旧档|不重复建档/);
    // 机械文案不丢失:进 evidence,留可审计的结构化命中依据
    expect(check.evals[0].evidence).toContain('phone');
  });
});

describe('ownershipToCheck', () => {
  it('proceed → VALIDATED, no redline, deciding eval PASS', () => {
    const d = decideOwnership(
      { lockState: 1, blacklisted: false, lockByEmail: null, claimantEmail: 'me@c.com', client: null, tencentRelationship: false },
      ruleset.ownershipRules,
    );
    const check = ownershipToCheck(d, ruleset.ownershipRules);
    expect(check.decision).toBe('VALIDATED');
    expect(check.redlineFlag).toBe(false);
    expect(check.evals[0].result).toBe('PASS');
    expect(check.evals[0].ruleId).toBe('OWN-LOCK-1');
  });

  it('conflict → VIOLATED + redline, deciding eval FAIL', () => {
    const d = decideOwnership(
      { lockState: 2, blacklisted: false, lockByEmail: 'other@c.com', claimantEmail: 'me@c.com', client: null, tencentRelationship: false },
      ruleset.ownershipRules,
    );
    const check = ownershipToCheck(d, ruleset.ownershipRules);
    expect(check.decision).toBe('VIOLATED');
    expect(check.redlineFlag).toBe(true);
    expect(check.evals[0].result).toBe('FAIL');
  });
});
