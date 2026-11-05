// rule-check-candidate-identity — 候选人查重 RULE-CHECK agent("是不是同一个人")。
//
// 独立注册、舰队可管理的 audit-only Inngest 函数。它不写 candidate / resume，
// 也不再被简历解析同步 invoke。只有规范中国大陆手机号命中是确定身份信号；
// 姓名/邮箱/六字段相似只产生人工复核证据。
//   - 判定完成后补发本体预留的 CANDIDATE_IDENTITY_CHECKED 事件(action 10-3 的
//     triggered_event),当前无订阅者,纯通知/蓝图闭环。
//
// 唯一 trigger 是专用事件 CANDIDATE_IDENTITY_REQUESTED，留作手动/独立复核入口；
// 正常简历入库链路不发送也不等待它。
//
// 三级规则:手机号为唯一确定身份信号；姓名/邮箱/六字段命中均只标人工复核。
// 模糊字段可用大模型生成相似性证据,绝不自动合并。业务依赖可降级,
// 但审计库写失败会抛出重试,禁止产生无审计结论。

import { inngest } from '@/server/inngest/client';
import { createAgentLogger, runWithLogger } from '@/lib/agent-logger';
import {
  loadCandidateMatchRules,
  identityRulesByPriority,
} from '@/lib/rule-check/candidate-match/rules-data';
import { resolveIdentityMatch, type IdentityResolution } from '@/lib/rule-check/candidate-match/resolve-identity';
import { auditIdentityResolution } from '@/lib/rule-check/candidate-match/audit-identity';
import { type PersistCandidateCheckArgs, persistCandidateRuleCheck } from '@/lib/rule-check/candidate-match/persist';
import { isRuleAuditPersistenceFailure } from '@/lib/rule-check/ontology-audit-writer';
import {
  candidateFromResumeProcessed,
  partnerPgCandidateRepo,
  type CandidateRepo,
} from '@/lib/rule-check/candidate-match/candidate-repo';
import { makeAiFieldJudge } from '@/lib/rule-check/candidate-match/ai-equivalence';
import type { AiFieldJudge } from '@/lib/rule-check/candidate-match/field-equivalence';
import { skipIfRaasV1Paused } from '@/server/inngest/raas-v1';

const AGENT_ID = 'rule-check-candidate-identity-agent';
const AGENT_NAME = '候选人查重';

export interface IdentityHandlerDeps {
  repo: CandidateRepo;
  judge: AiFieldJudge;
  persist: (a: PersistCandidateCheckArgs) => Promise<{ id: string }>;
  enabled: boolean;
}

function defaultDeps(): IdentityHandlerDeps {
  return {
    repo: partnerPgCandidateRepo,
    judge: makeAiFieldJudge(),
    persist: persistCandidateRuleCheck,
    // 总开关:CANDIDATE_IDENTITY_ENABLED=0 关闭独立审计入口。
    enabled: process.env.CANDIDATE_IDENTITY_ENABLED !== '0',
  };
}

interface HandlerCtx {
  event: { data?: Record<string, unknown> } | Record<string, unknown>;
  step: {
    run: (id: string, fn: () => unknown) => Promise<unknown>;
    sendEvent?: (id: string, ev: { name: string; data: Record<string, unknown> }) => Promise<unknown>;
  };
  runId?: string;
}

