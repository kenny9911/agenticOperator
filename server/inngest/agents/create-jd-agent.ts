// createJD agent — Workflow node 4.
//
// Subscribes REQUIREMENT_LOGGED → 拼一段 prompt → 调 RAAS API
// /api/v1/generate-jd → 调 /api/v1/jd/sync-generated 持久化 → emit
// JD_GENERATED 事件供下游 cascade.
//
// Workflow A (per agentic-operator-onboarding(3).md, 2026-05-08;
//   F4 direct-RoboHire migration 2026-05-19):
//   ❌ 不再调 OpenAI/LLM gateway 直连 (lib/llm/jd-generator.ts 退役)
//   ❌ 不再自己组装 partner-canonical 15 字段 payload (RAAS 处理)
//   ❌ 不再走 RAAS /api/v1/generate-jd 透传 (PR-4 删除)
//   ✅ 调 robohire-client.generateJdDirect (直连 RoboHire /api/v1/jobs/generate-jd)
//   ✅ 调 raas-api-client.syncJdGenerated 持久化到 RAAS DB (写 JobPosting +
//       回填 JobRequisition + 推进 spec.status → pending_publish)
//
// Inbound:  REQUIREMENT_LOGGED { entity_type, payload: { raw_input_data: {...28} } }
// Outbound: JD_GENERATED       JD content + bookkeeping (cascade only)

import { randomUUID } from 'node:crypto';
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
import {
  reportDependencyDegraded,
  recordDependencySignal,
} from '@/lib/dependency-health/report';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';
import {
  writeJobPostingInstance,
  writeJobRequisitionInstance,
} from '@/lib/allmeta-writers';
import { inngest, type JdGeneratedEnvelope } from '@/server/inngest/client';
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
  source_channel?: string | null;
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

