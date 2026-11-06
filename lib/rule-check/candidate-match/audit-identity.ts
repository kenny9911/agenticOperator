// auditIdentityResolution — 用「同一份查重结论」落规则检查审计。
//
// 架构(2026-06-11):查重判定只在简历解析内部执行一次(落库前,resolveIdentityMatch),
// 那一份 IdentityResolution 既驱动存储(same_as_candidate_id)、也由本函数写成审计 ——
// 审计与落库行为出自同一次执行,杜绝「合并后重跑判定 → self 被排除 → 审计报无重复」
// 的失真。独立的候选人查重智能体默认停用,保留为可选的独立复核器(共用本函数)。
//
// 规则抓取/说明生成可以降级，但 authoritative audit 持久化不能 soft-fail：
// DB 写失败必须抛出，让 Inngest 重试后再继续主流程。

import { fetchActionRulesLive } from '../api-rule-fetcher';
import { generateIdentityRationale, type OntologyRuleDefinition } from './identity-rationale';
import { identityToCheck, type IdentityOntologyRule } from './to-ontology-check';
import { persistCandidateRuleCheck, type PersistCandidateCheckArgs } from './persist';
import { asRuleAuditPersistenceError } from '@/lib/rule-check/ontology-audit-writer';
import type { IdentityResolution } from './resolve-identity';

export const IDENTITY_AGENT_SLUG = 'rule-check-candidate-identity';
export const IDENTITY_AGENT_NAME = '候选人查重';
export const IDENTITY_STAGE = '候选人入库';

export interface AuditIdentityArgs {
  resolution: IdentityResolution;
  candidateName: string | null;
  rulesTotal: number;
  /** bundled rules.json 的 metadata.source(9-15 抓取失败时的回退来源标注)。 */
  snapshotSource: string;
  caseId: string;
  runId?: string | null;
  traceId: string | null;
  persist?: (a: PersistCandidateCheckArgs) => Promise<{ id: string }>;
}

/** 从 Allmeta 抓 9-15 原规则(含全文,供大模型扣条款);不可达 → null(回退快照)。 */
async function fetchOntologyRule(): Promise<
  | { rule: IdentityOntologyRule; definition: OntologyRuleDefinition }
  | null
> {
  try {
    const byId = await fetchActionRulesLive('ruleCheckForCandidateIdentity');
    const r = byId.get('9-15');
    if (!r) return null;
    return {
      rule: { id: r.id, name: r.businessLogicRuleName || '同一候选人判定规则' },
      definition: {
        submissionCriteria: r.submissionCriteria,
        standardizedLogicRule: r.standardizedLogicRule,
        businessBackgroundReason: r.businessBackgroundReason,
        specificScenarioStage: r.specificScenarioStage,
        relatedEntities: r.relatedEntities,
        executor: r.executor,
        enforcement: r.enforcementLevel,
      },
    };
  } catch {
    return null;
  }
}

export async function auditIdentityResolution(
  args: AuditIdentityArgs,
): Promise<{ id: string }> {
  const persist = args.persist ?? persistCandidateRuleCheck;
  const { resolution } = args;
  const onto = await fetchOntologyRule();
  let rationale = { reason: null as string | null, prompt: '', raw: '' };
  if (onto) {
    try {
      rationale = await generateIdentityRationale({
          result: resolution.result,
          candidateName: args.candidateName,
          matchedCandidateId: resolution.matchedCandidateId,
          matchedCandidateName: resolution.matchedCandidateName,
          dedupAction: resolution.dedupAction,
          ontologyRuleId: onto.rule.id,
          ontologyRuleName: onto.rule.name,
          ruleDefinition: onto.definition,
        });
    } catch {
      // Deterministic judgment remains auditable without generated prose.
    }
  }

  const check = identityToCheck(
    resolution.result,
    args.rulesTotal,
    {
      matchedCandidateId: resolution.matchedCandidateId,
      matchedCandidateName: resolution.matchedCandidateName,
      dedupAction: resolution.dedupAction,
    },
    onto?.rule,
    rationale.reason,
  );

  try {
    return await persist({
      agentSlug: IDENTITY_AGENT_SLUG,
      agentName: IDENTITY_AGENT_NAME,
      stage: IDENTITY_STAGE,
      caseId: args.caseId,
      runId: args.runId ?? args.caseId,
      traceId: args.traceId,
      ruleSource: onto ? 'ontology-api' : args.snapshotSource,
      selectionNote: {
        pool: resolution.poolSize,
        ontologyRuleId: onto?.rule.id ?? null,
        matchedRule: resolution.result.matchedRule?.ruleId ?? null,
        matchedCandidateId: resolution.matchedCandidateId,
        matchedCandidateName: resolution.matchedCandidateName,
        dedupAction: resolution.dedupAction,
        sameAsCandidateId: resolution.sameAsCandidateId,
        llmPrompt: rationale.prompt || null,
        llmResponse: rationale.raw || null,
      },
      check,
    });
  } catch (error) {
    throw asRuleAuditPersistenceError(error);
  }
}
