// createJD agent — Workflow node 4.
//
// Subscribes CLARIFICATION_READY → 生成 JD → 在 Partner PG
// 同一事务写 JobPosting + JD_GENERATED outbox，由 RAAS dispatcher 可靠投递。
//
// Workflow A (per agentic-operator-onboarding(3).md, 2026-05-08;
//   F4 direct-RoboHire migration 2026-05-19):
//   ❌ 不再调 OpenAI/LLM gateway 直连 (lib/llm/jd-generator.ts 退役)
//   ❌ 不再自己组装 partner-canonical 15 字段 payload (RAAS 处理)
//   ❌ 不再走 RAAS /api/v1/generate-jd 透传 (PR-4 删除)
//   ✅ 调 robohire-client.generateJdDirect (直连 RoboHire /api/v1/jobs/generate-jd)
//   ✅ 直写 Partner PG (JobPosting + JobRequisition enrichment + event_outbox)
//
// Inbound:  CLARIFICATION_READY
// Outbound: JD_GENERATED       JD content + bookkeeping (cascade only)

import { NonRetriableError } from 'inngest';
import { isPartnerPgConfigured } from '@/lib/partner-pg/client';
import {
  getRequirementDetail,
  getClarificationRecords,
  getClientContext,
  type RequirementClarificationRecord,
} from '@/lib/partner-pg/requirements';
import { fetchOntologyActionRules } from '@/lib/ontology-rules';
import { verifyJdCompliance } from '@/lib/robohire/verify-jd-compliance';
import {
  buildCompanyBackgroundBlock,
  buildGenerationConstraintsBlock,
  budgetPrompt,
} from '@/lib/robohire/jd-prompt-blocks';
import {
  syncJdToPartnerPg,
  type SyncJdInput,
} from '@/lib/partner-pg/job-posting';
import type {
  JobRequisition as RaasRequirement,
  JobRequisitionSpecification as RaasRequirementSpecification,
} from '@/lib/partner-pg/types';
import {
  generateJdDirect,
  RobohireApiError,
  type RobohireGenerateJdData,
} from '@/lib/robohire-client';
import { classifyRobohire } from '@/lib/dependency-health/classify';
import { reportDependencyDegraded } from '@/lib/dependency-health/report';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';
import {
  writeJobPostingInstance,
  writeJobRequisitionInstance,
} from '@/lib/allmeta-writers';
import { inngest } from '@/server/inngest/client';
import { skipIfRaasV1Paused } from '@/server/inngest/raas-v1';
import { createAgentLogger, runWithLogger } from '@/lib/agent-logger';
import { notifyRecruitmentLifecycle } from '@/server/notifications/recruitment-lifecycle';

const AGENT_ID = 'create-jd-agent';
const AGENT_NAME = 'createJD';
const GENERATOR_VERSION = 'workflow-a@2026-05-08';
/** Ontology domain for the RAAS-v1 recruitment graph (createJD rule fetch). */
const RAAS_V1_ONTOLOGY_DOMAIN = 'RAAS-v1';
/** Placeholder JD title when we have no usable title (unnamed posting). */
const UNTITLED_JD = '未命名岗位';

// ─── Inbound envelope shape ─────────────────────────────────────────

type RaasRequirementPayload = {
  client_id?: string;
  is_urgent?: boolean;
  requirement_id?: string;
  job_requisition_id?: string;
  source_channel?: string | null;
  /**
   * RAAS ADR-0154 — 用户在需求详情页显式勾选「覆盖已发布岗位」。
   * 放行 partner-pg 的既有岗位保护闸；覆盖后岗位强制写回未发布态重审。
   */
  force_regenerate?: boolean;
  /** Free-text 简报 (新格式优先；如缺则从 raw_input_data 拼). */
  requirement_brief?: string;
  raw_input_data?: {
    job_requisition_id?: string;
    client_job_id?: string;
    client_job_title?: string;
    client_job_type?: string;
    client_id?: string;
    client_department_id?: string;
    sd_org_name?: string;
    sd_owner_id?: string;
    hsm_employee_id?: string | null;
    city?: string;
    recruitment_type?: string;
    expected_level?: string;
    priority?: string;
    is_exclusive?: boolean;
    headcount?: number;
    salary_range?: string;
    deadline?: string;
    start_date?: string;
    first_interview_format?: string;
    first_interviewer_name?: string;
    final_interview_format?: string;
    final_interviewer_name?: string;
    job_responsibility?: string;
    job_requirement?: string;
    create_by?: string;
  };
};

type ClarificationReadyEnvelope = {
  entity_type?: string;
  entity_id?: string | null;
  event_id?: string;
  payload?: RaasRequirementPayload;
  trace?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
    parent_trace_id?: string | null;
  };
};