type RequirementLoggedEnvelope = {
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
    triggers: [
      { event: 'REQUIREMENT_LOGGED' },
      { event: 'CLARIFICATION_READY' },
      { event: 'JD_REJECTED' },
    ],
  },
  async ({ event, step, logger, runId }) => {
    const paused = await skipIfRaasV1Paused(AGENT_ID, logger);
    if (paused) return paused;

    if (!isPartnerPgConfigured()) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] RAAS_POSTGRES_URL env 未配置`,
      );
    }

    const envelope = (event.data ?? {}) as RequirementLoggedEnvelope;
    const traceId = getTraceId(event.data);
    const requisitionIdCandidate = pickRequisitionIdFromEnvelope(envelope);
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
    // 新流程: RAAS 在事件里只放 entity_id，agent 主动调
    // GET /api/v1/requirements/:id 拉详情。entity_id 缺失时兼容老格式
    // (payload.raw_input_data.job_requisition_id / payload.requirement_id)。
    const requisitionId = requisitionIdCandidate;
    if (!requisitionId) {
      fileLogger.event('handler.error', {
        reason: 'missing-entity-id',
        event_name: event.name,
      });
      throw new NonRetriableError(
        `[${AGENT_NAME}] ${event.name} 缺 entity_id / requisition_id —— 无法调 GET /requirements/:id`,
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

    const jdData = generated.data;
    const stages = generated.meta?.stages;

    // ── 4a. 处理 generate-jd 的非致命 stage 退化(Gohire 契约)──
    // 契约:parse/generate 两个 stage 非致命。parse 失败时 RoboHire 会把「原始
    // prompt」当 title 回传(整段 4000 字需求文本),直接拿来当 JD 标题不可用 —
    // generate 仍用原始 prompt 产出了正文。把 title 兜底回需求侧已知岗位名。
    jdData.title = resolveJdTitle(
      jdData.title,
      stages,
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

    // 到这里说明内容可用(空内容已在 generate step 里被 classifyRobohire →
    // reportDependencyDegraded 拦截失败)。若某个 stage 退化但我们抢救出了可用 JD,
    // 给监控发一条「非致命退化」信号(不失败 run — 契约说 stage 非致命)。
    const degradedStages = jdStageDegradation(stages);
    if (degradedStages) {
      await step.run(`record-jd-stage-degrade-${sanitize(requisitionId)}`, async () => {
        await recordDependencySignal(
          {
            ok: false,
            provider: 'robohire',
            op: 'generateJd',
            reason: 'server',
            detail: `generate-jd stage 退化(${degradedStages})但已从可用内容抢救出 JD — 未失败 run`,
          },
          depCtx,
        );
        return { degradedStages, salvaged: true };
      });
      logger.warn(
        `[${AGENT_NAME}] generate-jd stage 退化(${degradedStages})— 已抢救可用 JD 并入库,发退化信号(非致命)`,
      );
    }

    // ── 4b. 从 RoboHire 自由文本派生结构化技能数组 ──
    // RoboHire generate-jd 不返回 must_have_skills / nice_to_have_skills 数组,
    // 只给散文 hardRequirements / niceToHave。把它们拆成 List<String> 存进
    // Job_Requisition 的 must_have_skills / nice_to_have_skills(下游 matchResume /
    // ruleCheck 读的就是这两个数组)。已有结构化值优先(upstream 录入更权威),
    // 为空才用 RoboHire 派生。
    const mustHaveSkills =
      arrayOrUndefined(requirement.must_have_skills) ??
      arrayOrUndefined(proseToSkillArray(jdData.hardRequirements));
    const niceToHaveSkills =
      arrayOrUndefined(requirement.nice_to_have_skills) ??
      arrayOrUndefined(proseToSkillArray(jdData.niceToHave));

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
    // 事件本身只携带 2 个字段(canonical):job_posting_id + jd_content。
    const syncResult = await step.run(`sync-jd-${sanitize(requisitionId)}`, async () => {
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
      };
      const r = await syncJdToPartnerPg(input);
      logger.info(
        `[${AGENT_NAME}] partner-pg syncJdToPartnerPg OK · synced=${r.synced} ` +
          `job_posting_id=${r.job_posting_id}` +
          (r.reason ? ` reason=${r.reason}` : ''),
      );
      return r;
    });

    const jobPostingId = syncResult.job_posting_id;
    if (!jobPostingId) {
      throw new NonRetriableError(
        `[${AGENT_NAME}] partner-pg syncJdToPartnerPg 没返回 job_posting_id (reason=${syncResult.reason ?? '?'})`,
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

    // ── 6. emit JD_GENERATED (canonical schema — events_v0_1_002.json)──
    //
    // canonical event_data:job_posting_id + jd_content。
    // partner 便利 FK:job_requisition_id + client_id(对齐 REQUIREMENT_LOGGED
    // 把 FK 平铺在 payload 顶层的习惯,让订阅者一查就到位)。
    // 其他实体数据(title/responsibility/requirement/...)由 partner-pg 写入
    // partner Postgres job_posting 表;partner 订阅事件后从表里读。
    const outboundEnvelope: JdGeneratedEnvelope = {
      entity_type: 'Job_Posting',
      entity_id: jobPostingId,
      event_id: randomUUID(),
      source_action: 'createJD',
      payload: {
        job_posting_id: jobPostingId,
        job_requisition_id: requisitionId,
        client_id: clientId,
        jd_content: assembleJdContent(jdData),
      },
      trace: (envelope.trace as Record<string, unknown> | undefined) ?? {
        trace_id: null,
        request_id: null,
        workflow_id: null,
        parent_trace_id: null,
      },
    };

    fileLogger.event('emit.jd-generated', {
      job_posting_id: jobPostingId,
      job_requisition_id: requisitionId,
      client_id: clientId,
    });
    await step.sendEvent(`emit-jd-generated-${sanitize(requisitionId)}`, {
      name: 'JD_GENERATED',
      data: outboundEnvelope,
    });
    await notifyRecruitmentLifecycle(step, 'JD_GENERATED', {
      anchors: { job_requisition_id: requisitionId, client_id: clientId },
      runId: runId ?? null,
      traceId,
    });

    logger.info(
      `[${AGENT_NAME}] ✅ emitted JD_GENERATED · job_posting_id=${jobPostingId} requisition=${requisitionId}`,
    );
    fileLogger.event('handler.done', {
      job_posting_id: jobPostingId,
      requisition_id: requisitionId,
      robohire_request_id: generated.requestId,
    });

    return {
      ok: true,
      job_posting_id: jobPostingId,
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
 * 从 REQUIREMENT_LOGGED envelope 取 job_requisition_id.
 *
 * 优先级:
 *   1. event.data.entity_id  ← Workflow A 标准位置 (RAAS canonical)
 *   2. payload.requirement_id / payload.raw_input_data.job_requisition_id
 *      ← 老 envelope 兼容
 */
function pickRequisitionIdFromEnvelope(
  envelope: RequirementLoggedEnvelope,
): string | null {
  if (typeof envelope.entity_id === 'string' && envelope.entity_id.trim()) {
    return envelope.entity_id.trim();
  }
  const payload = envelope.payload ?? (envelope as unknown as RaasRequirementPayload);
  const cands: Array<unknown> = [
    payload?.requirement_id,
    payload?.raw_input_data?.job_requisition_id,
  ];
  for (const c of cands) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return null;
}

/**
 * 从 GET /requirements/:id 返回的 requirement + specification 拼一段
 * RoboHire /api/v1/jobs/generate-jd 期望的 free-text prompt (4-4000 chars).
 *
 * F4 spec (2026-05-19): 40+ 字段，重要日期语义校正:
 *   - s.deadline 之前误标 "截止日期" → 应作为 "期望到岗日期" 的 fallback
 *     (primary: r.required_arrival_date)
 *   - s.start_date 之前误标 "期望到岗" → 应作为 "服务开始日期" (HRO contract)
 *   - 新增 "发布日期" = pick(r.client_published_at, r.open_date)
 */
function buildPromptFromRequirement(
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
  push('期望级别', r.expected_level);
  if (typeof r.headcount === 'number') push('招聘人数', String(r.headcount));
  push('工作城市', r.city);
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

  // ── 三个日期(F4 关键校正点)──
  push(
    '发布日期',
    formatDate(r.client_published_at) ?? formatDate(r.open_date),
  );
  push(
    '期望到岗日期',
    formatDate(r.required_arrival_date) ?? formatDate((s as any).deadline),
  );
  push('服务开始日期', formatDate((s as any).start_date));

  if (s.is_exclusive) push('独家委托', '是');
  push('招聘策略', r.recruitment_strategies);

  // ── 技能 / 排除 / 原始文本 ──
  if (Array.isArray(r.must_have_skills) && r.must_have_skills.length) {
    lines.push(`\n必备技能:\n  - ${(r.must_have_skills as string[]).join('\n  - ')}`);
  }
  if (Array.isArray(r.nice_to_have_skills) && r.nice_to_have_skills.length) {
    lines.push(`\n加分技能:\n  - ${(r.nice_to_have_skills as string[]).join('\n  - ')}`);
  }
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
 * city 取值优先级:
 *   1) requirement.city (raas 已知字段，最权威) — 字符串转 array
 *   2) jdData.location (RoboHire 从 prompt 抽出来的)
 *   3) undefined
 */
function pickCityFromBoth(
  requirement: RaasRequirement,
  jdData: RobohireGenerateJdData,
): string[] | undefined {
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
 * Gohire generate-jd contract: when the PARSE stage fails, the response comes back
 * with `title` set to the raw prompt (the whole ~4000-char requirement blob) —
 * unusable as a JD heading — while the GENERATE stage still produced real body
 * content. Fall back to the requisition's known job title in that case. When parse
 * succeeded (or there's no stage info), keep RoboHire's parsed title; if RoboHire
 * gave us nothing usable, fall back regardless.
 */
export function resolveJdTitle(
  rawTitle: unknown,
  stages: { parse?: string; generate?: string } | undefined,
  fallbackTitle: string | undefined,
): string | undefined {
  // Parse stage failed → RoboHire echoes the raw prompt (a ~4000-char requirement
  // blob) as `title`, which is unusable as a heading. NEVER keep it: use the
  // requisition's known job title, else the same placeholder assembleJdContent
  // falls back to (未命名岗位) — never the blob.
  if (stages?.parse === 'failed') return fallbackTitle ?? UNTITLED_JD;
  return typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle : fallbackTitle;
}

/**
 * Which generate-jd stages degraded, as a comma-joined string ('parse',
 * 'generate', or 'parse,generate') — or null when no stage failed / no stage info.
 * Used to emit a NON-fatal dependency-health signal when we salvage a usable-but-
 * degraded JD, so the monitor still sees the vendor degradation even though the run
 * succeeds. Stage status is a health signal here, never a run-failing gate.
 */
export function jdStageDegradation(
  stages: { parse?: string; generate?: string } | undefined,
): string | null {
  if (!stages) return null;
  const failed: string[] = [];
  if (stages.parse === 'failed') failed.push('parse');
  if (stages.generate === 'failed') failed.push('generate');
  return failed.length ? failed.join(',') : null;
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
