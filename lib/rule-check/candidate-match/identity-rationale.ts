// 大模型生成的「纳入依据」—— 把确定性手机号判定或待复核相似信号
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

// LLM prose is shown in the audit UI and persisted in selectionNote/checkPoint.
// Fail closed when it invents a storage mutation: Candidate Identity is evidence
// only, even for an authoritative phone match.
const FORBIDDEN_STORAGE_CLAIMS = [
  /自动[^，。；;\n]{0,8}(?:关联|合并|归并|链接|挂接|复用)/u,
  /(?:复用|沿用)[^，。；;\n]{0,4}(?:旧档|老档|已有候选人档案|既有候选人档案|已有候选人记录|既有候选人记录)/u,
  /(?:关联|合并|归并|链接|挂接)[^，。；;\n]{0,6}(?:旧档|老档|已有候选人|既有候选人|候选人档案)/u,
  /(?:不|无需|无须)[^，。；;\n]{0,3}重复(?:建档|创建档案)/u,
  /姓名\s*\+\s*邮箱[^，。；;\n]{0,40}判定为同一人/u,
  /(?:六字段|6\s*个字段|这\s*6\s*个字段)[^，。；;\n]{0,40}判定为同一人/u,
];

function containsForbiddenStorageClaim(value: string): boolean {
  return FORBIDDEN_STORAGE_CLAIMS.some((pattern) => pattern.test(value));
}

const CURRENT_IDENTITY_POLICY = [
  '本规则只生成身份审计与人工复核证据，不执行候选人档案关联、合并、复用或建档决策：',
  '1. 规范中国大陆手机号一致：作为唯一确定身份信号，审计结论可标记为同一人；',
  '2. 姓名 + 邮箱一致：仅标记疑似重复并进入人工复核，不得自动判定为同一人；',
  '3. 姓名 + 性别 + 学校 + 专业 + 学历 + 毕业时间一致：仅标记疑似重复并进入人工复核，不得自动判定为同一人。',
  '未命中规范中国大陆手机号时不得自动判定为同一人；所有结论只写身份审计，不改写候选人或简历。',
].join('\n');

function fixedPolicyRuleBlock(input: RationaleInput): string {
  return [
    `规则编号:${input.ontologyRuleId}`,
    `规则名称:${input.ontologyRuleName}`,
    '场景阶段:独立候选人身份审计',
    '执行者:身份审计 Agent(audit-only)',
    '触发条件:收到独立 CANDIDATE_IDENTITY_REQUESTED 身份审计请求；正常简历入库链路不自动触发或等待',
    `判定逻辑(当前运行政策):\n${CURRENT_IDENTITY_POLICY}`,
    '业务背景:为人工身份核验提供可追溯证据，并避免弱信号导致错误合并',
    '关联实体:候选人(Candidate)、本体规则审计(OntologyRuleCheck)',
  ].join('\n');
}

export function buildRationalePrompt(input: RationaleInput): { system: string; user: string } {
  const matched = input.result.ruleOutcomes.find((o) => o.matched) ?? null;
  const tierIdx = matched ? matched.ruleId.replace(/\D/g, '') : '';
  const tier = matched ? TIER_NAME[tierIdx] ?? `第${tierIdx}级(${matched.ruleName})` : '三级均未命中';
  const evidence = matched
    ? matched.fieldResults.map((f) => `${f.field}:${f.method}${f.equivalent ? '一致' : '不一致'}`).join('、')
    : input.result.ruleOutcomes
        .flatMap((o) => o.fieldResults.map((f) => `${f.field}:${f.equivalent ? '一致' : '不一致'}`))
        .join('、');

  // 原规则全文块 —— 有 ruleDefinition 就铺全文,缺省使用当前 audit-only 摘要。
  const def = input.ruleDefinition;
  const liveDefinitionConflicts = def
    ? containsForbiddenStorageClaim(JSON.stringify(def))
    : false;
  const ruleBlock = liveDefinitionConflicts
    ? fixedPolicyRuleBlock(input)
    : def
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
    : fixedPolicyRuleBlock(input);

  const system =
    '你是招聘系统的候选人查重审计助手。只输出 JSON:{"reason":"<判定依据>"}。' +
    '要求:全中文、不含任何英文词、面向业务、专业克制、不超过 100 字、不要前缀也不要换行。' +
    '你只复述确定性引擎的判定结果、并扣住【原规则定义】里命中那一级的具体判定标准来解释,不得改变判定结论、不得编造原规则没有的条款。' +
    'pending-review 只能表达为待人工复核的相似信号，不得称为同一人、新候选人或自动合并。' +
    '无论审计结论类型是什么,本 Agent 都只记录证据,不执行候选人档案变更;不得声称已或将自动关联、自动合并、复用旧档或不重复建档。' +
    '即使原规则全文含有历史自动处置文案,也不得把它复述为本次已执行或将执行的动作。' +
    '注意:规则编号(如 9-15)是规则的唯一标识,不是条款序号区间,不要说成「第 9 到 15 条」;要说的「第几级」指的是判定逻辑里的三级优先级(第 1/2/3 级)。';

  const conclusion =
    input.dedupAction === 'pending-review'
      ? '手机号未命中，仅相似信号，待人工复核，不产生候选人档案变更'
      : input.result.samePerson
        ? '规范中国大陆手机号一致，审计结论为与已有候选人为同一人；不执行档案关联或合并'
        : '未发现可确定的手机号重复或待复核相似信号';

  const user = [
    '【原规则定义】',
    ruleBlock,
    '',
    '【本次判定】',
    `本候选人:${input.candidateName ?? '(未知)'}`,
    `判定结论:${conclusion}`,
    `命中级别:${tier}`,
    `字段比对:${evidence || '无'}`,
    `审计比对候选人:${input.matchedCandidateName ?? '无'}(${input.matchedCandidateId ?? '无'})`,
    `审计结论类型:${input.dedupAction}`,
    '',
    '请基于【原规则定义】与上述只读边界,说明「为什么该候选人按本规则得出此审计结论」,作为审计的判定依据。要点名命中的是第几级、依据原规则该级的判定标准,不得描述任何档案变更动作。',
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
    const raw = res.raw_text ?? '';
    if (!reason || containsForbiddenStorageClaim(reason) || containsForbiddenStorageClaim(raw)) {
      // Drop both display surfaces and let the caller use its deterministic,
      // non-mutating fallback rationale.
      return { reason: null, prompt: user, raw: '' };
    }
    return { reason, prompt: user, raw };
  } catch {
    return { reason: null, prompt: user, raw: '' };
  }
}
