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
  submissionCriteria: '简历完成解析', standardizedLogicRule: '1.手机号一致…', businessBackgroundReason: '唯一性',
  specificScenarioStage: '简历处理', relatedEntities: ['候选人(Candidate)'], executor: 'Agent', enforcementLevel: 'mandatory',
} as unknown as Rule;

beforeEach(() => {
  fetchActionRulesLive.mockReset();
  runLlm.mockReset();
  fetchActionRulesLive.mockResolvedValue(new Map([['9-15', RULE_915]]));
  runLlm.mockResolvedValue({ parsed_json: { reason: '手机号一致,自动关联老档' }, raw_text: '{"reason":"…"}', model_used: 'm', duration_ms: 1 });
});

describe('auditIdentityResolution — 一次判定 → 同一份结论落审计', () => {
  it('强命中:审计 selectionNote 与 resolution 完全一致(sameAs/matched/dedup),evals 显示 9-15', async () => {
    const resolution = await resolveIdentityMatch(rec, repo, RULES, judgeYes);
    const persist = vi.fn(async () => ({ id: 'audit_1' }));
    const out = await auditIdentityResolution({
      resolution, candidateName: rec.name ?? null, rulesTotal: RULES.length,
      snapshotSource: 'snapshot', caseId: 'case_1', traceId: null, persist,
    });
    expect(out?.id).toBe('audit_1');
    const arg = persist.mock.calls[0][0] as any;
    expect(arg.agentSlug).toBe('rule-check-candidate-identity');
    expect(arg.ruleSource).toBe('ontology-api');
    expect(arg.selectionNote.sameAsCandidateId).toBe('old-001');
    expect(arg.selectionNote.matchedCandidateId).toBe('old-001');
    expect(arg.selectionNote.dedupAction).toBe('auto-merged');
    expect(arg.check.evals[0].ruleId).toBe('9-15');
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
    const arg = persist.mock.calls[0][0] as any;
    expect(arg.ruleSource).toBe('snapshot');
    expect(arg.check.evals.some((e: any) => String(e.ruleId).startsWith('IDENTITY-'))).toBe(true);
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