export const createJdAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Create JD Agent',
    // 3(此前 1):让"可恢复"退化名副其实。RoboHire 402/5xx/429/网络抖动经
    // reportDependencyDegraded 抛的是 RETRIABLE Error,只重试 1 次就终态 FAILED,和真
    // bug 无法区分。给瞬时厂商故障 3 次带退避的机会;真·终态(auth/empty/AO 侧
    // bad-request)走 NonRetriableError → 依旧 0 重试、立刻失败,不受影响。
    retries: 3,
    idempotency: 'event.data.event_id',
    concurrency: {
      key:
        'has(event.data.payload.job_requisition_id) ? ' +
        'event.data.payload.job_requisition_id : event.data.entity_id',
      limit: 1,
    },
    triggers: [{ event: 'CLARIFICATION_READY' }],
  },
  async ({ event, step, logger, runId }) => {
    const paused = await skipIfRaasV1Paused(AGENT_ID, logger);
    if (paused) return paused;

    if (!isPartnerPgConfigured()) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] RAAS_POSTGRES_URL env 未配置`,
      );
    }

    const envelope = (event.data ?? {}) as ClarificationReadyEnvelope;
    const traceId = getTraceId(event.data);
    const requisitionIdCandidate = pickRequisitionIdFromEnvelope(envelope);
    // ADR-0154 — 只认 payload 里的显式 true；缺省 / 非布尔一律按 false 走原保护闸。
    const forceRegenerate = envelope.payload?.force_regenerate === true;
    const fileLogger = createAgentLogger({
      agent: 'createJD',
      runId: runId ?? `local-${Date.now()}`,
      traceId: traceId ?? null,
      anchors: { job_requisition_id: requisitionIdCandidate ?? undefined },
    });
    return runWithLogger(fileLogger, async () => {
    fileLogger.event('handler.start', {
      event_name: event.name,
      job_requisition_id: requisitionIdCandidate,
    });

    // ── 1. 从事件取 entity_id (= job_requisition_id) ──
    // RAAS 闸门事件可只放 entity_id，agent 直读 Partner PG 拉详情。
    // entity_id 缺失时兼容旧 payload 形状
    // (payload.raw_input_data.job_requisition_id / payload.requirement_id)。
    const requisitionId = requisitionIdCandidate;
    if (!requisitionId) {
      fileLogger.event('handler.error', {
        reason: 'missing-entity-id',
        event_name: event.name,
      });
      throw new NonRetriableError(
        `[${AGENT_NAME}] ${event.name} 缺 entity_id / requisition_id —— 无法读取需求详情`,
      );
    }
    const sourceEventId = pickSourceEventId(envelope, event.id);
    if (!sourceEventId) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] ${event.name} 缺 event_id —— 无法建立 JD_GENERATED 幂等 outbox`,
      );
    }

    // ── 2. 直读 partner Postgres 拉完整需求详情 ──
    // 2026-05-20: 改成直连 Postgres,不再走 RAAS HTTP API。
    // partner-pg/requirements 返回 r + specification(JOIN'd row_to_json)。
    const detail = await step.run(`fetch-requirement-${sanitize(requisitionId)}`, async () => {
      const r = await getRequirementDetail(requisitionId);
      if (!r) {
        throw new NonRetriableError(
          `[${AGENT_NAME}] partner Postgres: job_requisition ${requisitionId} 不存在`,
        );
      }
      logger.info(
        `[${AGENT_NAME}] partner-pg getRequirementDetail OK · jrid=${requisitionId} ` +
          `title="${r.client_job_title ?? '?'}" ` +
          `client_id=${r.client_id ?? '—'} ` +
          `status=${r.specification?.status ?? '—'}`,
      );
      return r;
    });

    // 旧 RAAS API 返回 {requirement, specification},现在直读返回 requirement 整段
    // (含 specification 作为 nested object via row_to_json)。下面 buildPromptFromRequirement
    // 仍按旧 shape 拆解。
    const requirement = detail as unknown as RaasRequirement;
    const specification = (detail as { specification: RaasRequirementSpecification | null }).specification;
    const clientId = requirement.client_id ?? specification?.client_id;

    if (!clientId) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] requirement ${requisitionId} 缺 client_id — POST /jd/sync-generated 必填`,
      );
    }

    // ── 2c. 取已录入的需求澄清记录(拼进 prompt 用)──
    // 澄清是增强信息,非关键路径:取数失败只 warn + 回退空数组,不阻断 JD 生成。
    const clarifications = await step.run(
      `fetch-clarifications-${sanitize(requisitionId)}`,
      async () => {
        try {
          const rows = await getClarificationRecords(requisitionId);
          logger.info(
            `[${AGENT_NAME}] partner-pg clarification records: ${rows.length} · jrid=${requisitionId}`,
          );
          return rows;
        } catch (e) {
          logger.warn(
            `[${AGENT_NAME}] fetch clarification records failed (non-fatal): ${(e as Error).message}`,
          );
          return [] as RequirementClarificationRecord[];
        }
      },
    );

    // ── 2d. 公司上下文(best-effort)+ createJD 本体规则(fail-closed)──
    // clientContext: LEFT JOIN client 派生匿名描述 + 技术栈/福利(修 Benefits=TBD);
    //   缺列/宕机 → null,createJD 退化到今日行为。client 真名只用于 4-2 后校验,不进 Gohire。
    // createJdRules: GET /ontology/actions/createJD/rules?domain=RAAS-v1;Allmeta 宕机 → 空(fail-closed)。
    const clientContext = await step.run(
      `fetch-client-context-${sanitize(requisitionId)}`,
      () => getClientContext(clientId),
    );
    const createJdRules = await step.run(
      `fetch-createjd-rules-${sanitize(requisitionId)}`,
      () => fetchOntologyActionRules('createJD', RAAS_V1_ONTOLOGY_DOMAIN),
    );

    // ── 3. 从详情拼 prompt 给 RoboHire /generate-jd ──
    // 需求正文 + 公司背景块(行业/技术栈/福利)+ 生成约束块(本体 4-2/4-3/4-4)。
    // 分区预算:约束/背景块优先保留,需求正文按 4000 上限先截断(块永不被尾部截掉)。
    const requirementBody = buildPromptFromRequirement(requirement, specification, clarifications);
    const companyBlock = buildCompanyBackgroundBlock({
      descriptor: clientContext?.company_descriptor,
      technicalStackPreference: clientContext?.technical_stack_preference,
      welfarePolicy: clientContext?.welfare_policy,
    });
    const constraintsBlock = buildGenerationConstraintsBlock(createJdRules.rules);
    const appendedBlocks = [companyBlock, constraintsBlock].filter(Boolean).join('\n\n');
    const prompt = budgetPrompt(requirementBody, appendedBlocks, 4000);
    if (!prompt || prompt.length < 4) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] 拼不出有效 prompt — requirement ${requisitionId} 关键字段几乎全空`,
      );
    }
    logger.info(
      `[${AGENT_NAME}] prompt 组装 · company_block=${companyBlock ? 'y' : 'n'} ` +
        `constraints=${createJdRules.ruleCount} client_ctx=${clientContext ? 'y' : 'n'} ` +
        `len=${prompt.length}`,
    );

    logger.info(
      `[${AGENT_NAME}] received ${event.name} · requisition=${requisitionId} ` +
        `client_id=${clientId} prompt_len=${prompt.length}`,
    );

    // External-dependency-health context — fail the run (instead of false
    // success) when RoboHire is dead, and let the monitor alert.
    const depCtx = {
      agent: 'JDGenerator',
      runId: runId ?? null,
      traceId: traceId ?? null,
      domain: RECRUITMENT_DOMAIN_ID,
      anchors: {
        job_requisition_id: typeof requisitionId === 'string' ? requisitionId : undefined,
        client_id: typeof clientId === 'string' ? clientId : undefined,
      },
    };

    // ── 4. 调 RoboHire: POST /api/v1/jobs/generate-jd (direct, F4) ──
    const generated = await step.run(`generate-${sanitize(requisitionId)}`, async () => {
      let r: Awaited<ReturnType<typeof generateJdDirect>>;
      try {
        r = await generateJdDirect(
          {
            prompt,
            language: 'zh',
            // 规则 4-2:客户真名不进 Gohire(会被写进 JD 正文)。传匿名描述
            // (company_descriptor);无客户上下文则不传,交 RoboHire 自解析。
            // ⚠️ 不再传 client_name/sd_org_name —— 那会泄漏客户身份到 JD。
            companyName: clientContext?.company_descriptor,
            department: pickStringField(requirement, ['client_department_id', 'department']),
          },
          // 显式传 fileLogger → RoboHire generate-jd 完整 in/out 进 per-run 审计
          // (Inngest step.run 内 ALS 不可靠,必须显式传闭包 logger).
          { traceId, logger: fileLogger },
        );
      } catch (e) {
        // AO 自己发的 4xx(400/422 — prompt 太长/格式非法)是我们的 bug,不是 RoboHire
        // 健康问题:直接 NonRetriable 失败,不写 RoboHire dependency-degraded 信号
        // (否则监控会把我们的输入 bug 当成"RoboHire 退化:auth"误报到厂商健康上)。
        if (isAoSideBadRequest(e)) {
          logger.error(
            `[${AGENT_NAME}] generate-jd 拒绝了我们的请求(AO 侧入参问题)— 终态失败,不记 RoboHire 健康信号: ${(e as Error).message}`,
          );
          throw new NonRetriableError(`createJD bad request (AO-side): ${(e as Error).message}`);
        }
        const oc = classifyRobohire('generateJd', e);
        if (!oc.ok) await reportDependencyDegraded(oc, depCtx);
        throw e; // an error always classifies as degraded; this also fails the run
      }
      // Silent degrade: 200 OK but no usable JD content.
      const oc = classifyRobohire('generateJd', r);
      if (!oc.ok) await reportDependencyDegraded(oc, depCtx);
      logger.info(
        `[${AGENT_NAME}] RoboHire jobs/generate-jd OK · title="${r.data.title ?? '?'}" ` +
          `parse=${r.meta?.stages?.parse} generate=${r.meta?.stages?.generate} ` +
          `requestId=${r.requestId}`,
      );
      return r;
    });

    // Replay-safe fail-closed boundary: Inngest may return a memoized output for a
    // generate step completed by an older deployment without executing the callback
    // above. Re-check outside step.run so a historical partial-stage response can
    // never cross into the first write or JD_GENERATED emission after an upgrade.
    const generatedOutcome = classifyRobohire('generateJd', generated);
    if (!generatedOutcome.ok) {
      await reportDependencyDegraded(generatedOutcome, depCtx);
    }

    const jdData = generated.data;

    // generateJdDirect + classifyRobohire 已通过严格 stage 门禁；到这里可知
    // parse/generate 均严格等于 success。标题缺失时才回退需求侧岗位名。
    jdData.title = resolveJdTitle(
      jdData.title,
      pickStringField(requirement, ['client_job_title', 'sd_org_name']),
    );

    // ── 4a-bis. 规则 4-2 确定性后校验:清除 JD 正文里泄漏的客户真名 ──
    // Gohire 会把 companyName 写进 JD,且需求正文也可能带客户名。生成后、落库前做
    // 一次零-LLM 后校验:把 client 真名替换成匿名描述,记一条审计(非致命,不失败 run)。
    // clientContext 缺失(无 client 上下文)时整段跳过 = 今日行为。
    if (clientContext?.client_name) {
      const scrubFields = [
        'title', 'description', 'qualifications', 'hardRequirements',
        'niceToHave', 'benefits', 'interviewRequirements', 'evaluationRules',
      ] as const;
      const jdRecord = jdData as Record<string, unknown>;
      const complianceFixes: string[] = [];
      for (const field of scrubFields) {
        const value = jdRecord[field];
        if (typeof value === 'string' && value) {
          const r = verifyJdCompliance(value, {
            clientName: clientContext.client_name,
            companyDescriptor: clientContext.company_descriptor,
          });
          if (r.fixes.length) {
            jdRecord[field] = r.content;
            complianceFixes.push(...r.fixes.map((f) => `${field}: ${f}`));
          }
        }
      }
      if (complianceFixes.length) {
        fileLogger.event('jd.compliance-fix-4-2', {
          job_requisition_id: requisitionId,
          fields_fixed: complianceFixes.length,
          detail: complianceFixes,
        });
        logger.warn(
          `[${AGENT_NAME}] JD 4-2 合规后校验:清除客户真名 ${complianceFixes.length} 处字段`,
        );
      }
    }

    // ── 4b. 从 RoboHire 自由文本派生结构化技能数组 ──
    // RoboHire generate-jd 不返回 must_have_skills / nice_to_have_skills 数组,
    // 只给散文 hardRequirements / niceToHave。把它们拆成 List<String> 存进
    // Job_Requisition 的 must_have_skills / nice_to_have_skills(下游 matchResume /
    // ruleCheck 读的就是这两个数组)。
    const mustHaveSkills = resolveSkillArray(
      requirement.must_have_skills,
      proseToSkillArray(jdData.hardRequirements),
      { forceRegenerate },
    );
    const niceToHaveSkills = resolveSkillArray(
      requirement.nice_to_have_skills,
      proseToSkillArray(jdData.niceToHave),
      { forceRegenerate },
    );

    // 派生技能回填进 requirement,allmeta + partner-pg 两边写入都带上。
    const enrichedRequirement: Record<string, unknown> = {
      ...(requirement as unknown as Record<string, unknown>),
      must_have_skills: mustHaveSkills ?? requirement.must_have_skills ?? [],
      nice_to_have_skills: niceToHaveSkills ?? requirement.nice_to_have_skills ?? [],
    };

    // ── 4c. 镜像 JR 到 Neo4j (via allmeta) ──
    // 让 Rule Check Audit "实时读 Neo4j" 的 :Job_Requisition anchor 能查到.
    // partner 数据库是真相源,Neo4j 镜像 idempotent upsert.
    // (放在 RoboHire 之后:镜像才能带上派生的 must/nice_to_have_skills。)
    // 这是本流程第一个写操作；只有严格 stage 门禁和内容检查均通过后才可触达。
    await step.run(`write-jr-neo4j-${sanitize(requisitionId)}`, async () => {
      const r = await writeJobRequisitionInstance({ requirement: enrichedRequirement });
      if (r.ok) logger.info(`[${AGENT_NAME}] ✓ allmeta wrote Job_Requisition ${requisitionId}`);
      else logger.warn(`[${AGENT_NAME}] allmeta JR write failed: ${r.error}`);
      return r;
    });

    // ── 5. 写入 partner Postgres job_posting 表(state_mutations 主存储)──
    //
    // 实体数据(title / responsibility / requirement / key_words /
    // recruitment_type / work_years 等 Job_Posting impacted_properties)全部
    // 写进 partner Postgres,partner 订阅 JD_GENERATED 后从表里读。
    // JD_GENERATED outbox 与岗位在同一 Partner PG 事务提交；事务任一步失败
    // 都不会留下“岗位存在但审核事件永远丢失”的半成品。
    const jdContent = assembleJdContent(jdData);
    // v2 is intentional: old in-flight runs may have memoized the pre-outbox
    // sync-jd step. A new id forces one replay-safe execution that ensures the
    // durable outbox row exists before this run can finish.
    const syncResult = await step.run(`sync-jd-outbox-v2-${sanitize(requisitionId)}`, async () => {
      const input: SyncJdInput = {
        job_requisition_id: requisitionId,
        client_id: clientId,
        ...(jdData as Record<string, unknown>),
        must_have_skills: mustHaveSkills,
        nice_to_have_skills: niceToHaveSkills,
        negative_requirement: stringOrUndefined(requirement.negative_requirement),
        language_requirements: stringOrUndefined(requirement.language_requirements),
        expected_level: stringOrUndefined(requirement.expected_level),
        degree_requirement: stringOrUndefined(requirement.degree_requirement),
        education_requirement: stringOrUndefined(requirement.education_requirement),
        work_years:
          typeof requirement.work_years === 'number' ? requirement.work_years : undefined,
        interview_mode: stringOrUndefined(requirement.interview_mode),
        recruitment_type: stringOrUndefined(requirement.recruitment_type),
        city: pickCityFromBoth(requirement, jdData),
        force_regenerate: forceRegenerate,
        jd_generated_outbox: {
          source_event_id: sourceEventId,
          jd_content: jdContent,
          source_action: 'createJD',
          trace: envelope.trace ?? null,
        },
      };
      const r = await syncJdToPartnerPg(input);
      logger.info(
        `[${AGENT_NAME}] partner-pg syncJdToPartnerPg OK · synced=${r.synced} ` +
          `job_posting_id=${r.job_posting_id}` +
          (r.regenerated ? ' regenerated=true' : '') +
          (r.reason ? ` reason=${r.reason}` : ''),
      );
      return r;
    });

    const jobPostingId = syncResult.job_posting_id;
    if (syncResult.reason === 'skipped_protected_existing_posting') {
      // force_regenerate=true 时仍走到这里，只可能是岗位已 closed(ADR-0154 保留
      // 的唯一硬闸)——日志带上该标记，免得排查时误以为放行没生效。
      logger.info(
        `[${AGENT_NAME}] skipped protected existing JobPosting · ` +
          `job_posting_id=${jobPostingId} requisition=${requisitionId} ` +
          `force_regenerate=${forceRegenerate}`,
      );
      fileLogger.event('handler.skipped', {
        reason: syncResult.reason,
        job_posting_id: jobPostingId,
        job_requisition_id: requisitionId,
        force_regenerate: forceRegenerate,
      });
      return {
        ok: true,
        skipped: true,
        reason: syncResult.reason,
        job_posting_id: jobPostingId,
        requisition_id: requisitionId,
        client_id: clientId,
        force_regenerate: forceRegenerate,
      };
    }
    if (syncResult.reason === 'replayed_existing_outbox') {
      logger.info(
        `[${AGENT_NAME}] source event already has JD_GENERATED outbox · ` +
          `event_id=${syncResult.jd_generated_event_id ?? '?'} requisition=${requisitionId}`,
      );
      fileLogger.event('handler.replayed', {
        event_id: syncResult.jd_generated_event_id ?? null,
        job_posting_id: jobPostingId,
        job_requisition_id: requisitionId,
      });
      return {
        ok: true,
        replayed: true,
        reason: syncResult.reason,
        job_posting_id: jobPostingId,
        jd_generated_event_id: syncResult.jd_generated_event_id ?? null,
        requisition_id: requisitionId,
        client_id: clientId,
      };
    }
    if (!jobPostingId) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] partner-pg syncJdToPartnerPg 没返回 job_posting_id (reason=${syncResult.reason ?? '?'})`,
      );
    }
    const jdGeneratedEventId = syncResult.jd_generated_event_id;
    if (!jdGeneratedEventId) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] partner-pg 未返回 JD_GENERATED outbox event_id`,
      );
    }

    // ── 5b. 写 Neo4j Job_Posting instance via allmeta ──
    await step.run(`write-jobposting-neo4j-${sanitize(requisitionId)}`, async () => {
      const r = await writeJobPostingInstance({
        job_posting_id: jobPostingId,
        job_requisition_id: requisitionId,
        client_id: clientId,
        recruiter_employee_id: specification?.recruiter_employee_id ?? null,
        roboHireData: jdData as unknown as Record<string, unknown>,
        requirement: requirement as unknown as Record<string, unknown>,
        publish_status: 'pending',
      });
      if (r.ok) {
        logger.info(`[${AGENT_NAME}] ✓ allmeta wrote Job_Posting ${jobPostingId}`);
      } else {
        logger.warn(`[${AGENT_NAME}] allmeta Job_Posting write failed: ${r.error}`);
      }
      return r;
    });

    // ── 6. JD_GENERATED 已在 Step 5 进入 RAAS durable outbox ──
    // 只允许 RAAS OutboxDispatcher 发布，AO 不再作为第二个 publisher 直发，
    // 以免 dispatcher 竞跑造成双投；下游仍按 event_id 做防御性幂等。
    fileLogger.event('outbox.jd-generated', {
      event_id: jdGeneratedEventId,
      job_posting_id: jobPostingId,
      job_requisition_id: requisitionId,
      client_id: clientId,
    });
    await notifyRecruitmentLifecycle(step, 'JD_GENERATED', {
      anchors: { job_requisition_id: requisitionId, client_id: clientId },
      runId: runId ?? null,
      traceId,
    });

    logger.info(
      `[${AGENT_NAME}] ✅ enqueued JD_GENERATED · event_id=${jdGeneratedEventId} ` +
        `job_posting_id=${jobPostingId} requisition=${requisitionId}`,
    );
    fileLogger.event('handler.done', {
      job_posting_id: jobPostingId,
      jd_generated_event_id: jdGeneratedEventId,
      requisition_id: requisitionId,
      robohire_request_id: generated.requestId,
    });

    return {
      ok: true,
      job_posting_id: jobPostingId,
      jd_generated_event_id: jdGeneratedEventId,
      requisition_id: requisitionId,
      client_id: clientId,
      title: typeof jdData.title === 'string' ? jdData.title : null,
      robohire_request_id: generated.requestId,
    };
    }); // runWithLogger
  },
);

