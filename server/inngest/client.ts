// Inngest client + event schemas for the merged AO monorepo.
//
// 历史:这个 client.ts 之前只在 AO main(端口 3002),resume-parser-agent
// (RPA,端口 3020)有自己的一份带完整 event 类型的 client.ts。p4 合并后,
// 两份 client 收敛成这一份 —— event 类型搬过来,但 inngest 实例的 id 仍然
// 保持 "agentic-operator-main"(不是 RPA 原来用的 "agentic-operator"),
// 避免破坏 Inngest dev server 上已注册的 app 槽位。
//
// Two modes via env:
//   - Shared gateway (RAAS联调): set INNGEST_BASE_URL + INNGEST_DEV to the
//     team-shared Inngest dev URL, e.g. http://10.100.0.70:8288. AO will
//     send events there AND must be registered as a serve endpoint there
//     (see scripts/register-with-inngest.ts).
//   - Local: INNGEST_DEV=1 (or unset and inngest-cli running on localhost)
//     for offline AO-only testing.
//
// No agent imports here — registry lives in server/inngest/functions.ts
// to avoid circular import (agents → client → agents).

import { Inngest } from "inngest";
import { WriteThroughMiddleware } from "./write-through-middleware";

// ─── §3.1 输入事件（来自 RAAS）──────────────────────────────
export type ResumeDownloadedData = {
  bucket: string;
  objectKey: string;
  filename: string;
  hrFolder: string | null;
  employeeId: string | null;
  etag: string | null;
  size: number | null;
  sourceEventName: string | null;
  receivedAt: string;
  /**
   * 上游 RAAS 在 RESUME_DOWNLOADED 上挂的 candidate-resume 上传 ID。
   * matchResume 需要把它原样回写到 MATCH_* 事件里供 RAAS 反查 candidate。
   * 本地测试发布时若缺失，可以用 etag 兜底（见 scripts/publish-test-event.ts）。
   */
  upload_id?: string;
};

// ─── §3.2 RAAS 期望的解析结果（4 对象嵌套）────────────────
export type CandidateNested = {
  name: string | null;
  mobile: string | null;
  email: string | null;
  gender: string | null;
  birth_date: string | null;
  current_location: string | null;
  highest_acquired_degree: string | null;
  work_years: number | null;
  current_company: string | null;
  current_title: string | null;
  skills: string[];
};

export type CandidateExpectationNested = {
  expected_salary_monthly_min: number | null;
  expected_salary_monthly_max: number | null;
  expected_cities: string[];
  expected_industries: string[];
  expected_roles: string[];
  expected_work_mode: string | null;
};

export type ResumeNested = {
  summary: string | null;
  skills_extracted: string[];
  work_history: Array<{
    title?: string;
    company?: string;
    startDate?: string;
    endDate?: string;
    description?: string;
  }> | null;
  education_history: Array<{
    degree?: string;
    field?: string;
    institution?: string;
    graduationYear?: string;
  }> | null;
  project_history: unknown[] | null;
};

export type RuntimeNested = {
  current_title: string | null;
  current_company: string | null;
};

export type ResumeProcessedData = {
  bucket: string;
  objectKey: string;
  filename: string;
  hrFolder: string | null;
  employeeId: string | null;
  etag: string | null;
  size: number | null;
  sourceEventName: string | null;
  receivedAt: string;
  candidate: CandidateNested | Record<string, never>;
  candidate_expectation: CandidateExpectationNested | Record<string, never>;
  resume: ResumeNested | Record<string, never>;
  runtime: RuntimeNested | Record<string, never>;
  parsedAt: string;
  parserVersion: string;
  // ── matchResume agent 用到的字段 ──
  upload_id?: string;
  employee_id?: string;
  parsed?: { data?: Record<string, unknown> };
  // ── Workflow A: 持久化产物 ──
  candidate_id?: string;
  resume_id?: string;
  // 上传时关联的岗位（raas 前端"上传简历"弹框里的"关联岗位"下拉）
  job_requisition_id?: string | null;
  // ADR-0040 — RAAS Nextcloud 路径预填的窄化客户需求 id 数组（单数 job_requisition_id
  // 为空时，ruleCheckAgent 直接循环这些 id 取详情撮合，跳过 path-B 名下全量扫描）。
  job_requisition_ids?: string[];
  // 来源渠道(RAAS 在 RESUME_DOWNLOADED 里给 → AO 透传 → 下游 / partner 重新订阅时仍可见)
  sourcing_channel_id?: string | null;
  // 客户(用于下游 matcher 的 client 维度过滤)
  client_id?: string | null;
};

