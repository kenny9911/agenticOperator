// rule-check-candidate-identity — 候选人查重 RULE-CHECK agent("是不是同一个人")。
//
// 2026-06-11 形态(invoke 模式):一个**独立注册、舰队可管理**的 Inngest 函数,但
// **不具备任何存储操作** —— 只做「抽取规则(9-15)→ 三级判定 → 落审计 → 返回结论」。
// 简历解析在落库**之前**用 step.invoke 同步调用它并等待返回值,用结论驱动落库
// (挂老档 / 新建);查重函数自己绝不写 candidate / resume 表。
//   - 每次 invoke 产生本函数自己的 run(舰队页运行数/成功率/耗时全真实)。
//   - 本函数下线或失败 → 解析端 catch 后按「新候选人」降级,主链路零阻塞。
//   - 判定完成后补发本体预留的 CANDIDATE_IDENTITY_CHECKED 事件(action 10-3 的
//     triggered_event),当前无订阅者,纯通知/蓝图闭环。
//
// trigger 是专用事件 CANDIDATE_IDENTITY_REQUESTED(正常链路不发,主路径是被 invoke;
// 留作手动/独立复核入口)。判定与审计共用 lib/rule-check/candidate-match/ 的共享
// 模块(resolveIdentityMatch + auditIdentityResolution),与解析端永远同一套逻辑。
//
// 三级规则:精确字段(手机号/邮箱/性别)直接比对,模糊字段(姓名/学校/专业/学历)
// 大模型语义等价;弱命中(第3级六字段)只标人工复核,绝不自动合并。业务依赖可降级,
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
    // 总开关:CANDIDATE_IDENTITY_ENABLED=0 关闭查重(解析端同样跳过 invoke)。
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
            same_as_candidate_id: computed.sameAsCandidateId,
            dedup_action: computed.dedupAction,
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
      // ④ 返回结论 —— 这是 step.invoke 的返回值,简历解析用它驱动落库。
      return {
        skipped: false as const,
        samePerson: computed.result.samePerson,
        matchedRule: computed.result.matchedRule?.ruleId ?? null,
        matchedCandidateId: computed.matchedCandidateId,
        matchedCandidateName: computed.matchedCandidateName,
        sameAsCandidateId: computed.sameAsCandidateId,
        dedupAction: computed.dedupAction,
        needsHumanReview: computed.result.needsHumanReview,
        poolSize: computed.poolSize,
        auditId: audit.id,
      };
    } catch (e) {
      if (isRuleAuditPersistenceFailure(e)) throw e;
      // Soft-fail:查重绝不向调用方(简历解析)抛错 —— 返回 error,解析按新人降级。
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