export async function candidateIdentityHandler(ctx: HandlerCtx, depsOverride: Partial<IdentityHandlerDeps> = {}) {
  const deps = { ...defaultDeps(), ...depsOverride };
  if (!deps.enabled) return { skipped: 'disabled' as const };

  const ev = ((ctx.event as { data?: Record<string, unknown> }).data ?? ctx.event) as Record<string, any>;
  const rec = candidateFromResumeProcessed(ev);
  const caseId = ctx.runId ?? (ev.upload_id as string) ?? rec.candidate_id;
  const ruleset = loadCandidateMatchRules();
  const rules = identityRulesByPriority(ruleset);

  // 统一审计日志:handler 三相 + 嵌套 partner-pg/LLM 调用经 ALS 归属到本 run。
  const fileLogger = createAgentLogger({
    agent: 'candidateIdentity',
    runId: caseId,
    traceId: (ev.trace_id as string) ?? null,
    anchors: { candidate_id: rec.candidate_id, upload_id: (ev.upload_id as string) ?? null },
  });
  return runWithLogger(fileLogger, async () => {
    fileLogger.event('handler.start', { invoked_by: (ev.invoked_by as string) ?? 'event', candidate_id: rec.candidate_id });
    try {
      // ① 判定(纯读:对比池查询 + 三级规则;模糊字段大模型等价)。
      const computed = (await ctx.step.run('compute-identity-match', async () =>
        resolveIdentityMatch(rec, deps.repo, rules, deps.judge),
      )) as IdentityResolution;

      // ② 同一份结论落审计(抓 9-15 + 大模型判定依据 + mandatory persist)。
      const audit = (await ctx.step.run('persist-identity-audit', async () =>
        auditIdentityResolution({
          resolution: computed,
          candidateName: rec.name ?? null,
          rulesTotal: rules.length,
          snapshotSource: ruleset.source,
          caseId,
          runId: ctx.runId ?? caseId,
          traceId: (ev.trace_id as string) ?? null,
          persist: deps.persist,
        }),
      )) as { id: string };

      // ③ 本体蓝图闭环:发 CANDIDATE_IDENTITY_CHECKED(当前无订阅者,纯通知)。
      if (ctx.step.sendEvent) {
        await ctx.step.sendEvent('emit-identity-checked', {
          name: 'CANDIDATE_IDENTITY_CHECKED',
          data: {
            upload_id: (ev.upload_id as string) ?? null,
            candidate_id: rec.candidate_id,
            resume_id: (ev.resume_id as string) ?? null,
            same_person: computed.result.samePerson,
            dedup_action: computed.dedupAction,
            suspected_candidate_id:
              computed.dedupAction === 'pending-review' ? computed.matchedCandidateId : null,
            matched_rule: computed.result.matchedRule?.ruleId ?? null,
            audit_id: audit.id,
          },
        });
      }

      fileLogger.event('handler.done', {
        same_person: computed.result.samePerson,
        matched_rule: computed.result.matchedRule?.ruleId ?? null,
        dedup_action: computed.dedupAction,
        audit_id: audit.id,
      });
      // ④ 返回独立审计结论，供手动复核入口和可观测页展示。
      return {
        skipped: false as const,
        samePerson: computed.result.samePerson,
        matchedRule: computed.result.matchedRule?.ruleId ?? null,
        matchedCandidateId: computed.matchedCandidateId,
        matchedCandidateName: computed.matchedCandidateName,
        dedupAction: computed.dedupAction,
        needsHumanReview: computed.result.needsHumanReview,
        poolSize: computed.poolSize,
        auditId: audit.id,
      };
    } catch (e) {
      if (isRuleAuditPersistenceFailure(e)) throw e;
      // 非审计写入错误以可观测结果返回；审计持久化失败仍必须抛出重试。
      fileLogger.event('handler.error', { error: (e as Error).message ?? String(e) });
      return { skipped: false as const, error: (e as Error).message ?? String(e) };
    }
  });
}

export const candidateIdentityAgent = inngest.createFunction(
  { id: AGENT_ID, name: AGENT_NAME, retries: 1, triggers: [{ event: 'CANDIDATE_IDENTITY_REQUESTED' }] },
  async (ctx) => {
    const c = ctx as unknown as HandlerCtx & { logger?: { warn?: (message: string) => void } };
    const paused = await skipIfRaasV1Paused(AGENT_ID, c.logger);
    if (paused) return paused;
    return candidateIdentityHandler(c);
  },
);
