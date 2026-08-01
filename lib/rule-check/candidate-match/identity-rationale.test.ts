import { describe, it, expect } from 'vitest';
import { buildRationalePrompt, generateIdentityRationale, type RationaleInput } from './identity-rationale';
import { applyIdentityRules } from './identity-engine';
import { loadCandidateMatchRules, identityRulesByPriority } from './rules-data';
import type { CandidateRecord } from './types';
import type { LlmRunResult } from '../llm';

const RULES = identityRulesByPriority(loadCandidateMatchRules());
const a: CandidateRecord = { candidate_id: 'A', name: '陈思', phone: '13800138000', email: 'c@s.com' };
const b: CandidateRecord = { candidate_id: 'B', name: 'x', phone: '13800138000', email: 'y@z.com' }; // 手机号命中

function inputFrom(res: Awaited<ReturnType<typeof applyIdentityRules>>): RationaleInput {
  return {
    result: res,
    candidateName: '陈思',
    matchedCandidateId: 'B',
    matchedCandidateName: '陈思',
    dedupAction: 'phone-match',
    ontologyRuleId: '9-15',
    ontologyRuleName: '同一候选人判定规则',
  };
}

const fakeLlm = (reason: unknown, rawText = '') =>
  (async () => ({ parsed_json: { reason }, raw_text: rawText, model_used: 'm', duration_ms: 1 }) as LlmRunResult);

describe('buildRationalePrompt', () => {
  it('user prompt 含 9-15 / 候选人 / 命中级别 / 去重动作;system 要求中文 JSON', async () => {
    const res = await applyIdentityRules(a, b, RULES);
    const { system, user } = buildRationalePrompt(inputFrom(res));
    expect(system).toContain('JSON');
    expect(system).toContain('中文');
    expect(user).toContain('9-15');
    expect(user).toContain('陈思');
    expect(user).toContain('手机号');
    expect(user).toContain('phone-match');
    expect(system).toContain('无论审计结论类型是什么');
    expect(system).toContain('不得声称已或将自动关联、自动合并、复用旧档或不重复建档');
    expect(user).toContain('不执行档案关联或合并');
  });

  it('pending-review 明确写待人工复核，不把疑似候选人说成新人或自动合并', async () => {
    const suspect = { ...a, candidate_id: 'B', phone: '13900139000' };
    const res = await applyIdentityRules(a, suspect, RULES);
    const { system, user } = buildRationalePrompt({
      ...inputFrom(res),
      dedupAction: 'pending-review',
    });
    expect(res.samePerson).toBe(false);
    expect(res.needsHumanReview).toBe(true);
    expect(user).toContain('手机号未命中，仅相似信号，待人工复核，不产生候选人档案变更');
    expect(user).not.toContain('非同一人(新候选人)');
    expect(system).toContain('不得称为同一人、新候选人或自动合并');
  });

  it('提供 ruleDefinition 时把原规则全文铺进 prompt(不再只是瘦摘要)', async () => {
    const res = await applyIdentityRules(a, b, RULES);
    const input: RationaleInput = {
      ...inputFrom(res),
      ruleDefinition: {
        submissionCriteria: '简历完成解析,需判断其是否与系统中已有候选人为同一人。',
        standardizedLogicRule: '规范中国大陆手机号一致可形成同一人审计结论；其余相似信号只能人工复核。',
        businessBackgroundReason: '为人工身份核验提供证据。',
        specificScenarioStage: '独立身份审计',
        relatedEntities: ['候选人(Candidate)', '候选人简历(Resume)'],
        executor: 'Agent',
        enforcement: 'mandatory',
      },
    };
    const { user } = buildRationalePrompt(input);
    expect(user).toContain('原规则全文'); // 标准化判定逻辑全文铺进去
    expect(user).toContain('为人工身份核验提供证据'); // 业务背景
    expect(user).toContain('简历完成解析'); // 触发条件
    expect(user).toContain('候选人简历(Resume)'); // 关联实体
  });

  it('live 9-15 含旧自动关联政策 → prompt fail-closed 到当前固定政策', async () => {
    const res = await applyIdentityRules(a, b, RULES);
    const { user } = buildRationalePrompt({
      ...inputFrom(res),
      ruleDefinition: {
        submissionCriteria: '简历完成解析后自动判断是否为同一人。',
        standardizedLogicRule: '姓名 + 邮箱一致或六字段一致均判定为同一人，关联到已有候选人档案，不重复建档。',
        businessBackgroundReason: '复用旧档。',
      },
    });
    expect(user).toContain('判定逻辑(当前运行政策)');
    expect(user).toContain('CANDIDATE_IDENTITY_REQUESTED');
    expect(user).toContain('姓名 + 邮箱一致：仅标记疑似重复并进入人工复核');
    expect(user).not.toContain('简历完成解析后自动判断是否为同一人');
    expect(user).not.toContain('关联到已有候选人档案');
    expect(user).not.toContain('不重复建档');
    expect(user).not.toContain('复用旧档');
  });
});

describe('generateIdentityRationale', () => {
  it('解析 LLM 的 {reason} 文本 + 保留 prompt/raw', async () => {
    const input = inputFrom(await applyIdentityRules(a, b, RULES));
    const safeReason = '规范中国大陆手机号一致，仅记录为同一人身份审计结论';
    const safeRaw = JSON.stringify({ reason: safeReason });
    const r = await generateIdentityRationale(input, fakeLlm(safeReason, safeRaw));
    expect(r.reason).toBe(safeReason);
    expect(r.raw).toBe(safeRaw);
    expect(r.prompt).toContain('9-15'); // 用户提示词供 tab 展示
  });

  it.each(['phone-match', 'pending-review', 'no-match'])('%s 输出含存储处置措辞 → 丢弃并回退机械审计文案', async (dedupAction) => {
    const input = {
      ...inputFrom(await applyIdentityRules(a, b, RULES)),
      dedupAction,
    };
    const unsafeReason = '手机号一致,判定为同一人,自动关联老档不重复建档';
    const r = await generateIdentityRationale(
      input,
      fakeLlm(unsafeReason, JSON.stringify({ reason: unsafeReason })),
    );
    expect(r.reason).toBeNull();
    expect(r.raw).toBe('');
    expect(r.prompt).not.toMatch(/自动关联|自动合并|复用旧档|不重复建档/);
    expect(`${r.reason ?? ''}${r.raw}`).not.toMatch(/自动关联|自动合并|复用旧档|不重复建档/);
  });
  it('LLM 抛错 → reason=null(soft-fail,绝不阻断审计),但 prompt 仍在', async () => {
    const input = inputFrom(await applyIdentityRules(a, b, RULES));
    const boom = (async () => {
      throw new Error('llm down');
    }) as typeof generateIdentityRationale extends (i: RationaleInput, f: infer F) => unknown ? F : never;
    const r = await generateIdentityRationale(input, boom);
    expect(r.reason).toBeNull();
    expect(r.prompt).toContain('9-15');
  });
  it('无 reason 字段 → reason=null(回退机械文案)', async () => {
    const input = inputFrom(await applyIdentityRules(a, b, RULES));
    const r = await generateIdentityRationale(
      input,
      fakeLlm(undefined, '{"reason":"自动关联老档"}'),
    );
    expect(r.reason).toBeNull();
    expect(r.raw).toBe('');
  });
});
