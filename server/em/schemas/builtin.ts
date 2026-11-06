// Hardcoded fallback schemas for the 8 core events.
//
// Source-of-truth contract: when EventDefinition table has a row from Neo4j,
// the registry uses that row. When it doesn't (cold start / off-VPN / event
// not in Neo4j), we fall through to these. They're intentionally permissive
// (most fields optional) — RAAS payloads vary; tightening happens later
// once we have real fixtures.

import { z } from "zod";
import type { EventSchemaRegistration } from "./types";

// ── Common envelope sub-schemas ───────────────────────────────────────────

const TraceSchema = z
  .object({
    trace_id: z.string().nullable().optional(),
    request_id: z.string().nullable().optional(),
    workflow_id: z.string().nullable().optional(),
    parent_trace_id: z.string().nullable().optional(),
  })
  .partial()
  .optional();

// Most RAAS events are wrapped in an envelope:
//   { entity_type, entity_id?, event_id, payload: {...}, trace? }
// Permissive base — individual events tighten the payload.
function envelope(payload: z.ZodType) {
  return z.object({
    entity_type: z.string().optional(),
    entity_id: z.union([z.string(), z.null()]).optional(),
    event_id: z.string().optional(),
    payload,
    trace: TraceSchema,
  });
}

// ── Event schemas ─────────────────────────────────────────────────────────

const REQUIREMENT_LOGGED_v1 = envelope(
  z.object({
    requirement_id: z.string(),
    client_id: z.string().optional(),
    job_requisition_id: z.string().optional(),
    title: z.string().optional(),
  }).passthrough(),
);