/**
 * 把 RoboHire generate-jd 输出拼成一段 markdown 作为 canonical `jd_content`。
 * 包含: 标题 + 描述正文 + 任职要求 + 加分项 + 面试要求 + 评估规则 + 福利。
 */
function assembleJdContent(jdData: RobohireGenerateJdData): string {
  const j = jdData as unknown as Record<string, unknown>;
  const parts: string[] = [];
  const title = typeof j.title === 'string' ? j.title : UNTITLED_JD;
  parts.push(`# ${title}`);
  if (typeof j.description === 'string' && j.description.trim()) {
    parts.push(j.description.trim());
  }
  if (typeof j.qualifications === 'string' && j.qualifications.trim()) {
    parts.push(`## 任职要求(详细)\n${j.qualifications.trim()}`);
  }
  if (typeof j.hardRequirements === 'string' && j.hardRequirements.trim()) {
    parts.push(`## 硬性要求\n${j.hardRequirements.trim()}`);
  }
  if (typeof j.niceToHave === 'string' && j.niceToHave.trim()) {
    parts.push(`## 加分项\n${j.niceToHave.trim()}`);
  }
  if (typeof j.interviewRequirements === 'string' && j.interviewRequirements.trim()) {
    parts.push(`## 面试要求\n${j.interviewRequirements.trim()}`);
  }
  if (typeof j.evaluationRules === 'string' && j.evaluationRules.trim()) {
    parts.push(`## 评估标准\n${j.evaluationRules.trim()}`);
  }
  if (typeof j.benefits === 'string' && j.benefits.trim()) {
    parts.push(`## 薪资福利\n${j.benefits.trim()}`);
  }
  return parts.join('\n\n');
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * 从 CLARIFICATION_READY envelope 取 job_requisition_id.
 *
 * 优先级:
 *   1. event.data.entity_id  ← Workflow A 标准位置 (RAAS canonical)
 *   2. payload.job_requisition_id
 *   3. payload.requirement_id / payload.raw_input_data.job_requisition_id
 *      ← 老 envelope 兼容
 */
function pickRequisitionIdFromEnvelope(
  envelope: ClarificationReadyEnvelope,
): string | null {
  if (typeof envelope.entity_id === 'string' && envelope.entity_id.trim()) {
    return envelope.entity_id.trim();
  }
  const payload = envelope.payload ?? (envelope as unknown as RaasRequirementPayload);
  const cands: Array<unknown> = [
    payload?.job_requisition_id,
    payload?.requirement_id,
    payload?.raw_input_data?.job_requisition_id,
  ];
  for (const c of cands) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

function pickSourceEventId(
  envelope: ClarificationReadyEnvelope,
  inngestEventId: unknown,
): string | null {
  for (const candidate of [envelope.event_id, inngestEventId]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}

/**
 * 从 GET /requirements/:id 返回的 requirement + specification 拼一段
 * RoboHire /api/v1/jobs/generate-jd 期望的 free-text prompt (4-4000 chars).
 *
 * 取舍原则:只拼「候选人该看到、且能改善 JD 正文」的字段。generate-jd 是纯文本
 * 进 / JD 文本出,响应里没有任何日期或技能数组字段,所以拼进去的东西唯一的去向
 * 就是候选人可见的 JD 正文。据此排除(2026-08-17):
 *   - 期望级别        客户自家级别区间,无通用映射,且可反推客户身份
 *   - 发布日期        纯元数据,易被误读成 deadline
 *   - 期望到岗日期    内部排期口径
 *   - 服务开始日期    HRO↔客户合同条款
 *   - 必备/加分技能   本 agent 自己派生并回写的字段,拼回去构成自反馈回路
 * 详见各处内联说明。
 */
export function buildPromptFromRequirement(
  requirement: RaasRequirement,
  specification: RaasRequirementSpecification | null,
  clarifications: RequirementClarificationRecord[] = [],
): string {
  const r = requirement as Record<string, any>;
  const s: Partial<RaasRequirementSpecification> = specification ?? {};
  const lines: string[] = [];

  const push = (label: string, value: unknown): void => {
    if (value == null) return;
    const v = typeof value === 'string' ? value.trim() : String(value);
    if (!v) return;
    lines.push(`${label}: ${v}`);
  };
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = r[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return undefined;
  };
  const formatDate = (value: unknown): string | null => {
    if (!value) return null;
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return null;
    // canonical schema 里这些是 Date(纯日历日),partner 以东八区零点序列化成 UTC
    // (…T16:00:00.000Z)。用 toISOString() 取 UTC 日会早一天,必须按北京时区取日历日。
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(d); // YYYY-MM-DD(北京)
  };
  const formatWorkAddress = (value: unknown): string | null => {
    if (!value) return null;
    if (typeof value === 'string') return value.trim() || null;
    if (Array.isArray(value)) {
      const parts = value.filter(Boolean).map(String).filter((p) => p.trim());
      return parts.length ? parts.join(' / ') : null;
    }
    if (typeof value === 'object') {
      const v = value as Record<string, unknown>;
      const parts = [v.city, v.district, v.address]
        .filter(Boolean)
        .map(String)
        .filter((p) => p.trim());
      return parts.length ? parts.join(' ') : null;
    }
    return null;
  };

  // ── 基础信息 ──
  push('岗位', r.client_job_title);
  push('岗位类型', r.client_job_type);
  push('所属部门', pick('first_level_department', 'oa_department', 'sd_org_name'));
  push('服务BG', r.service_bg);
  push('需求类型', r.demand_type);
  push('招聘类型', r.recruitment_type);
  // ❌ 期望级别(expected_level)不进 prompt:各客户的级别体系是自家原始区间
  //    (P7 / 2-2 / T3-2 / M2 …),没有跨客户的通用映射。塞给 Gohire 只会把客户
  //    内部职级黑话写进候选人可见 JD,而那套黑话本身就是可反推客户身份的强特征
  //    (规则 4-2 精神)。expected_level 仍照常回写 job_requisition 列(见 §5)。
  if (typeof r.headcount === 'number') push('招聘人数', String(r.headcount));
  // 一条需求可覆盖多个办公城市(RAAS `city_ids`)。这里必须把**全部**城市名拼进去 ——
  // generate-jd 只吃自由文本 prompt(没有结构化城市参数),所以 JD 正文里能不能出现
  // 多城市,完全取决于这一行。此前只 push 兼容主城市 `r.city`,多城市需求生成出来的
  // JD 永远只有一个城市。`city_names` 由 getRequirementDetail 读时解析(见 CITY_NAMES_SQL),
  // 解析不出来(存量 city_ids=NULL / 字典查不到)时回落主城市,绝不出现 UUID。
  push('工作城市', resolveCityNames(r).join(' / ') || r.city);
  push('工作地点', formatWorkAddress(r.work_address));
  push('薪资范围', r.salary_range);
  if (typeof r.work_years === 'number') push('工作年限', `${r.work_years} 年以上`);
  push('学历要求', r.degree_requirement);
  push('专业要求', r.education_requirement);
  push('语言要求', r.language_requirements);

  // ── 候选人偏好 ──
  const gender = r.gender;
  if (typeof gender === 'string' && gender.trim() && gender.trim() !== '不限') {
    push('性别要求', gender);
  }
  push('年龄要求', r.age_range);
  if (r.require_foreigner === true) push('接收外籍', '是');
  push('排班类型', r.work_schedule_type);

  // ── 面试 ──
  push('面试形式', r.interview_mode);
  const firstFmt = r.first_interview_format;
  const finalFmt = r.final_interview_format;
  if (
    (typeof firstFmt === 'string' && firstFmt.trim()) ||
    (typeof finalFmt === 'string' && finalFmt.trim())
  ) {
    push('初/复试形式', `${firstFmt ?? '—'} / ${finalFmt ?? '—'}`);
  }
  const firstInt = r.first_interviewer_name;
  const finalInt = r.final_interviewer_name;
  if (
    (typeof firstInt === 'string' && firstInt.trim()) ||
    (typeof finalInt === 'string' && finalInt.trim())
  ) {
    push('初/复试官', `${firstInt ?? '—'} / ${finalInt ?? '—'}`);
  }
  push('面试流程', r.interview_process);

  // ── 优先级 / 紧急度 / 难度 ──
  if (typeof s.priority === 'string') push('优先级', s.priority);
  push('紧急度', r.urgency_level);
  push('填充难度', r.fill_difficulty);

  // ── 日期一律不进 prompt ──
  // generate-jd 的响应 schema 里没有任何日期字段(RobohireGenerateJdData),日期
  // 从不被结构化回吐;塞进去唯一可能的后果就是被写进候选人可见的 JD 正文。而这
  // 三个日期没有一个是候选人该看的:
  //   · 发布日期(client_published_at / open_date)  纯需求元数据,且易被模型误读成 deadline
  //   · 期望到岗日期(required_arrival_date / s.deadline) 内部排期口径,仅供内部查看
  //   · 服务开始日期(s.start_date)                  HRO↔客户的合同服务起始日,商务条款
  // 三者仍在 job_requisition / specification 表里,内部视图照常读。
  if (s.is_exclusive) push('独家委托', '是');
  push('招聘策略', r.recruitment_strategies);

  // ── 排除条件 / 原始文本 ──
  // ❌ must_have_skills / nice_to_have_skills 不进 prompt —— 这是自反馈回路。
  //    客户需求侧从不录入这两个字段;job_requisition 上它们的唯一写入者就是本
  //    agent 自己(§4b 从 Gohire 的 hardRequirements/niceToHave 散文派生 → §5
  //    UPDATE job_requisition)。所以第 2 次跑(用户在需求详情页点「重新生成岗位」)
  //    读到的值 100% 是上一轮 Gohire 自己的输出,拼回 prompt 等于把模型的旧输出
  //    当成客户硬性要求喂回去,逐轮自我强化 / 漂移。
  //    客户真正录入的技能要求本来就在下面「岗位职责(原始)/任职要求(原始)」里,
  //    那才是权威输入。
  //    ⚠️ 若将来 upstream 支持客户直接录入这两个字段,不能简单地把这段加回来 ——
  //    必须先能区分「客户录入」与「Gohire 派生」两种来源,只拼前者。
  if (typeof r.negative_requirement === 'string' && r.negative_requirement.trim()) {
    lines.push(`\n排除条件: ${r.negative_requirement}`);
  }

  // ── 需求澄清记录(HSM 已与客户确认录入的澄清内容)──
  // 放在原始长文本之前,避免被尾部 4000 字截断;这是客户确认过的最权威补充。
  if (clarifications.length) {
    const items = clarifications.map((cr) => {
      const meta = [
        formatDate(cr.clarified_at),
        cr.clarification_type,
        cr.clarifier_name ?? cr.client_clarifier_name,
      ]
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .join(' · ');
      const content = cr.content.trim();
      return meta ? `  - [${meta}] ${content}` : `  - ${content}`;
    });
    lines.push(`\n需求澄清记录(已与客户确认,JD 须据此调整):\n${items.join('\n')}`);
  }

  if (typeof r.job_responsibility === 'string' && r.job_responsibility.trim()) {
    lines.push(`\n岗位职责(原始):\n${r.job_responsibility}`);
  }
  if (typeof r.job_requirement === 'string' && r.job_requirement.trim()) {
    lines.push(`\n任职要求(原始):\n${r.job_requirement}`);
  }

  // No length cap here — the caller applies `budgetPrompt` so the appended company /
  // constraint blocks are reserved and never truncated away by the 4000-char limit.
  return lines.join('\n');
}

function pickStringField(
  obj: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** Inngest step IDs 必须稳定且只含安全字符。 */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 80) || 'unknown';
}

/**
 * 需求的办公城市名数组(保序,首项 = 主城市)。
 *
 * `city_names` 由 getRequirementDetail 在 SQL 里 JOIN city_dict 读时解析(见
 * lib/partner-pg/requirements.ts `CITY_NAMES_SQL`),所以这里拿到的一定是城市**名**,
 * 不会是 `city_ids` 里的 UUID。存量行(city_ids=NULL)或字典全查不到时为空数组,
 * 由调用方各自回落兼容主城市 `city`。
 *
 * 参数刻意收成 Record —— prompt 构造那边拿到的是 `r`(已 as Record<string, any>),
 * 两个调用点共用同一份解析,避免口径分叉。
 */
export function resolveCityNames(requirement: Record<string, any>): string[] {
  const raw = requirement?.city_names;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const name = v.trim();
    // 去重但保序:同一城市被重复选进 city_ids 时不该在 JD 里出现两次。
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * city 取值优先级:
 *   1) requirement.city_names (raas 办公城市多选,权威多值) — 保序全量
 *   2) requirement.city (兼容主城市标量) — 存量行 city_ids=NULL 时的回落
 *   3) jdData.location (RoboHire 从 prompt 抽出来的)
 *   4) undefined
 *
 * 返回值此前恒为 1 元数组(直接 `[requirement.city]`),是「岗位 JD 只有一个城市」的
 * 降级点之一。现在多城市需求会返回多项;下游 syncJdToPartnerPg 仍只把首项写进
 * `job_posting.city` 单列(主城市),但 allmeta 的 Job_Posting.city 是 List<String>,
 * 从此装的是真多城市。
 */