// ─── §3.3 匹配输出事件 ─────────────────────────────────────
//
// F3 (2026-05-19): 三个 MATCH_* 事件 payload 统一契约。关键字段都在顶层,
// 缺失统一用 null(禁止空串)。Partner auto-invitation dispatcher 读顶层
// candidate_id / matching_score / upload_id 决定是否发邀约。
//
// 见 docs/superpowers/specs/2026-05-19-raas-integration-divergence-fixes-design.md §4

export type MatchEventData = {
  /** ★ 路径 A/B 收敛后的具体岗位 ID(必填) */
  job_requisition_id: string;
  /** ★ 候选人 ID;无显式 null */
  candidate_id: string | null;
  /** ★ 匹配分;取不到显式 null,不要省略字段 */
  matching_score: number | null;
  /** ★ upload_id;缺失统一 null,禁止空串 */
  upload_id: string | null;
  /** 关联 posting,有则带 */
  job_posting_id?: string | null;
  /** Partner Postgres candidate_match_result 主键。matchResumeAgent
   *  写完 partner-pg 后回填,partner 订阅 dispatcher 可以直接 update 同一行. */
  candidate_match_result_id?: string | null;
  /** Canonical MATCH_FAILED.event_data — "匹配" | "不匹配" — partner 直接判定. */
  overall_status?: '匹配' | '不匹配';

  // ── envelope 保留字段(RoboHire 风格,供 consumer cherry-pick)──
  success?: boolean;
  /** Two-axis semantics: `success` is kept for backwards compatibility;
   * these fields remove the ambiguity between execution and business result. */
  execution_success?: boolean;
  business_outcome?: 'passed' | 'rejected' | 'blocked';
  business_reason?: string | null;
  technical_warnings?: string[];
  /** 原始 RoboHire match 分析数据;FAIL 时塞 { rule_check_decision, failed_rules, audit }
   *  等结构化错误信息 */
  data?: Record<string, unknown>;
  requestId?: string;
  savedAs?: string;
  error?: string;
};

export type MatchPassedNeedInterviewData = MatchEventData;
export type MatchPassedNoInterviewData = MatchEventData;
export type MatchFailedData = MatchEventData;

// ─── §3.3.1 Interview invitation 事件(2026-05-25 新增) ────
//
// 链路:matchResumeAgent → MATCH_PASSED_NEED_INTERVIEW → RAAS 消费 → RAAS
// 经 HSM/审批后再发 INTERVIEW_INVITATION_REQUESTED → AO interviewInviterAgent
// 调 RoboHire POST /api/v1/invite-candidate → 写 Neo4j Interview_Record +
// Communication_Log → 回发 INTERVIEW_INVITATION_SENT(或 _FAILED)。
//
// Envelope-style payload(与其它 RAAS-emitted 事件一致):
//   { entity_type, entity_id, event_id, payload:{...}, trace }
//
// Payload 字段对齐 RoboHire `/invite-candidate` 入参 + AO Neo4j 写实例所需
// 的 anchors(candidate_id / job_requisition_id / application_id 等)。