const RESUME_DOWNLOADED_v1 = envelope(
  z.object({
    upload_id: z.string().min(1),
    bucket: z.string().min(1),
    object_key: z.string().min(1),
    filename: z.string().nullable().optional(),
    etag: z.string().nullable().optional(),
    size: z.number().nullable().optional(),
    employee_id: z.string().nullable().optional(),
    job_requisition_id: z.string().nullable().optional(),
    // ADR-0040 — RAAS Nextcloud 路径预填的窄化客户需求 id 数组(可空/缺省)。
    job_requisition_ids: z.array(z.string()).optional(),
    // Browser-extension upload contract. RAAS only sends non-empty fields;
    // keep it explicit here even though passthrough already accepts it.
    expectation_payload: z
      .object({
        expected_position: z.string().optional(),
        expected_location: z.string().optional(),
        expected_salary_range: z.string().optional(),
        outsourcing_acceptance_level: z.string().optional(),
        expected_industry: z.string().optional(),
        expected_company_size: z.string().optional(),
        constraints: z.array(z.string()).optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    received_at: z.string().optional(),
  }).passthrough(),
);

// 2026-05-24: upload_id 由必填改可选 — RaaS Web Console "更换关联岗位" / "匹配
// 同序列岗位" 两个功能不带 upload_id,只发 candidate_id + resume_id +
// job_requisition_id 的 thin event,由 ruleCheckAgent back-pull partner-pg 补齐
// parsed。ruleCheckAgent 第 94-96 行本就接受 upload_id 缺失;此处修 schema 与
// agent 契约不一致。candidate_id / resume_id 显式 .optional() 仅为可读性,
// .passthrough() 本就放行。
// 见 docs/raas/2026-05-22-ao-raas-event-architecture.md §7
const RESUME_PROCESSED_v1 = envelope(
  z.object({
    upload_id: z.string().min(1).optional(),
    candidate_id: z.string().optional(),
    resume_id: z.string().optional(),
    parsed: z
      .object({
        data: z.record(z.string(), z.unknown()),
      })
      .optional(),
    job_requisition_id: z.string().optional(),
  }).passthrough(),
);

const JD_GENERATED_v1 = envelope(
  z.object({
    requirement_id: z.string().optional(),
    job_requisition_id: z.string().optional(),
    jd_id: z.string().optional(),
    title: z.string().optional(),
    summary: z.string().optional(),
  }).passthrough(),
);

// MATCH_PASSED_NEED_INTERVIEW / MATCH_PASSED_NO_INTERVIEW / MATCH_FAILED
// share the same shape — F3 (2026-05-19): top-level candidate_id / matching_score /
// upload_id with explicit nulls. Partner auto-invitation dispatcher reads these
// from top level.
const MATCH_PAYLOAD_v1 = z
  .object({
    job_requisition_id: z.string(),
    candidate_id: z.string().nullable(),
    matching_score: z.number().nullable(),
    upload_id: z.string().nullable(),
    job_posting_id: z.string().nullable().optional(),
    jd_id: z.string().optional(),
  })
  .passthrough();

const MATCH_PASSED_NEED_INTERVIEW_v1 = envelope(MATCH_PAYLOAD_v1);
const MATCH_PASSED_NO_INTERVIEW_v1 = envelope(MATCH_PAYLOAD_v1);
const MATCH_FAILED_v1 = envelope(MATCH_PAYLOAD_v1);

const RULE_CHECK_RULE_LINE_v1 = z.object({
  rule_id: z.string(),
  rule_name: z.string(),
  status: z.string(),
  reason: z.string().optional(),
}).passthrough();

// MATCH_RULE_CHECK_PASSED — ruleCheckAgent → matchResumeAgent 过桥事件。
// 不是最终 MATCH_* 评分事件,所以不要求 matching_score;同时携带逐条
// rule_check_rules,matchResumeAgent 会把它追加进发给 RoboHire 的 jd 文本。
const MATCH_RULE_CHECK_PASSED_v1 = envelope(
  z.object({
    job_requisition_id: z.string(),
    candidate_id: z.string().nullable(),
    resume_id: z.string().nullable().optional(),
    client_id: z.string().optional(),
    rule_check_result: z.literal('通过'),
    rule_check_reason: z.string().optional(),
    upload_id: z.string().nullable().optional(),
    employee_id: z.string().optional(),
    audit: z.record(z.string(), z.unknown()).optional(),
    rule_check_rules: z.array(RULE_CHECK_RULE_LINE_v1).optional(),
    job_requisition: z.record(z.string(), z.unknown()).optional(),
    parsed_resume: z.record(z.string(), z.unknown()).nullable().optional(),
    parsed_content: z.string().nullable().optional(),
    runtime_context: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
);

// MATCH_RULE_CHECK_FAILED — ruleCheckAgent rule-check 失败时 emit;
// matching_score 在 rule-check 阶段固定为 null;data 里塞 failed_rules / decision。
const MATCH_RULE_CHECK_FAILED_v1 = envelope(MATCH_PAYLOAD_v1);

// JD_REJECTED — when JD generation hits a business reject (unclear req etc.)
const JD_REJECTED_v1 = envelope(
  z.object({
    requirement_id: z.string().optional(),
    reason: z.string(),
  }).passthrough(),
);

// ── Interview invitation 事件(2026-05-25 新增) ─────────────────────────
//
// RAAS 消费 MATCH_PASSED_NEED_INTERVIEW 后,经 HSM/审批决定发邀请,发
// INTERVIEW_INVITATION_REQUESTED 给 AO;AO interviewInviterAgent 调
// RoboHire /api/v1/invite-candidate,回发 _SENT 或 _FAILED。
//
// 详见 server/inngest/client.ts InterviewInvitationRequestedPayload。

const INTERVIEW_INVITATION_REQUESTED_v1 = envelope(
  z.object({
    candidate_id: z.string().min(1),
    job_requisition_id: z.string().min(1),
    application_id: z.string().nullable().optional(),
    candidate_match_result_id: z.string().nullable().optional(),
    client_id: z.string().nullable().optional(),
    resume_id: z.string().nullable().optional(),
    // RaaS 实际发的字段名是 recruiter_id(非 operator_id)— 这是发起本次邀请的
    // 招聘者工号,落 Communication_Log.message_sender + Interview_Record.interviewer_employee_id.
    recruiter_id: z.string().nullable().optional(),

    // RaaS 透传字段(纯 trace/audit;agent 仅落日志,不影响 RoboHire 调用)
    correlation_id: z.string().nullable().optional(),
    job_posting_id: z.string().nullable().optional(),
    requested_at: z.string().nullable().optional(),
    trigger_source: z.string().nullable().optional(),

    // RoboHire 入参直透 — 全可选,缺失时 agent 端按 anchors 回查 partner-pg
    resume_text: z.string().optional(),
    jd_text: z.string().optional(),
    robohire_resume_id: z.string().optional(),
    robohire_job_id: z.string().optional(),
    hiring_request_id: z.string().optional(),
    candidate_email: z.string().optional(),
    recruiter_email: z.string().optional(),
    interviewer_requirement: z.string().optional(),
    job_title: z.string().optional(),
    company_name: z.string().optional(),
    interview_language: z.enum(['en', 'zh', 'ja']).optional(),
    interview_duration: z.number().positive().optional(),
    interview_mode: z.string().optional(),
    passing_score: z.number().min(0).max(100).optional(),
    // RaaS 在未绑 assessment 时显式发 null;之前 z.string().optional() 会拒收 null,
    // 导致 em.publish 422 全量丢弃事件。
    linked_assessment_id: z.string().nullable().optional(),

    runtime_context: z.record(z.string(), z.unknown()).optional(),
  }).passthrough(),
);

const INTERVIEW_INVITATION_SENT_v1 = envelope(
  z.object({
    candidate_id: z.string().min(1),
    job_requisition_id: z.string().min(1),
    application_id: z.string().nullable().optional(),
    candidate_match_result_id: z.string().nullable().optional(),
    // RaaS-side 业务关联键(原样回带), RaaS 端用它 join interview_invitation 表行.
    correlation_id: z.string().nullable().optional(),
    interview_record_id: z.string().min(1),
    communication_log_id: z.string().min(1),
    login_url: z.string().nullable(),
    qrcode_url: z.string().nullable(),
    user_id: z.union([z.string(), z.number(), z.null()]),
    request_introduction_id: z.string().nullable(),
    gohire_job_id: z.union([z.string(), z.number(), z.null()]),
    candidate_email: z.string().nullable(),
    interview_language: z.string().nullable(),
    interview_duration_minutes: z.number().nullable(),
    robohire_request_id: z.string().nullable(),
    sent_at: z.string(),
  }).passthrough(),
);

const INTERVIEW_INVITATION_FAILED_v1 = envelope(
  z.object({
    candidate_id: z.string().min(1),
    job_requisition_id: z.string().min(1),
    application_id: z.string().nullable().optional(),
    error_code: z.enum([
      'MISSING_PAYLOAD',
      'BACKFILL_FAILED',
      'ROBOHIRE_4XX',
      'ROBOHIRE_QUOTA',
      'ROBOHIRE_5XX',
      'GOHIRE_REJECTED',
      'PERSISTENCE_WARNING',
      'UNKNOWN',
    ]),
    error_message: z.string(),
    http_status: z.number().optional(),
    robohire_request_id: z.string().nullable().optional(),
    failed_at: z.string(),
  }).passthrough(),
);

// ── Registrations ─────────────────────────────────────────────────────────

// 2026-06-08 — 候选人锁定冲突 (RMHR uploadByRecruiterEmail 返回他人锁定/保护/黑名单)。
// resumeParserAgent 在 lock-only 时发,中止该上传者的下游匹配,路由到 HSM·仲裁台。
const RESUME_LOCKED_CONFLICT_v1 = envelope(
  z.object({
    upload_id: z.string().optional(),
    candidate_id: z.string().optional(),
    resume_id: z.string().optional(),
    current_owner_employee_id: z.string().nullable().optional(),
    current_owner_email: z.string().nullable().optional(),
    lock_state: z.number().nullable().optional(),
    lock_time: z.string().nullable().optional(),
    reason: z.string().optional(),
  }).passthrough(),
);

export const BUILTIN_SCHEMAS: EventSchemaRegistration[] = [
  {
    name: "REQUIREMENT_LOGGED",
    description: "客户提交了一条招聘需求；触发 JD 生成",
    versions: [{ version: "1.0", schema: REQUIREMENT_LOGGED_v1 }],
    publishers: ["raas-dashboard", "raas-bridge"],
    subscribers: ["createJdAgent"],
  },
  {
    name: "RESUME_DOWNLOADED",
    description: "MinIO 收到一份新简历；触发解析",
    versions: [{ version: "1.0", schema: RESUME_DOWNLOADED_v1 }],
    publishers: ["raas-bridge"],
    subscribers: ["resumeParserAgent"],
  },
  {
    name: "RESUME_PROCESSED",
    description: "简历解析与候选人期望持久化完成;ruleCheckAgent 据此触发 10-1",
    versions: [{ version: "1.0", schema: RESUME_PROCESSED_v1 }],
    publishers: ["rpa.resumeParserAgent", "raas.reassign-republisher"],
    subscribers: [
      "ao.ruleCheckAgent",
      "raas-backend.resume-processed-ingest",
    ],
  },
  {
    name: "RESUME_LOCKED_CONFLICT",
    description: "上传时检测到候选人已被他人锁定/保护/黑名单(公司 RMHR);lock-only,中止下游匹配",
    versions: [{ version: "1.0", schema: RESUME_LOCKED_CONFLICT_v1 }],
    publishers: ["ao.resumeParserAgent"],
    subscribers: ["hsm.lock-arbitrate"],
  },
  {
    name: "MATCH_RULE_CHECK_PASSED",
    description: "ruleCheckAgent 通过规则检查;matchResumeAgent 据此调 RoboHire match",
    versions: [{ version: "1.0", schema: MATCH_RULE_CHECK_PASSED_v1 }],
    publishers: ["ao.ruleCheckAgent"],
    subscribers: ["ao.matchResumeAgent"],
  },
  {
    // ruleCheckAgent rule-check 失败时发(区别于 matchResumeAgent 自身的
    // 低分 MATCH_FAILED).  Team review 2026-05-20: revert Plan B 统一 — 保留独立事件,
    // 让审计 / partner dispatcher 能 route 不同的失败语义。
    name: "MATCH_RULE_CHECK_FAILED",
    description: "rule-check FAIL/REVIEW;matching_score 固定 null,data 含 failed_rules + decision",
    versions: [{ version: "1.0", schema: MATCH_RULE_CHECK_FAILED_v1 }],
    publishers: ["ao.ruleCheckAgent"],
    subscribers: [],
  },
  {
    name: "JD_GENERATED",
    description: "createJdAgent 输出的 JD",
    versions: [{ version: "1.0", schema: JD_GENERATED_v1 }],
    publishers: ["createJdAgent"],
    subscribers: ["raas-backend.jd-generated-sync"],
  },
  {
    name: "JD_REJECTED",
    description: "JD 生成被业务拒绝（需澄清等）",
    versions: [{ version: "1.0", schema: JD_REJECTED_v1 }],
    publishers: ["createJdAgent"],
    subscribers: ["raas-backend"],
  },
  {
    name: "MATCH_PASSED_NEED_INTERVIEW",
    description: "候选人 × JD 匹配通过，需面试",
    versions: [{ version: "1.0", schema: MATCH_PASSED_NEED_INTERVIEW_v1 }],
    publishers: ["rpa.matchResumeAgent"],
    subscribers: ["raas-backend.match-result-ingest-need-interview"],
  },
  {
    name: "MATCH_PASSED_NO_INTERVIEW",
    description: "候选人 × JD 匹配通过，免面试",
    versions: [{ version: "1.0", schema: MATCH_PASSED_NO_INTERVIEW_v1 }],
    publishers: ["rpa.matchResumeAgent"],
    subscribers: ["raas-backend.match-result-ingest-no-interview"],
  },
  {
    name: "MATCH_FAILED",
    description: "matchResumeAgent 低分淘汰(score < 50 / null);rule-check 失败请订阅 MATCH_RULE_CHECK_FAILED",
    versions: [{ version: "1.0", schema: MATCH_FAILED_v1 }],
    publishers: ["rpa.matchResumeAgent"],
    subscribers: ["raas-backend.match-result-ingest-failed"],
  },
  {
    name: "INTERVIEW_INVITATION_REQUESTED",
    description:
      "RAAS HSM/审批通过后请求 AO 发面试邀请;AO interviewInviterAgent 调 RoboHire /invite-candidate",
    versions: [{ version: "1.0", schema: INTERVIEW_INVITATION_REQUESTED_v1 }],
    publishers: ["raas-backend.interview-dispatcher"],
    subscribers: ["ao.interviewInviterAgent"],
  },
  {
    name: "INTERVIEW_INVITATION_SENT",
    description:
      "AO 已通过 RoboHire 把邀请送达候选人;payload 含 login_url/qrcode_url + interview_record_id",
    versions: [{ version: "1.0", schema: INTERVIEW_INVITATION_SENT_v1 }],
    publishers: ["ao.interviewInviterAgent"],
    subscribers: ["raas-backend.interview-invitation-sync"],
  },
  {
    name: "INTERVIEW_INVITATION_FAILED",
    description:
      "AO 发邀请失败;error_code 区分 RoboHire/GoHire/缺字段;RAAS 端据此决定重试或人工介入",
    versions: [{ version: "1.0", schema: INTERVIEW_INVITATION_FAILED_v1 }],
    publishers: ["ao.interviewInviterAgent"],
    subscribers: ["raas-backend.interview-invitation-sync"],
  },
];

export const BUILTIN_SCHEMAS_BY_NAME = new Map(
  BUILTIN_SCHEMAS.map((r) => [r.name, r] as const),
);