export function pickCityFromBoth(
  requirement: RaasRequirement,
  jdData: RobohireGenerateJdData,
): string[] | undefined {
  const cityNames = resolveCityNames(requirement as unknown as Record<string, any>);
  if (cityNames.length > 0) return cityNames;
  const reqCity = stringOrUndefined(requirement.city);
  if (reqCity) return [reqCity];
  if (typeof jdData.location === 'string' && jdData.location.trim()) {
    return [jdData.location.trim()];
  }
  return undefined;
}

/**
 * RoboHire generate-jd 的 hardRequirements / niceToHave 是自由文本(编号或符号
 * 列表),Job_Requisition 的 must_have_skills / nice_to_have_skills 是 List<String>。
 * 按行拆,剥掉行首列表符号(- * • · / 1. / 1、 / 1)),trim 后丢弃空行。
 */
export function proseToSkillArray(s: unknown): string[] {
  if (typeof s !== 'string') return [];
  return s
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•·]|\d+\s*[.．、)）])\s*/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * 决定 must_have_skills / nice_to_have_skills 最终落库用哪份值。
 *
 * `job_requisition` 上这两列的唯一写入者就是本 agent(§4b 派生 → §5 UPDATE),
 * 客户需求侧从不录入。于是「已有值优先」在重新生成时会把**第一轮**的派生结果永久
 * 冻结:Gohire 基于新需求产出的新散文写进了 `hard_requirements` 列,数组却还是旧
 * 的 —— 同一次写入里两份数据自相矛盾,且用户点多少次「重新生成岗位」都改不掉。
 *
 * 所以按 force_regenerate(ADR-0154,用户在需求详情页显式勾选)分流:
 *   - 显式重新生成 → 新派生值优先,派生为空才回退旧值(宁可留旧值也不清空下游依赖)
 *   - 普通首轮/重放 → 保持既有语义:已有值优先,为空才用派生值
 * 后者留给「upstream 将来支持客户录入」的可能:那时首轮不会覆盖客户填的值。
 */
