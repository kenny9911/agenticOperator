// ruleCheckAgent — Workflow node 10-1 (`ruleCheckForMatchResume`).
//
// 2026-05-19 consolidation: 吸收原 matchResumeAgent 第一段。直接订阅
// `RESUME_PROCESSED` 后,本函数承担:
//   1. F1 — parsed.data 缺失时回拉 RAAS GET /candidates/:id/resumes/:rid/parsed
//   2. JR 列表收敛 —
//      - 路径 A (event.job_requisition_id 存在) → GET /requirements/:id
//      - 路径 B → GET /requirements/agent-view?claimer=&resume_filename= (F2)
//   3. for each JR:
//      - runRuleCheck(Ontology + Neo4j + LLM,fail-safe in-band)
//      - RAAS POST /match-results 写 rule_check_*(actions JSON 10-1 side-effect)
//      - PASS → emit MATCH_RULE_CHECK_PASSED (carries jr + parsed)
//      - FAIL/REVIEW → emit MATCH_RULE_CHECK_FAILED (F3 平铺 payload)
//
// 重派场景:partner 直接重发 `RESUME_PROCESSED`(带新 `job_requisition_id`),
// 本函数走路径 A,无任何额外订阅或代码改动。
//
// 见 docs/superpowers/specs/2026-05-19-rule-check-consolidation-design.md

import { NonRetriableError } from 'inngest';
import { createHash } from 'node:crypto';
import { buildRuleCheckInput, runRuleCheck, formatExplanation } from '@/lib/rule-check';
import { extractDims, severityForRuleId } from '@/lib/rule-check/ontology';
import { getLiveRuleCatalog } from '@/lib/rule-check/live-rule-catalog';
import {
  blockingExplanations,
  formatOptionalRuleReference,
} from '@/lib/rule-check/optional-reference';
import { asRuleAuditPersistenceError } from '@/lib/rule-check/ontology-audit-writer';
import { isInfraFailure, friendlyInfraReason } from '@/lib/rule-check/infra-failure';
import { recordNotification } from '@/server/notifications/ingest';
import { resolveAlertsByPrefix } from '@/server/notifications/resolve';
import { classifyLlm } from '@/lib/dependency-health/classify';
import { recordDependencySignal } from '@/lib/dependency-health/report';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';
import { notifyRecruitmentLifecycle } from '@/server/notifications/recruitment-lifecycle';
import { isPartnerPgConfigured } from '@/lib/partner-pg/client';
import { getRequirementDetail } from '@/lib/partner-pg/requirements';
import { getRequirementsAgentView } from '@/lib/partner-pg/agent-view';
import { getRecruitingJobsAsRequirements } from '@/lib/partner-pg/recruiting-jobs';
import { getParsedResume } from '@/lib/partner-pg/parsed-resume';
import { saveRuleCheckFailToPartnerPg } from '@/lib/partner-pg/rule-check-result';
/**
 * RequirementsAgentViewItem stays loose (Record<string, unknown>) here on
 * purpose — both path A merged shape and path B agent-view items flow through
 * the same helpers (pickRequisitionId / pickClientId / hasMatchableContent /
 * isRecruitingStatus), which probe field names defensively.
 */
type RequirementsAgentViewItem = Record<string, unknown>;
import {
  inngest,
  type MatchRuleCheckFailedData,
  type MatchRuleCheckPassedData,
  type RuleCheckAuditMeta,
  type RuleCheckRuntimeContext,
} from '@/server/inngest/client';
import { prisma } from '@/server/db';
import {
  writeCandidateMatchResultInstance,
  writeJobRequisitionInstance,
} from '@/lib/allmeta-writers';
import { createAgentLogger, runWithLogger } from '@/lib/agent-logger';
import { skipIfRaasV1Paused } from '@/server/inngest/raas-v1';

const AGENT_ID = 'rule-check-agent';
const AGENT_NAME = 'ruleCheck';

