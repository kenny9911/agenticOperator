// 大模型生成的「纳入依据」—— 把确定性去重判定(命中第几级、关联到谁、去重动作)
// 交给 LLM 用一句业务中文复述,作为审计里 9-15 规则的「纳入依据」。
//
// 纯 soft-fail:LLM 不可达 / 解析失败 → 返回 null,调用方回退机械文案。判定本身是
// 确定性引擎给的(不让 LLM 改判),LLM 只负责「把依据讲清楚」。

import { runLlm } from '../llm';
import type { IdentityMatchResult } from './identity-engine';

/** 从 Neo4j 抓到的原规则全文(供大模型扣着原文条款生成判定依据,而非瘦摘要)。 */
export interface OntologyRuleDefinition {
  submissionCriteria?: string;
  standardizedLogicRule?: string;
  businessBackgroundReason?: string;
  specificScenarioStage?: string;
  relatedEntities?: string[];
  executor?: string;
  enforcement?: string;
}

export interface RationaleInput {
  result: IdentityMatchResult;
  candidateName: string | null;
  matchedCandidateId: string | null;
  matchedCandidateName: string | null;
  dedupAction: string;
  ontologyRuleId: string; // '9-15'
  ontologyRuleName: string; // '同一候选人判定规则'
  /** 原规则全文 —— 缺省时回退到简要摘要(老行为)。 */
  ruleDefinition?: OntologyRuleDefinition;
}

const TIER_NAME: Record<string, string> = {
  '1': '第1级·手机号一致',
  '2': '第2级·姓名+邮箱一致',
  '3': '第3级·姓名+性别+学校+专业+学历+毕业时间六字段一致',
};

export function buildRationalePrompt(input: RationaleInput): { system: string; user: string } {
  const matched = input.result.ruleOutcomes.find((o) => o.matched) ?? null;
  const tierIdx = matched ? matched.ruleId.replace(/\D/g, '') : '';
  const tier = matched ? TIER_NAME[tierIdx] ?? `第${tierIdx}级(${matched.ruleName})` : '三级均未命中';
  const evidence = matched
    ? matched.fieldResults.map((f) => `${f.field}:${f.method}${f.equivalent ? '一致' : '不一致'}`).join('、')
    : input.result.ruleOutcomes
        .flatMap((o) => o.fieldResults.map((f) => `${f.field}:${f.equivalent ? '一致' : '不一致'}`))
        .join('、');

  // 原规则全文块 —— 有 ruleDefinition 就铺全文,缺省回退到老的一行摘要。
  const def = input.ruleDefinition;
  const ruleBlock = def
    ? [
        `规则编号:${input.ontologyRuleId}`,
        `规则名称:${input.ontologyRuleName}`,
        def.specificScenarioStage ? `场景阶段:${def.specificScenarioStage}` : '',
        def.executor ? `执行者:${def.executor}${def.enforcement ? `(${def.enforcement})` : ''}` : '',
        def.submissionCriteria ? `触发条件:${def.submissionCriteria}` : '',
        def.standardizedLogicRule ? `判定逻辑(原规则全文):\n${def.standardizedLogicRule}` : '',
        def.businessBackgroundReason ? `业务背景:${def.businessBackgroundReason}` : '',
        def.relatedEntities?.length ? `关联实体:${def.relatedEntities.join('、')}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : `规则:${input.ontologyRuleId} ${input.ontologyRuleName}(同一候选人判定,三级优先级:手机号 > 姓名+邮箱 > 六字段,命中即停)。`;

  const system =
    '你是招聘系统的候选人查重审计助手。只输出 JSON:{"reason":"<判定依据>"}。' +
    '要求:全中文、不含任何英文词、面向业务、专业克制、不超过 100 字、不要前缀也不要换行。' +
    '你只复述确定性引擎的判定结果、并扣住【原规则定义】里命中那一级的具体判定标准来解释,不得改变判定结论、不得编造原规则没有的条款。' +
    '注意:规则编号(如 9-15)是规则的唯一标识,不是条款序号区间,不要说成「第 9 到 15 条」;要说的「第几级」指的是判定逻辑里的三级优先级(第 1/2/3 级)。';

  const user = [
    '【原规则定义】',
    ruleBlock,
    '',
    '【本次判定】',
    `本候选人:${input.candidateName ?? '(未知)'}`,
    `判定结论:${input.result.samePerson ? '与系统中已有候选人为同一人' : '非同一人(新候选人)'}`,
    `命中级别:${tier}`,
    `字段比对:${evidence || '无'}`,
    `关联到的已有候选人:${input.matchedCandidateName ?? '无'}(${input.matchedCandidateId ?? '无'})`,
    `去重动作:${input.dedupAction}`,
    '',
    '请基于【原规则定义】的判定逻辑,说明「为什么该候选人按本规则得出此判定、并采取该去重动作」,作为审计的判定依据。要点名命中的是第几级、依据原规则该级的判定标准。',
  ].join('\n');

  return { system, user };
}

export interface RationaleResult {
  /** 业务中文一句话纳入依据;LLM 不可达 / 解析失败时为 null(调用方回退机械文案)。 */
  reason: string | null;
  /** 发给大模型的用户提示词(供审计「用户提示词」tab 展示,即便 reason 失败也保留)。 */
  prompt: string;
  /** 大模型原始响应文本(供审计「LLM 响应」tab 展示)。 */
  raw: string;
}

export async function generateIdentityRationale(
  input: RationaleInput,
  runLlmFn: typeof runLlm = runLlm,
): Promise<RationaleResult> {
  const { system, user } = buildRationalePrompt(input);
  try {
    const res = await runLlmFn({ system, user, temperature: 0.2, max_tokens: 400 });
    const parsed = res.parsed_json as { reason?: unknown } | null;
    const reason = parsed && typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    return { reason: reason || null, prompt: user, raw: res.raw_text ?? '' };
  } catch {
    return { reason: null, prompt: user, raw: '' };
  }
}