export function resolveSkillArray(
  existing: unknown,
  derived: string[],
  opts: { forceRegenerate?: boolean } = {},
): string[] | undefined {
  const existingArr = arrayOrUndefined(existing);
  const derivedArr = arrayOrUndefined(derived);
  return opts.forceRegenerate === true
    ? (derivedArr ?? existingArr)
    : (existingArr ?? derivedArr);
}

/** Keep RoboHire's non-blank title; otherwise use the requisition title. */
export function resolveJdTitle(
  rawTitle: unknown,
  fallbackTitle: string | undefined,
): string | undefined {
  return typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle : fallbackTitle;
}

/**
 * True when a thrown RoboHire error is an AO-side bad request (400/422) — our own
 * prompt/input is malformed. Such failures should fail the run terminally but must
 * NOT be recorded as a RoboHire dependency degradation (that would blame the vendor
 * for our bug). 401/403 (auth), 429, 5xx and network faults return false and keep
 * flowing through the normal dependency-health classifier + report path.
 */
export function isAoSideBadRequest(e: unknown): boolean {
  return e instanceof RobohireApiError && e.isBadRequest;
}

function arrayOrUndefined(v: unknown): string[] | undefined {
  if (Array.isArray(v) && v.length > 0) {
    return v.filter((x): x is string => typeof x === 'string' && x.length > 0);
  }
  return undefined;
}

function stringOrUndefined(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  return undefined;
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