export type InterviewInvitationRequestedPayload = {
  // ── anchors(必带,用于 Neo4j 写实例 + 回查 partner-pg)──
  candidate_id: string;
  job_requisition_id: string;
  /** RaaS-side Application PK; Neo4j Interview_Record.application_id 引用. */
  application_id?: string | null;
  /** AO matchResumeAgent 写的 CMR Neo4j 主键,便于 trace 串起来. */
  candidate_match_result_id?: string | null;
  client_id?: string | null;
  /** RaaS-side resume PK(用于 partner-pg 回查 parsed_content)。 */
  resume_id?: string | null;
  /**
   * RaaS-side 发起本次邀请的招聘者工号. 落 Communication_Log.message_sender
   * 与 Interview_Record.interviewer_employee_id. RaaS 实际发的字段名就是
   * recruiter_id(非 operator_id);别的事件(RESUME_DOWNLOADED / rule-check
   * 路径)走 operator_id 与此独立.
   */
  recruiter_id?: string | null;

  /** RaaS-side 跨服务关联 id(纯 trace/audit). */
  correlation_id?: string | null;
  /** RaaS-side job posting PK(派生于 job_requisition_id;纯 trace). */
  job_posting_id?: string | null;
  /** RaaS 端事件发起时间戳 ISO-8601(用于 SLA 监控). */
  requested_at?: string | null;
  /** 邀请触发来源:'manual_candidate_card' / 'hsm_auto' / 'bulk_invite' 等. */
  trigger_source?: string | null;

  // ── RoboHire 调用入参直透(参见 lib/robohire-client.ts inviteCandidateDirect)──
  /** 优先直接传 resume 文本;为空则按 candidate_id+resume_id 从 partner-pg 回查 parsed_content. */
  resume_text?: string;
  /** 优先直接传 jd 文本;为空则按 job_requisition_id 从 partner-pg 回查 + flatten. */
  jd_text?: string;
  /** 已在 RoboHire 侧建立的 resume 行 id(可替代 resume_text). */
  robohire_resume_id?: string;
  /** 已在 RoboHire 侧建立的 job 行 id(可替代 jd_text). */
  robohire_job_id?: string;
  hiring_request_id?: string;
  candidate_email?: string;
  recruiter_email?: string;
  interviewer_requirement?: string;
  job_title?: string;
  company_name?: string;
  interview_language?: 'en' | 'zh' | 'ja';
  /** 面试时长(分钟),> 0;default 30. */
  interview_duration?: number;
  /** 'ai_video' 等;RoboHire 仅落到 Interview.metadata.inviteConfig. */
  interview_mode?: string;
  passing_score?: number;
  linked_assessment_id?: string;

  /** runtime_context 透传(主要 traceId)。 */
  runtime_context?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
  };
};

export type InterviewInvitationRequestedData = {
  entity_type?: string;
  entity_id?: string | null;
  event_id?: string;
  payload: InterviewInvitationRequestedPayload;
  trace?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
    parent_trace_id?: string | null;
  };
};

/** AO → RAAS 邀请发出成功 — 含 RoboHire/GoHire 回执 + AO Neo4j PK,供 RAAS UI 串起 trace. */
export type InterviewInvitationSentPayload = {
  candidate_id: string;
  job_requisition_id: string;
  application_id?: string | null;
  candidate_match_result_id?: string | null;
  /**
   * RaaS-side 本次邀请的业务关联键, 来自 _REQUESTED payload.
   * RaaS 用它把 _SENT 事件 join 回 interview_invitation 表行.
   */
  correlation_id?: string | null;
  /** AO 新建的 Interview_Record Neo4j PK. */
  interview_record_id: string;
  /** AO 新建的 Communication_Log Neo4j PK. */
  communication_log_id: string;
  /** RoboHire response.data 直透关键字段(GoHire 给候选人的入口). */
  login_url: string | null;
  qrcode_url: string | null;
  user_id: string | number | null;
  request_introduction_id: string | null;
  gohire_job_id: string | number | null;
  candidate_email: string | null;
  interview_language: string | null;
  interview_duration_minutes: number | null;
  /** RoboHire requestId — 跨系统 trace 用. */
  robohire_request_id: string | null;
  execution_success?: true;
  business_outcome?: 'passed';
  technical_warnings?: string[];
  sent_at: string; // ISO
};

export type InterviewInvitationFailedPayload = {
  candidate_id: string;
  job_requisition_id: string;
  application_id?: string | null;
  execution_success?: false;
  business_outcome?: 'rejected' | 'blocked';
  /**
   * 失败原因分类:
   *   MISSING_PAYLOAD     — payload anchors 不全
   *   BACKFILL_FAILED     — partner-pg 回查 resume/JR 失败
   *   ROBOHIRE_4XX        — RoboHire 端 client error(配额/参数等)
   *   ROBOHIRE_QUOTA      — RoboHire 402 / 403 quota / subscription
   *   ROBOHIRE_5XX        — RoboHire server error(已重试到顶)
   *   GOHIRE_REJECTED     — RoboHire 200 但 GoHire 上游拒绝(code=gohire_invitation_failed)
   *   PERSISTENCE_WARNING — RoboHire 邀请送出但落库失败(persistenceWarning)
   *   UNKNOWN             — 兜底
   */
  error_code:
    | 'MISSING_PAYLOAD'
    | 'BACKFILL_FAILED'
    | 'ROBOHIRE_4XX'
    | 'ROBOHIRE_QUOTA'
    | 'ROBOHIRE_5XX'
    | 'GOHIRE_REJECTED'
    | 'PERSISTENCE_WARNING'
    | 'UNKNOWN';
  error_message: string;
  http_status?: number;
  robohire_request_id?: string | null;
  failed_at: string; // ISO
};