// Exported separately so it can be unit-tested without a live Inngest runtime.
export async function ruleCheckAgentHandler({
  event,
  step,
  logger,
  runId,
}: {
  event: { id?: string; name: string; data: unknown };
  step: {
    run: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
    sendEvent: (id: string, e: { name: string; data: unknown }) => Promise<unknown>;
  };
  logger: { info: (s: string) => void; warn: (s: string) => void; error: (s: string) => void };
  runId?: string;
}) {
  const data = unwrapResumeProcessedEvent(event.data);
  const traceId = getTraceId(event.data);
  const uploadId = pickUploadId(data);
  const candidateId = pickCandidateId(data);
  const employeeId = pickEmployeeId(data);
  const resumeId = typeof data.resume_id === 'string' ? data.resume_id : '';
  const parentAuditId = pickParentAuditId(data);
  // 透传候选人求职期望(resumeParser 抽出)→ matchResume 拼 candidatePreferences。
  const candidateExpectation =
    data.candidate_expectation && typeof data.candidate_expectation === 'object'
      ? (data.candidate_expectation as MatchRuleCheckPassedData['candidate_expectation'])
      : undefined;

  const fileLogger = createAgentLogger({
    agent: 'ruleCheck',
    runId: runId ?? `local-${Date.now()}`,
    traceId,
    anchors: {
      upload_id: uploadId,
      candidate_id: candidateId,
      employee_id: employeeId,
      resume_id: resumeId,
    },
  });
  return runWithLogger(fileLogger, async () => {
  fileLogger.event('handler.start', {
    event_name: event.name,
    upload_id: uploadId,
    candidate_id: candidateId,
    employee_id: employeeId,
    resume_id: resumeId,
  });

  // 2026-05-26 — STEP 1 完整入参: 上游 → AO 原始 event envelope (RESUME_PROCESSED).
  fileLogger.event('handler.raw_input', {
    from: 'AO.resumeParser (or RAAS thin-event)',
    to: 'AO.ruleCheck',
    event_name: event.name,
    raw_event_data: event.data,
  });

  if (!uploadId && !candidateId) {
    throw new NonRetriableError(`[${AGENT_NAME}] RESUME_PROCESSED 缺 upload_id 和 candidate_id`);
  }
  if (!employeeId) {
    throw new NonRetriableError(`[${AGENT_NAME}] RESUME_PROCESSED 缺 employee_id`);
  }
  if (!isPartnerPgConfigured()) {
    throw new NonRetriableError(`[${AGENT_NAME}] RAAS_POSTGRES_URL env 未配置`);
  }

  logger.info(
    `[${AGENT_NAME}] received ${event.name} · upload_id=${uploadId ?? '—'} ` +
      `candidate_id=${candidateId ?? '—'} employee_id=${employeeId}`,
  );

  const linkedJrId =
    typeof data.job_requisition_id === 'string' && data.job_requisition_id.trim().length > 0
      ? data.job_requisition_id.trim()
      : null;

  // ADR-0040 — RAAS Nextcloud 路径预填的窄化 JR 数组(单数 job_requisition_id 为空时
  // 才有意义)。已在 RAAS 侧按「文件名岗位名 × 招聘员名下在招岗位」模糊匹配收敛,
  // 这里直接对这些 JR 取详情撮合,跳过 path-B「按 employee_id 扫名下全部在招岗位」。
  const linkedJrIds = pickJobRequisitionIds(data);

  // ── 1. JR 列表收敛 ──
  // 2026-05-20: 直读 partner Postgres,不再走 RAAS HTTP API.
  const requirements = await step.run('list-requirements', async () => {
    if (linkedJrId) {
      const detail = await getRequirementDetail(linkedJrId);
      if (!detail) {
        throw new NonRetriableError(
          `[${AGENT_NAME}] partner Postgres: job_requisition ${linkedJrId} 不存在`,
        );
      }
      // 旧 RAAS API: { requirement, specification }
      // 新 partner-pg: requirement 整段 + .specification(nested via row_to_json)
      // 兼容下游 helper(probe field names): flatten 出来。
      const merged: RequirementsAgentViewItem = {
        ...(detail.specification ?? {}),
        ...detail,
      };
      if (!hasMatchableContent(merged)) {
        logger.warn(`[${AGENT_NAME}] linked JR ${linkedJrId} 内容空,跳过`);
        return [];
      }
      return [merged];
    }
    // path B' (ADR-0040) — RAAS 预填了窄化 JR 数组:直接对这些 id 逐个取详情,
    // 不再按 employee_id 扫该招聘员名下全部在招岗位。每个 JR 取详情 + flatten
    // spec(同 path A),hasMatchableContent 过滤空内容。某个 id 取不到详情则跳过
    // 该 id(不抛错,其余正常),全部取不到则落到下方 requirements.length===0 早退。
    if (linkedJrIds.length > 0) {
      logger.info(
        `[${AGENT_NAME}] path-B' prefilled JR ids · count=${linkedJrIds.length} · ` +
          `ids=${linkedJrIds.join(',')}`,
      );
      const details = await Promise.all(
        linkedJrIds.map(async (jrId) => {
          const detail = await getRequirementDetail(jrId);
          if (!detail) {
            logger.warn(`[${AGENT_NAME}] prefilled JR ${jrId} 在 partner Postgres 不存在,跳过`);
            return null;
          }
          const merged: RequirementsAgentViewItem = {
            ...(detail.specification ?? {}),
            ...detail,
          };
          if (!hasMatchableContent(merged)) {
            logger.warn(`[${AGENT_NAME}] prefilled JR ${jrId} 内容空,跳过`);
            return null;
          }
          return merged;
        }),
      );
      const matchable = details.filter((x): x is RequirementsAgentViewItem => x !== null);
      logger.info(
        `[${AGENT_NAME}] path-B' ${linkedJrIds.length} prefilled JR → ${matchable.length} matchable`,
      );
      return matchable;
    }
    // 2026-05-21 path B 收敛 — 按 RAAS partner 契约:
    //   - 真相源 = requirement_claim 表(recruiter 认领关系,不是 spec.hsm_*)
    //   - 招聘中 = job_posting.publish_status IN ('distributed','published')
    //   - 单条 SQL,JR + posting + claim 一起 JOIN 出来
    //   - draft / pending / closed 全过滤掉,只跑真的发布的岗位
    //
    // 实现:lib/partner-pg/recruiting-jobs.ts → getRecruitingJobsAsRequirements
    // 是适配层,把 partner spec 的 RecruitingJobRow[] 摊平成
    // AgentViewItem[],下游 helper 不用改。
    const resumeFilenameRaw =
      typeof data.filename === 'string' && data.filename.trim()
        ? data.filename.trim()
        : undefined;
    logger.info(
      `[${AGENT_NAME}] path-B recruiting JR lookup · recruiter_employee_id=${employeeId}` +
        (resumeFilenameRaw ? ` · resume_filename="${resumeFilenameRaw}"` : ''),
    );
    const r = await getRecruitingJobsAsRequirements({
      claimerEmployeeId: employeeId,
      resumeFilename: resumeFilenameRaw,
    });
    if ((r.items?.length ?? 0) === 0) {
      logger.warn(
        `[${AGENT_NAME}] path-B recruiter ${employeeId} 名下 0 个 published 岗位,停止匹配`,
      );
      return [] as RequirementsAgentViewItem[];
    }
    // hasMatchableContent 仍然保留 — partner spec 已经按 publish_status 过滤
    // 掉草稿/未发布的,但 JR 还可能缺业务内容(空 job_responsibility 等),
    // hasMatchableContent 是最后一道防线。isRecruitingStatus 不再需要 —
    // 上游已经按 publish_status 严格筛了。
    const matchable = (r.items ?? []).filter((it) =>
      hasMatchableContent(it as unknown as RequirementsAgentViewItem),
    );
    logger.info(
      `[${AGENT_NAME}] path-B recruiter has ${r.items?.length ?? 0} published JR → ` +
        `${matchable.length} matchable`,
    );
    return matchable as unknown as RequirementsAgentViewItem[];
  });

  if (requirements.length === 0) {
    return {
      ok: true,
      upload_id: uploadId,
      candidate_id: candidateId,
      employee_id: employeeId,
      requested_count: 0,
      reason:
        linkedJrId === null && linkedJrIds.length === 0
          ? 'no-published-jr-claimed-by-recruiter'
          : 'no-matchable-requirements',
    };
  }

  // ── 2. F1 — parsed.data 缺失时回拉 ──
  let parsedData: Record<string, unknown> | null =
    data.parsed && typeof data.parsed === 'object'
      ? ((data.parsed as Record<string, unknown>).data as Record<string, unknown> | undefined) ??
        null
      : null;
  // parsed_content (PDF rawText) — matchResume 第二段用作 /match-resume 的
  // resume 参数。fat-event 时从 parsed.data.rawText 提取;thin-event 时
  // 走下方 back-pull 一起从 partner-pg 拉。Null 兜底由 match-resume 处理。
  let parsedContent: string | null = (() => {
    const v = parsedData?.rawText ?? parsedData?.raw_text;
    return typeof v === 'string' && v.length > 0 ? v : null;
  })();

  if (!parsedData) {
    if (!candidateId || !resumeId) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] thin RESUME_PROCESSED missing candidate_id or resume_id — cannot back-pull parsed`,
      );
    }
    const pulled = await step.run('fetch-parsed-resume', async () => {
      const r = await getParsedResume(candidateId, resumeId);
      if (!r) {
        throw new NonRetriableError(
          `[${AGENT_NAME}] partner Postgres: resume not found · candidate_id=${candidateId} resume_id=${resumeId}`,
        );
      }
      logger.info(
        `[${AGENT_NAME}] thin-event back-pull OK · candidate_id=${candidateId} ` +
          `resume_id=${resumeId} data_keys=${Object.keys(r.data ?? {}).length} ` +
          `parsed_content_len=${r.parsed_content?.length ?? 0}`,
      );
      return { data: r.data ?? {}, parsed_content: r.parsed_content };
    });
    parsedData = pulled.data;
    parsedContent = pulled.parsed_content;
  }

  // ── 2b. 解析内容闸门 ──
  // 简历解析失败 / 空回拉 → 没有任何可核查的内容。上游 parser 在解析失败时
  // 不会 emit RESUME_PROCESSED,但 partner 重发 + 空回拉仍可能落到这里。此时
  // 必须停止该候选人,而不是对着空简历跑规则、判 PASS、再推进到 match / interview。
  // 对应 match-resume 的 resume-text-empty 守卫,但提前到这一环就拦住。
  const hasUsableResume =
    (typeof parsedContent === 'string' && parsedContent.trim().length > 0) ||
    (parsedData != null && Object.keys(parsedData).length > 0);
  if (!hasUsableResume) {
    logger.warn(
      `[${AGENT_NAME}] resume 无可用解析内容(解析失败/空回拉)· candidate_id=${candidateId ?? '—'} ` +
        `resume_id=${resumeId || '—'} — 停止,不推进下游`,
    );
    fileLogger.event('handler.resume-unparseable', {
      candidate_id: candidateId,
      resume_id: resumeId,
      upload_id: uploadId,
    });
    return {
      ok: false,
      upload_id: uploadId,
      candidate_id: candidateId,
      employee_id: employeeId,
      requested_count: requirements.length,
      reason: 'resume-unparseable-or-empty',
    };
  }

  const bypass = process.env.RULE_CHECK_BYPASS === 'true';
  let passed = 0;
  let failed = 0;

  // ── 3. for each JR: runRuleCheck → persist → emit ──
  for (const req of requirements) {
    const jrid = pickRequisitionId(req);
    if (!jrid) continue;
    const stepKey = sanitize(jrid);
    const clientId = pickClientId(req) ?? '';

    // ── 3a. 镜像 JR 到 Neo4j (via allmeta) ──
    // 路径 A: 直读单个 JR;路径 B: 循环每个 claimer 在招 JR.
    // 任一情况都保证 Rule Check Audit "实时读 :Job_Requisition" 能查到.
    await step.run(`write-jr-neo4j-${stepKey}`, async () => {
      const r = await writeJobRequisitionInstance({
        requirement: req as unknown as Record<string, unknown>,
      });
      if (r.ok) logger.info(`[${AGENT_NAME}] ✓ allmeta wrote Job_Requisition ${jrid}`);
      else logger.warn(`[${AGENT_NAME}] allmeta JR write failed jr=${jrid}: ${r.error}`);
      return r;
    });

    const runtimeContext: RuleCheckRuntimeContext = {
      upload_id: uploadId ?? '',
      candidate_id: candidateId ?? '',
      resume_id: resumeId,
      employee_id: employeeId,
      filename: typeof data.filename === 'string' ? data.filename : undefined,
      received_at: typeof data.receivedAt === 'string' ? data.receivedAt : undefined,
      trace_id: traceId ?? null,
    };

    if (bypass) {
      const bypassAudit: RuleCheckAuditMeta = {
        rules_evaluated: 0,
        graph_calls: 0,
        client_id: clientId,
        business_group: null,
        studio: null,
        llm_model: 'bypass',
        llm_duration_ms: 0,
        llm_round_trips: 0,
        rule_source: 'json-fallback',
        fail_reason: 'bypassed',
      };
      const bypassPayload: MatchRuleCheckPassedData = {
        candidate_id: candidateId ?? null,
        resume_id: resumeId || null,
        job_requisition_id: jrid,
        client_id: clientId,
        rule_check_result: '通过',
        rule_check_reason: '',
        upload_id: uploadId ?? null,
        employee_id: employeeId,
        audit: bypassAudit,
        job_requisition: req as unknown as Record<string, unknown>,
        parsed_resume: parsedData ?? null,
        parsed_content: parsedContent,
        candidate_expectation: candidateExpectation,
        runtime_context: runtimeContext,
      };
      await step.sendEvent(`emit-bypass-passed-${stepKey}`, {
        name: 'MATCH_RULE_CHECK_PASSED',
        data: bypassPayload,
      });
      logger.info(
        `[${AGENT_NAME}] ⏭ RULE_CHECK_BYPASS=true · directly emit MATCH_RULE_CHECK_PASSED for JR=${jrid}`,
      );
      passed += 1;
      continue;
    }

    const result = await step.run(`rule-check-${stepKey}`, async () => {
      fileLogger.event('step.start', {
        from: 'AO.ruleCheck',
        to: 'AO.ruleCheck.runner (LLM)',
        step_id: `rule-check-${stepKey}`,
        jr_id: jrid,
        client_id: clientId,
      });
      const input = buildRuleCheckInput({
        runtime_context: runtimeContext,
        parsed_resume: parsedData,
        job_requisition: req as unknown as Record<string, unknown>,
      });
      const r = await runRuleCheck(input, { logger: fileLogger });
      fileLogger.event('step.end', {
        from: 'AO.ruleCheck.runner',
        to: 'AO.ruleCheck',
        step_id: `rule-check-${stepKey}`,
        decision: r.decision,
        stats: r.stats,
        rules_evaluated: r.audit.rules_evaluated,
        explanations: r.explanations,         // 完整 per-rule 判定列表 + reason
        audit: r.audit,                       // 完整 audit (含 llm_model, llm_round_trips 等)
      });
      logger.info(
        `[${AGENT_NAME}] jr=${jrid} decision=${r.decision} ` +
          `stats=pass:${r.stats.pass}/fail:${r.stats.fail}/pending:${r.stats.pending}/info:${r.stats.insufficient_info} ` +
          `rules=${r.audit.rules_evaluated} graph_calls=${r.audit.graph_calls} ` +
          `model=${r.audit.llm_model} latency_ms=${r.audit.llm_duration_ms} ` +
          `tool_rounds=${r.audit.llm_round_trips}` +
          (r.audit.fail_reason ? ` fail_reason=${r.audit.fail_reason}` : ''),
      );

      // 2026-06-01 — Infrastructure failure (LLM gateway/401/timeout, unparseable
      // LLM output, graph unavailable, tool loop exhausted) is NOT a candidate
      // rejection. failSafe() returns decision='FAIL' with an infra fail_reason;
      // throwing HERE (inside the step) makes Inngest retry the step — re-calling
      // the LLM — and on retry exhaustion park the run for replay. It runs BEFORE
      // the audit / Neo4j CMR / partner-pg writes + emit below, so an infra outage
      // never writes 未通过 to the partner main table or emits MATCH_RULE_CHECK_FAILED.
      if (r.decision === 'FAIL' && isInfraFailure(r.audit.fail_reason)) {
        const reason = r.audit.fail_reason;
        logger.error(
          `[${AGENT_NAME}] ✗ rule-check infra failure jr=${jrid} reason=${reason} — retry+park, candidate NOT rejected`,
        );
        // LLM-vendor degrade (gateway down / 401 / out-of-funds) → ALSO feed the
        // unified dependency-health channel so it surfaces as a 没钱/故障/说不准
        // alert and on the Dependency Health card. Write-only: rule-check already
        // parks (throws) + fires its own rule_check_parked alert below, so we
        // don't hijack the throw here. Non-LLM infra (graph / tool-loop / parse)
        // is not a vendor-funds issue → no dependency signal.
        const llmDegrade = reason === 'llm-call-error' || reason === 'gateway-unavailable';
        const oc = llmDegrade
          ? classifyLlm('ruleCheck', new Error(r.audit.llm_error_detail ?? String(reason)))
          : null;
        if (oc && !oc.ok) {
          await recordDependencySignal(oc, {
            agent: 'RuleCheck',
            runId: runId ?? null,
            traceId: traceId ?? null,
            domain: RECRUITMENT_DOMAIN_ID,
            anchors: { candidate_id: candidateId, job_requisition_id: jrid, upload_id: uploadId },
          });
        }

        // Persist a PARKED audit row BEFORE throwing so the /rule-check page can
        // still show WHICH rules we fetched (rule_provenance) + a plain-language
        // reason (没钱/故障), even though no per-rule judgment was produced. This
        // is AO-side observability ONLY — decision='FAIL' for display but the
        // non-null fail_reason marks it as an infra park so 总览/漏斗 exclude it
        // from 通过/未通过 counts. Crucially we still write NO RuleCheckFlag rows,
        // NO Candidate_Match_Result, NO partner main-table 未通过, and emit no
        // FAILED event — those all live AFTER this throw. Idempotent upsert on a
        // stable id so Inngest retries overwrite instead of piling up rows.
        const parkedReason = friendlyInfraReason(reason, oc && !oc.ok ? oc.reason : undefined);
        const parkedAuditId = makePersistentAuditId({
          kind: 'parked',
          runId,
          traceId,
          eventId: event.id,
          uploadId,
          candidateId,
          resumeId,
          jobRequisitionId: jrid,
        });
        const parkedData = {
          run_id: runId ?? runtimeContext.trace_id ?? parkedAuditId,
          trace_id: runtimeContext.trace_id ?? null,
          upload_id: uploadId ?? '',
          candidate_id: candidateId ?? '',
          resume_id: resumeId || '',
          job_requisition_id: jrid,
          client_name: r.audit.client_name_resolved ?? null,
          client_display_name: r.audit.client_name_resolved ?? null,
          business_group: r.audit.business_group_resolved ?? null,
          studio: null,
          decision: 'FAIL',
          llm_decision: 'FAIL',
          failure_reasons: JSON.stringify([parkedReason]),
          fail_reason: reason,
          llm_model: r.audit.llm_model ?? 'unknown',
          llm_duration_ms: Math.round(r.audit.llm_duration_ms ?? 0),
          llm_prompt_tokens: r.audit.llm_prompt_tokens ?? null,
          llm_completion_tokens: r.audit.llm_completion_tokens ?? null,
          parse_error: r.audit.parse_error ?? null,
          rules_evaluated: r.audit.rules_evaluated ?? 0,
          // 规则库总数 = 候选规则全集(provenance,含被排除的);早期误写成
          // rules_evaluated(只数选中的)→ KPI「规则库 N」偏小。
          rules_total_in_ontology: r.audit.rule_provenance?.length || r.audit.rules_evaluated || 0,
          rule_source: r.audit.rule_source ?? 'ontology-api',
          partial_resume_fields: '[]',
          rule_provenance: JSON.stringify(r.audit.rule_provenance ?? []),
          user_prompt: r.audit.user_prompt ?? null,
          system_prompt: r.audit.system_prompt ?? null,
          llm_raw_text: r.audit.llm_raw_text ?? r.audit.raw_llm_text ?? null,
          // Carry the resume/JR snapshot so the 总览 "故障挂起的校验" panel can
          // show the candidate name + 岗位 (not "(未知候选人)").
          parsed_resume_json: parsedData ? JSON.stringify(parsedData) : null,
          job_requisition_json: req ? JSON.stringify(req) : null,
          parent_audit_id: parentAuditId,
        };
        try {
          await prisma.ruleCheckAudit.upsert({
            where: { audit_id: parkedAuditId },
            create: { audit_id: parkedAuditId, ...parkedData },
            update: parkedData,
          });
        } catch (error) {
          // A PARKED row is the authoritative record that this candidate was
          // *not* rejected because infrastructure failed. Never turn a failed
          // audit write into a successful/opaque run: keep the tagged error so
          // Inngest retries the same stable id before anything can advance.
          throw asRuleAuditPersistenceError(error);
        }
        logger.info(
          `[${AGENT_NAME}] ⏸ wrote PARKED audit ${parkedAuditId} reason=${reason} rules_fetched=${parkedData.rules_evaluated}`,
        );

        // Surface a critical alert into the 消息通知 center. Deduped by reason, so
        // a gateway outage collapses every parked rule-check into ONE alert with a
        // count — not N. Fire-and-forget: recordNotification never throws.
        await recordNotification({
          level: 'critical',
          category: 'system',
          source: 'rule-check',
          agent: AGENT_NAME,
          message: `规则校验因基础设施故障挂起(${reason})— 候选人未被拒绝,网关恢复后将自动重放`,
          runId: runId ?? null,
          traceId: traceId ?? null,
          anchors: { candidate_id: candidateId, job_requisition_id: jrid, upload_id: uploadId },
          dedupeHint: `rule_check_parked.${reason}`,
        });
        throw new Error(
          `[${AGENT_NAME}] rule-check infra failure (jr=${jrid}, reason=${reason}) — retrying; candidate NOT rejected`,
        );
      }

      return r;
    });

    // 跑到这里 = 本次规则校验没有 park → 网关/基础设施已恢复。把还在 firing 的
    // rule_check_parked.* 告警解除 — 告警 body 承诺"网关恢复后将自动重放",
    // 续跑成功却不关告警会让 firing 行永久挂着(2026-06-11 审计)。Fire-and-forget。
    void resolveAlertsByPrefix('rule_check_parked.').catch(() => {});

    // Optional rules are real evaluations, but reference-only. Keep the split
    // once and reuse it for the safety gate, audit, events, partner-pg and the
    // Neo4j Candidate_Match_Result write so no downstream path can accidentally
    // reinterpret an optional fail as a blocker.
    const blockingFailures = blockingExplanations(result.explanations);
    const optionalRuleReference = formatOptionalRuleReference(result.rule_results);

    // Final safety gate: no non-business FAIL may cross into downstream state
    // writes or MATCH_RULE_CHECK_FAILED. This is intentionally close to the
    // emit/write section, so future refactors cannot accidentally bypass the
    // in-step infra guard above and reject a candidate because the LLM/parser
    // failed.
    if (result.decision === 'FAIL') {
      const failReason = result.audit.fail_reason;
      const hasBusinessEvidence = blockingFailures.length > 0;
      if (failReason || !hasBusinessEvidence) {
        await recordNotification({
          level: 'critical',
          category: 'system',
          source: 'rule-check',
          agent: AGENT_NAME,
          message: `规则校验未产出业务失败证据,已阻止 MATCH_RULE_CHECK_FAILED emit (reason=${failReason ?? 'empty-explanations'})`,
          runId: runId ?? null,
          traceId: traceId ?? null,
          anchors: { candidate_id: candidateId, job_requisition_id: jrid, upload_id: uploadId },
          dedupeHint: `rule_check_emit_guard.${failReason ?? 'empty-explanations'}`,
        });
        throw new Error(
          `[${AGENT_NAME}] blocked unsafe MATCH_RULE_CHECK_FAILED emit (jr=${jrid}, reason=${failReason ?? 'empty-explanations'}); candidate NOT rejected`,
        );
      }
    }

    const dims = extractDims(req as unknown as Record<string, unknown>);
    const audit: RuleCheckAuditMeta = {
      rules_evaluated: result.audit.rules_evaluated,
      graph_calls: result.audit.graph_calls,
      client_id: dims.client_id,
      business_group: result.audit.business_group_resolved ?? dims.business_group,
      studio: dims.studio,
      llm_model: result.audit.llm_model,
      llm_duration_ms: result.audit.llm_duration_ms,
      llm_round_trips: result.audit.llm_round_trips,
      llm_prompt_tokens: result.audit.llm_prompt_tokens,
      llm_completion_tokens: result.audit.llm_completion_tokens,
      rule_source: result.audit.rule_source,
      fail_reason: result.audit.fail_reason,
    };

    // ★ Wire audit into Prisma so /rule-check UI gets live data
    //   (the page reads from prisma.ruleCheckAudit via /api/rule-check-audits;
    //    before this hook the table only had stale 2026-05-15 fixtures).
    // Persistence is a mandatory gate: audit + every flag commit atomically,
    // and downstream writes/events only happen after this step succeeds.
    // A thrown DB error lets Inngest retry the same stable audit id.
    await step.run(`write-audit-${stepKey}`, async () => {
      const auditId = makePersistentAuditId({
        kind: 'decision',
        runId,
        traceId,
        eventId: event.id,
        uploadId,
        candidateId,
        resumeId,
        jobRequisitionId: jrid,
      });
      const liveCat = await getLiveRuleCatalog();
      const flagRows = result.rule_results.map((rr) => {
        const liveRule = liveCat.get(rr.rule_id);
        const s = rr.status.toLowerCase();
        const resultUpper =
          s === 'pass'
            ? 'PASS'
            : s === 'fail'
              ? 'FAIL'
              : s === 'insufficient_info'
                ? 'INSUFFICIENT_INFO'
                : s === 'not_triggered'
                  ? 'NOT_TRIGGERED'
                  : s === 'review' || s === 'pending'
                    ? 'REVIEW'
                    : rr.status.toUpperCase();
        return {
          flag_id: `${auditId}::${rr.rule_id}`,
          audit_id: auditId,
          rule_id: rr.rule_id,
          rule_name_snapshot: liveRule?.businessLogicRuleName ?? '',
          severity: rr.severity ?? liveRule?.severity ?? severityForRuleId(rr.rule_id),
          applicable_client: dims.client_id || null,
          applicable: s !== 'not_triggered',
          result: resultUpper,
          evidence: rr.reason ?? null,
          next_action: rr.next_action ?? null,
        };
      });
      const auditData = {
        run_id: runId ?? runtimeContext.trace_id ?? auditId,
        trace_id: runtimeContext.trace_id ?? null,
        upload_id: uploadId ?? '',
        candidate_id: candidateId ?? '',
        resume_id: resumeId || '',
        job_requisition_id: jrid,
        client_name: dims.client_id || null,
        client_display_name: result.audit.client_name_resolved ?? null,
        business_group: result.audit.business_group_resolved ?? dims.business_group ?? null,
        studio: dims.studio ?? null,
        decision: result.decision === 'FAIL' ? 'FAIL' : 'PASS',
        llm_decision: result.decision,
        failure_reasons: JSON.stringify(blockingFailures.map(formatExplanation)),
        llm_model: result.audit.llm_model,
        llm_duration_ms: Math.round(result.audit.llm_duration_ms ?? 0),
        llm_prompt_tokens: result.audit.llm_prompt_tokens ?? null,
        llm_completion_tokens: result.audit.llm_completion_tokens ?? null,
        parse_error: result.audit.parse_error ?? null,
        rules_evaluated: result.audit.rules_evaluated ?? 0,
        rules_total_in_ontology:
          result.audit.rule_provenance?.length || result.audit.rules_evaluated || 0,
        rule_source: result.audit.rule_source ?? 'unknown',
        fail_reason: result.audit.fail_reason ?? null,
        partial_resume_fields: '[]',
        rule_provenance: JSON.stringify(result.audit.rule_provenance ?? []),
        user_prompt: result.audit.user_prompt ?? null,
        system_prompt: result.audit.system_prompt ?? null,
        llm_raw_text: result.audit.llm_raw_text ?? result.audit.raw_llm_text ?? null,
        parsed_resume_json: parsedData ? JSON.stringify(parsedData) : null,
        job_requisition_json: req ? JSON.stringify(req) : null,
        parent_audit_id: parentAuditId,
      };

      await prisma.$transaction(async (tx) => {
        await tx.ruleCheckAudit.upsert({
          where: { audit_id: auditId },
          create: { audit_id: auditId, ...auditData },
          update: auditData,
        });
        await tx.ruleCheckFlag.deleteMany({ where: { audit_id: auditId } });
        if (flagRows.length > 0) await tx.ruleCheckFlag.createMany({ data: flagRows });
      });

      logger.info(
        `[${AGENT_NAME}] ✓ durably wrote RuleCheckAudit ${auditId} decision=${result.decision} flags=${flagRows.length}`,
      );
      return { auditId, flags: flagRows.length };
    });

    // ★ actions JSON 10-1 side_effect: write Candidate_Match_Result instance
    //   to Neo4j via Allmeta Ontology API. `rule_check_reason` is the canonical
    //   ontology field used for both blocking reasons and a JSON snapshot of
    //   every optional outcome. The optional section is explicitly labelled
    //   reference-only and never changes `rule_check_result`.
    //   PK convention: cmr_<candidate>_<jr>  (one row per (candidate, JR) pair).
    //   Soft-fail: write errors don't block emit downstream.
    await step.run(`write-cmr-${stepKey}`, async () => {
      const cmrId = `cmr_${candidateId || 'unknown'}_${jrid}`;
      // rule_check_result 二元化:通过/未通过。原因只把 mandatory 写成阻断原因;
      // optional 全量判定另附为参考(包括 PASS/not_triggered),保证 Neo4j 可追溯。
      const ruleCheckResult: '通过' | '未通过' =
        result.decision === 'FAIL' ? '未通过' : '通过';
      const blockingReason =
        result.decision === 'FAIL'
          ? blockingFailures.map(formatExplanation).join(' | ').slice(0, 1000)
          : '';
      const ruleCheckReason = [blockingReason, optionalRuleReference].filter(Boolean).join(' | ');
      const r = await writeCandidateMatchResultInstance({
        candidate_match_result_id: cmrId,
        client_id: clientId,
        candidate_id: candidateId || '',
        job_requisition_id: jrid,
        rule_check_result: ruleCheckResult,
        rule_check_reason: ruleCheckReason,
      });
      if (r.ok) {
        logger.info(
          `[${AGENT_NAME}] ✓ allmeta wrote Candidate_Match_Result ${cmrId} rule_check_result=${ruleCheckResult}`,
        );
      } else {
        logger.warn(`[${AGENT_NAME}] allmeta CMR write failed jr=${jrid}: ${r.error}`);
      }
      return r;
    });

    // Policy 2026-06-01 (fail-closed): 底线规则信息不足/待复核/未能评估都折成 FAIL,
    // 只剩 PASS / FAIL 两态。PASS → rule_check_result='通过',直接进 MATCH_RULE_CHECK_PASSED。
    if (result.decision !== 'FAIL') {
      const payload: MatchRuleCheckPassedData = {
        candidate_id: candidateId ?? null,
        resume_id: resumeId || null,
        job_requisition_id: jrid,
        client_id: clientId,
        rule_check_result: '通过',
        rule_check_reason: '',
        upload_id: uploadId ?? null,
        employee_id: employeeId,
        audit,
        // 逐条判定结论 → matchResume 追加进 jd 文本(深度匹配参考)。reason 截 300 防事件过大。
        rule_check_rules: result.rule_results.map((r) => ({
          rule_id: r.rule_id,
          rule_name: r.rule_name,
          status: r.status,
          reason: r.reason ? r.reason.slice(0, 300) : undefined,
          enforcement_level: r.enforcement_level,
          failure_policy: r.failure_policy,
          blocking: r.blocking,
        })),
        job_requisition: req as unknown as Record<string, unknown>,
        parsed_resume: parsedData ?? null,
        parsed_content: parsedContent,
        candidate_expectation: candidateExpectation,
        runtime_context: runtimeContext,
      };
      await step.sendEvent(`emit-passed-${stepKey}`, {
        name: 'MATCH_RULE_CHECK_PASSED',
        data: payload,
      });
      await notifyRecruitmentLifecycle(step, 'MATCH_RULE_CHECK_PASSED', {
        anchors: { candidate_id: candidateId ?? null, job_requisition_id: jrid, upload_id: uploadId ?? null },
        runId: runId ?? null,
        traceId,
      });
      logger.info(`[${AGENT_NAME}] ✓ emitted MATCH_RULE_CHECK_PASSED for JR=${jrid}`);
      passed += 1;
    } else {
      // 只有 mandatory/底线规则进 failed_rules；optional 结论已经作为参考
      // 落审计 + Neo4j,不污染业务失败契约。
      const failedRules = blockingFailures.map((e) => ({
        rule_id: e.rule_id,
        rule_name: e.rule_name,
        step_id: e.step_id,
        severity: undefined,
        reason: e.reason,
      }));
      // match_reason / 事件 rule_check_reason:用统一 formatExplanation(信息不足等带标注)。
      const failureReason = blockingFailures
        .map(formatExplanation)
        .join(' | ')
        .slice(0, 1000);

      // 2026-05-26 — rule-check FAIL 用专用精简 writer 无条件写 partner-pg 主表.
      // 之前复用通用 saveMatchResultsToPartnerPg:主表行被 `if (resolvedJobPostingId)`
      // 守卫,没 job_posting 的 JR(路径 A/reassign)FAIL 不落主表;还带 runtime_state +
      // sparser 守卫这些跟 rule-check 失败无关的逻辑。改用 saveRuleCheckFailToPartnerPg:
      // 只 upsert candidate_match_result(match_status='未通过' + match_reason),无条件落,
      // 不依赖 posting,不写 runtime_state。partner-pg 没有 rule_check_* 列,失败结果
      // 映射到 match_status/match_reason(rule_check_* 只在 Allmeta/Neo4j)。
      // PK 跟 Allmeta CMR 对齐: `cmr_<candidate>_<jr>`. Soft-fail: 写挂不阻塞 emit.
      const cmrIdForPg = `cmr_${candidateId || 'unknown'}_${jrid}`;
      if (candidateId && isPartnerPgConfigured()) {
        await step.run(`persist-cmr-pg-fail-${stepKey}`, async () => {
          try {
            const r = await saveRuleCheckFailToPartnerPg({
              candidate_match_result_id: cmrIdForPg,
              candidate_id: candidateId,
              job_requisition_id: jrid,
              client_id: clientId,
              match_reason: failureReason,
              created_by: 'ai_engine.ruleCheck',
            });
            logger.info(
              `[${AGENT_NAME}] ✓ partner-pg candidate_match_result UPSERT (FAIL) · ${r.candidate_match_result_id} created=${r.created} jp=${r.job_posting_id ?? '-'}`,
            );
            return { ok: true, ...r };
          } catch (e) {
            logger.warn(
              `[${AGENT_NAME}] partner-pg CMR FAIL write failed · cmr=${cmrIdForPg} err=${(e as Error).message} — soft-fail, 仍 emit _FAILED`,
            );
            return { ok: false, error: (e as Error).message };
          }
        });
      }

      const failedPayload: MatchRuleCheckFailedData = {
        candidate_id: candidateId || null,
        resume_id: resumeId || null,
        job_requisition_id: jrid,
        client_id: clientId,
        rule_check_result: '未通过',
        rule_check_reason: failureReason,
        failed_rules: failedRules,
        upload_id: uploadId || null,
        matching_score: null,
        success: false,
        data: { audit },
      };
      await step.sendEvent(`emit-failed-${stepKey}`, {
        name: 'MATCH_RULE_CHECK_FAILED',
        data: failedPayload,
      });
      await notifyRecruitmentLifecycle(step, 'MATCH_RULE_CHECK_FAILED', {
        anchors: { candidate_id: candidateId ?? null, job_requisition_id: jrid, upload_id: uploadId ?? null },
        runId: runId ?? null,
        traceId,
      });
      logger.info(
        `[${AGENT_NAME}] ✗ emitted MATCH_RULE_CHECK_FAILED for JR=${jrid} (${result.decision}) — ${failedRules.length} failed rule(s)`,
      );
      failed += 1;
    }
  }

  fileLogger.event('handler.done', {
    from: 'AO.ruleCheck',
    to: '(handler return)',
    upload_id: uploadId,
    candidate_id: candidateId,
    employee_id: employeeId,
    requested_count: requirements.length,
    passed,
    failed,
  });

  return {
    ok: true,
    upload_id: uploadId,
    candidate_id: candidateId,
    employee_id: employeeId,
    requested_count: requirements.length,
    passed,
    failed,
  };
  }); // runWithLogger
}

export const ruleCheckAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Rule Check Agent',
    retries: 3,
    triggers: [{ event: 'RESUME_PROCESSED' }],
  },
  async (ctx) => {
    const c = ctx as unknown as Parameters<typeof ruleCheckAgentHandler>[0];
    const paused = await skipIfRaasV1Paused(AGENT_ID, c.logger);
    if (paused) return paused;
    return ruleCheckAgentHandler(c);
  },
);

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function unwrapResumeProcessedEvent(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, any>;
  if (r.payload && typeof r.payload === 'object' && !Array.isArray(r.payload)) {
    return { ...(r.payload as Record<string, any>) };
  }
  return r;
}

function pickUploadId(data: any): string | null {
  for (const c of [data.upload_id, data.uploadId, data.etag, data.object_key, data.objectKey]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

function pickCandidateId(data: any): string | null {
  if (typeof data.candidate_id === 'string' && data.candidate_id.trim()) return data.candidate_id.trim();
  return null;
}

function pickParentAuditId(data: any): string | null {
  const replayMeta = data?.replay_meta;
  if (!replayMeta || typeof replayMeta !== 'object' || Array.isArray(replayMeta)) return null;
  const value = (replayMeta as Record<string, unknown>).parent_audit_id;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// ADR-0040 — RAAS 预填的窄化 JR 数组。容忍 snake/camel、非数组、空串、重复值,
// 产出去重、去空白的 string[]。
function pickJobRequisitionIds(data: any): string[] {
  const raw = data?.job_requisition_ids ?? data?.jobRequisitionIds;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function pickEmployeeId(data: any): string | null {
  for (const c of [
    data.claimer_employee_id,
    data.employee_id,
    data.employeeId,
    data.operator_id,
    process.env.RAAS_DEFAULT_EMPLOYEE_ID,
  ]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

function pickRequisitionId(req: RequirementsAgentViewItem): string | null {
  for (const c of [
    (req as any).job_requisition_id,
    (req as any).requisition_id,
    (req as any).job_id,
    (req as any).id,
  ]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return null;
}

function pickClientId(req: RequirementsAgentViewItem): string | undefined {
  for (const c of [(req as any).client_id, (req as any).clientId]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return undefined;
}

function hasMatchableContent(req: RequirementsAgentViewItem): boolean {
  const r = req as Record<string, any>;
  return !!(
    r.job_responsibility?.toString().trim() ||
    r.job_requirement?.toString().trim() ||
    (Array.isArray(r.must_have_skills) && r.must_have_skills.length > 0)
  );
}

function isRecruitingStatus(req: RequirementsAgentViewItem): boolean {
  const r = req as Record<string, any>;
  let raw: unknown = undefined;
  for (const c of [r.status, r.hc_status, r.requisition_status, r.spec_status, r.job_requisition_status]) {
    if (c != null && String(c).trim() !== '') {
      raw = c;
      break;
    }
  }
  if (raw === undefined) return true;
  const s = String(raw).toLowerCase().trim();
  return s === 'recruiting' || s === '招聘中' || s === 'active' || s === 'open';
}

function getTraceId(eventData: unknown): string | undefined {
  if (!eventData || typeof eventData !== 'object') return undefined;
  const r = eventData as Record<string, any>;
  const t = r.trace;
  if (t && typeof t === 'object' && typeof t.trace_id === 'string' && t.trace_id) {
    return t.trace_id;
  }
  return undefined;
}

/**
 * One logical rule-check execution gets one durable row. Inngest retries reuse
 * runId/eventId and therefore upsert the same row; a later execution has a new
 * runId and cannot overwrite historical audits for the same candidate + JR.
 */
export function makePersistentAuditId(input: {
  kind: 'decision' | 'parked';
  runId?: string;
  eventId?: string;
  traceId?: string;
  uploadId?: string | null;
  candidateId?: string | null;
  resumeId?: string | null;
  jobRequisitionId: string;
}): string {
  const executionIdentity =
    input.runId ||
    input.eventId ||
    input.traceId ||
    `anchors:${input.uploadId ?? ''}:${input.candidateId ?? ''}:${input.resumeId ?? ''}`;
  const digest = createHash('sha256')
    .update([
      input.kind,
      executionIdentity,
      input.uploadId ?? '',
      input.candidateId ?? '',
      input.resumeId ?? '',
      input.jobRequisitionId,
    ].join('\u0000'))
    .digest('hex')
    .slice(0, 40);
  return `rca_${input.kind}_${digest}`;
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 80) || 'unknown';
}
