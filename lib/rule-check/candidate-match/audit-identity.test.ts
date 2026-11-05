import { describe, it, expect, vi, beforeEach } from 'vitest';

const { fetchActionRulesLive } = vi.hoisted(() => ({ fetchActionRulesLive: vi.fn() }));
vi.mock('../api-rule-fetcher', () => ({ fetchActionRulesLive }));
const { runLlm } = vi.hoisted(() => ({ runLlm: vi.fn() }));
vi.mock('../llm', () => ({ runLlm }));

import { auditIdentityResolution } from './audit-identity';
import { resolveIdentityMatch } from './resolve-identity';
import { loadCandidateMatchRules, identityRulesByPriority } from './rules-data';
import type { CandidateRecord } from './types';
import type { AiFieldJudge } from './field-equivalence';
import type { Rule } from '../types';
import type { PersistCandidateCheckArgs } from './persist';

function firstPersistArg(calls: unknown): PersistCandidateCheckArgs {
  const arg = (calls as unknown[][])[0]?.[0];
  if (!arg || typeof arg !== 'object') throw new Error('expected one persist call');
  return arg as PersistCandidateCheckArgs;
}

const RULES = identityRulesByPriority(loadCandidateMatchRules());
const judgeYes: AiFieldJudge = async () => ({ equivalent: true, confidence: 0.95, reason: 'ok' });
const rec: CandidateRecord = { candidate_id: 'up_1', name: '陈思', phone: '13800138000', email: 'c@s.com' };
const repo = {
  findComparisonCandidates: async (): Promise<CandidateRecord[]> => [
    { candidate_id: 'old-001', name: '陈思', phone: '13800138000', email: 'c@s.com' },
  ],
};
const RULE_915 = {
  id: '9-15', businessLogicRuleName: '同一候选人判定规则',
  submissionCriteria: '简历完成解析后自动判断是否为同一人',
  standardizedLogicRule: '姓名 + 邮箱一致或六字段一致均判定为同一人，关联到已有候选人档案，不重复建档。',
  businessBackgroundReason: '复用旧档',
  specificScenarioStage: '简历处理', relatedEntities: ['候选人(Candidate)'], executor: 'Agent', enforcementLevel: 'mandatory',
} as unknown as Rule;

beforeEach(() => {
  fetchActionRulesLive.mockReset();
  runLlm.mockReset();
  fetchActionRulesLive.mockResolvedValue(new Map([['9-15', RULE_915]]));
  runLlm.mockResolvedValue({ parsed_json: { reason: '手机号一致,自动关联老档' }, raw_text: '{"reason":"…"}', model_used: 'm', duration_ms: 1 });
});

describe('auditIdentityResolution — 一次判定 → 同一份结论落审计', () => {
  it('手机号命中:审计记录 matched evidence,但不产生存储指令', async () => {
    const resolution = await resolveIdentityMatch(rec, repo, RULES, judgeYes);
    const persist = vi.fn(async () => ({ id: 'audit_1' }));
    const out = await auditIdentityResolution({
      resolution, candidateName: rec.name ?? null, rulesTotal: RULES.length,
      snapshotSource: 'snapshot', caseId: 'case_1', traceId: null, persist,
    });
    expect(out?.id).toBe('audit_1');
    const arg = firstPersistArg(persist.mock.calls);
    const note = arg.selectionNote as Record<string, unknown>;
    expect(arg.agentSlug).toBe('rule-check-candidate-identity');
    expect(arg.ruleSource).toBe('ontology-api');
    expect(note).not.toHaveProperty('sameAsCandidateId');
    expect(note.matchedCandidateId).toBe('old-001');
    expect(note.dedupAction).toBe('phone-match');
    expect(note.llmResponse).toBeNull();
    expect(note.llmPrompt).toContain('判定逻辑(当前运行政策)');
    expect(note.llmPrompt).toContain('CANDIDATE_IDENTITY_REQUESTED');
    expect(note.llmPrompt).not.toMatch(/关联到已有候选人档案|不重复建档|复用旧档/);
    expect(arg.check.evals[0].ruleId).toBe('9-15');
    expect(arg.check.evals[0].checkPoint).not.toMatch(/自动关联|自动合并|复用旧档|不重复建档/);
  });

  it('9-15 抓取失败 → 回退 snapshot 来源,evals 用 IDENTITY-*,照常落审计', async () => {
    fetchActionRulesLive.mockRejectedValue(new Error('allmeta down'));
    const resolution = await resolveIdentityMatch(rec, repo, RULES, judgeYes);
    const persist = vi.fn(async () => ({ id: 'audit_2' }));
    const out = await auditIdentityResolution({
      resolution, candidateName: rec.name ?? null, rulesTotal: RULES.length,
      snapshotSource: 'snapshot', caseId: 'case_2', traceId: null, persist,
    });
    expect(out?.id).toBe('audit_2');
    const arg = firstPersistArg(persist.mock.calls);
    expect(arg.ruleSource).toBe('snapshot');
    expect(arg.check.evals.some((e) => String(e.ruleId).startsWith('IDENTITY-'))).toBe(true);
  });

  it('persist 抛错 → 标记为 authoritative audit failure 并触发重试', async () => {
    const resolution = await resolveIdentityMatch(rec, repo, RULES, judgeYes);
    const persist = vi.fn(async () => { throw new Error('db down'); });
    await expect(auditIdentityResolution({
      resolution, candidateName: rec.name ?? null, rulesTotal: RULES.length,
      snapshotSource: 'snapshot', caseId: 'case_3', traceId: null, persist,
    })).rejects.toThrow(/RULE_AUDIT_PERSISTENCE_FAILED.*db down/);
  });
});