export type InterviewInvitationSentData = {
  entity_type?: string;
  entity_id?: string | null;
  event_id?: string;
  payload: InterviewInvitationSentPayload;
  trace?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
    parent_trace_id?: string | null;
  };
};

export type InterviewInvitationFailedData = {
  entity_type?: string;
  entity_id?: string | null;
  event_id?: string;
  payload: InterviewInvitationFailedPayload;
  trace?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
    parent_trace_id?: string | null;
  };
};

// ─── §3.5 Rule check 事件(workflow node 10-1) ───
//
// 2026-05-19 consolidation: ruleCheckAgent 直接订阅 `RESUME_PROCESSED`
// (吸收原 matchResume 第一段);事件名按 neo4j_data/actions_v0_1_002.json
// 10-1 对齐 — emit `MATCH_RULE_CHECK_PASSED` / `MATCH_RULE_CHECK_FAILED`。
//
// 见 docs/superpowers/specs/2026-05-19-rule-check-consolidation-design.md
export type RuleCheckAuditMeta = {
  rules_evaluated: number;
  graph_calls: number;
  client_id: string;
  business_group: string | null;
  studio: string | null;
  llm_model: string;
  llm_duration_ms: number;
  llm_round_trips: number;
  llm_prompt_tokens?: number;
  llm_completion_tokens?: number;
  rule_source: 'ontology-api' | 'json-fallback';
  fail_reason?: string;
};

/** ruleCheckAgent 在 handler 内构造 runRuleCheck input 时用到的运行时上下文。 */
export type RuleCheckRuntimeContext = {
  upload_id: string;
  candidate_id: string;
  resume_id: string;
  employee_id: string;
  filename?: string;
  received_at?: string;
  trace_id?: string | null;
};

/**
 * ruleCheckAgent → matchResumeAgent 过桥事件 + partner 订阅。
 *
 * Canonical schema (events_v0_1_002.json MATCH_RULE_CHECK_PASSED):
 *   source_action: "ruleCheckForMatchResume"
 *   event_data: [candidate_id, resume_id, job_requisition_id, client_id,
 *                rule_check_result, rule_check_reason]
 *   state_mutations: Candidate_Match_Result CREATE (rule_check_result, rule_check_reason)
 *
 * Plus partner conv 字段:upload_id / employee_id / audit / job_requisition /
 * parsed_resume / runtime_context — matchResumeAgent 第二段需要这些避免反查。
 */
export type MatchRuleCheckPassedData = {
  // ── canonical event_data(必带,partner 直接读)──
  candidate_id: string | null;
  resume_id: string | null;
  job_requisition_id: string;
  client_id: string;
  /** Canonical: '通过'(2026-05-26 起 PASS 路径只剩 '通过';pending/REVIEW 已折成 PASS) */
  rule_check_result: '通过';
  /** PASS 业务阻断原因恒为空；optional 参考结果通过 rule_check_rules 携带。 */
  rule_check_reason: string;

  // ── partner conv 字段(便利 + matchResumeAgent 用) ──
  upload_id: string | null;
  employee_id: string;
  audit: RuleCheckAuditMeta;
  /** 逐条规则判定结论(2026-06-12)— matchResume 把它追加进发给 RoboHire 的 jd
   *  文本做深度匹配(领导要求:rule check 结果进 jd;接口仍是 {resume, jd})。
   *  bypass 路径不带 → 匹配端不追加。 */
  rule_check_rules?: Array<{
    rule_id: string;
    rule_name: string;
    status: string;
    reason?: string;
    enforcement_level?: 'mandatory' | 'optional';
    failure_policy?: 'block' | 'warn';
    blocking?: boolean;
  }>;
  /** Full JR object — 第二段调 matchResumeDirect 时拼 jd text。 */
  job_requisition: Record<string, unknown>;
  /** Parsed resume(可能为 null,如果 RoboHire parse 之后没拿到)。 */
  parsed_resume: Record<string, unknown> | null;
  /**
   * 候选人求职期望(resumeParser 从简历文本抽出 → ruleCheck 透传)。matchResume
   * 第二段据此拼 candidatePreferences 发给 RoboHire /match-resume(接口支持的候选人
   * 偏好通道)。缺失或空对象 → 不传 candidatePreferences,匹配退回纯 {resume, jd}。
   */
  candidate_expectation?: CandidateExpectationNested | Record<string, never>;
  /**
   * RoboHire `/parse-resume` 抽出的 PDF 纯文本(`rawText`,落到 partner
   * `resume.parsed_content` 列)。matchResume 第二段用它作为
   * `/match-resume` 的 `resume` 参数,代替把 `parsed_resume` 整段 JSON
   * stringify。Null 时(RoboHire 没返回 rawText)matchResume 兜底回 JSON 模式。
   * 2026-05-21 partner contract change。
   */
  parsed_content: string | null;
  /** runtime_context 透传(主要 traceId)。 */
  runtime_context: RuleCheckRuntimeContext;
};

/**
 * ruleCheckAgent → partner(可选订阅)的失败事件。
 *
 * Canonical schema (events_v0_1_002.json MATCH_RULE_CHECK_FAILED):
 *   source_action: "ruleCheckForMatchResume"
 *   event_data: [candidate_id, resume_id, job_requisition_id, client_id,
 *                rule_check_result, rule_check_reason, failed_rules]
 *
 * canonical event_data 顶层平铺 + F3 兼容字段。partner dispatcher 看顶层
 * `rule_check_result` 直接路由(不用解构 data)。
 */
export type MatchRuleCheckFailedData = {
  // ── canonical event_data ──
  candidate_id: string | null;
  resume_id: string | null;
  job_requisition_id: string;
  client_id: string;
  rule_check_result: '未通过';
  rule_check_reason: string;
  /** Failed rule details(canonical event_data field): [{rule_id, rule_name, step_id?, severity?, reason?}, ...] */
  failed_rules: Array<{
    rule_id: string;
    rule_name: string;
    step_id?: string;
    severity?: string;
    reason?: string;
  }>;

  // ── F3 兼容字段(matching_score=null;upload_id 透传)──
  matching_score: null;
  upload_id: string | null;
  success: false;
  /** envelope 保留:RoboHire envelope fields 不适用 rule-check 阶段 */
  data?: Record<string, unknown>;
};

// ─── §3.4 JD 生成相关事件 ─────────────────────────────────
export type RequirementLoggedData = {
  entity_type?: string;
  entity_id?: string | null;
  event_id?: string;
  payload?: Record<string, unknown>;
  trace?: {
    trace_id?: string | null;
    request_id?: string | null;
    workflow_id?: string | null;
    parent_trace_id?: string | null;
  };
};

/**
 * JD_GENERATED canonical schema (neo4j_data/events_v0_1_002.json).
 *
 * Per ontology event registry (event_data 列出的 2 个字段必带):
 *   - job_posting_id (String, target_object=Job_Posting)
 *   - jd_content     (String, target_object=null)
 *
 * Per partner convention(对齐 REQUIREMENT_LOGGED 的 payload shape):
 *   payload 顶层还要平铺 FK 便利字段,让订阅者一查就到位:
 *   - job_requisition_id (FK→Job_Requisition,parent JR)
 *   - client_id          (FK→Client,routing context)
 *
 * State mutations(title/responsibility/requirement/key_words/type/
 * recruitment_type/work_years 等)由 partner-pg/job-posting.ts 直接写入
 * partner Postgres job_posting 表,partner 订阅后从表里读。NOT 携带在事件 payload 里。
 */
export type JdGeneratedPayload = {
  /** Partner Postgres job_posting.job_posting_id — entity_id 也用这个值. */
  job_posting_id: string;
  /** Parent Job_Requisition ID — partner 用这个 join JR 表拿 must_have_skills 等. */
  job_requisition_id: string;
  /** Client ID — partner 按客户路由通知 / HitlTask 用. */
  client_id: string | null;
  /** 整段 JD markdown(title/职责/要求/福利/评估等),partner 直接展示. */
  jd_content: string;
};

export type JdGeneratedEnvelope = {
  entity_type: "Job_Posting";
  entity_id: string;
  event_id: string;
  /** Per canonical schema events_v0_1_002.json. */
  source_action: "createJD";
  payload: JdGeneratedPayload;
  trace?: Record<string, unknown>;
};

// 事件 schema 在 inngest@4 已经不再走 EventSchemas/fromRecord(那是 v3 的
// 写法)。这里只导出 TypeScript 类型给 agent 文件 import,运行时不做强校验
// 由 agent 端做 unwrap+narrow(见 match-resume-agent.ts 里的 unwrap*Event)。

export const inngest = new Inngest({
  id: "agentic-operator-main",
  eventKey: process.env.INNGEST_EVENT_KEY,
  middleware: [WriteThroughMiddleware],
});

// 字段映射版本号 (RoboHire output → RAAS schema)
export const MAPPING_VERSION = "2026-04-28";
export const PARSER_VERSION = `robohire@v1+map@${MAPPING_VERSION}`;
