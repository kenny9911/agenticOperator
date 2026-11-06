// interviewInviter agent — Workflow node 11(2026-05-25 新增).
//
// 链路位置:
//   matchResumeAgent → MATCH_PASSED_NEED_INTERVIEW
//        ↓ RAAS 消费 + HSM/审批
//   RAAS emit INTERVIEW_INVITATION_REQUESTED
//        ↓ 本 agent 订阅
//   1. (可选) backfill resume_text / jd_text — RAAS 端如发 thin event 则
//      AO 按 candidate_id+resume_id / job_requisition_id 回查 partner-pg
//   2. 调 RoboHire POST /api/v1/invite-candidate(Bearer)
//   3. 成功 — allmeta 写 Interview_Record(skeleton) + Communication_Log
//      失败 — 落 Communication_Log 标 'failed';不写 Interview_Record(避免脏数据)
//   4. emit INTERVIEW_INVITATION_SENT(success path)/
//      emit INTERVIEW_INVITATION_FAILED(已分类错误码,RaaS 据此重试或人工介入)
//
// 与 matchResumeAgent / ruleCheckAgent 风格一致:
//   - file logger 落 anchored line(candidate_id / jr / application_id);
//   - step.run 包所有外部调用,RoboHire 4xx 走 fail-then-emit,不抛(避免 Inngest 重试);
//   - 5xx / NETWORK 抛错走 Inngest 重试(retries: 2)。

import { NonRetriableError } from 'inngest';
import {
  writeCommunicationLogInstance,
  writeInterviewRecordInstance,
} from '@/lib/allmeta-writers';
import { inviteCandidateDirect, RobohireApiError } from '@/lib/robohire-client';
import { classifyRobohire } from '@/lib/dependency-health/classify';
import { reportDependencyDegraded, isRecoverableReason } from '@/lib/dependency-health/report';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';
import type { DepOutcome } from '@/lib/dependency-health/types';
import { getParsedResume } from '@/lib/partner-pg/parsed-resume';
import { getRequirementDetail } from '@/lib/partner-pg/requirements';
import { markInterviewInvitationSent } from '@/lib/partner-pg/interview-invitations';
import { createAgentLogger, currentLogger, runWithLogger } from '@/lib/agent-logger';
import { notifyRecruitmentLifecycle } from '@/server/notifications/recruitment-lifecycle';
import { recordNotification } from '@/server/notifications/ingest';
import {
  inngest,
  type InterviewInvitationRequestedData,
  type InterviewInvitationRequestedPayload,
  type InterviewInvitationSentPayload,
  type InterviewInvitationFailedPayload,
} from '@/server/inngest/client';
import { skipIfRaasV1Paused } from '@/server/inngest/raas-v1';

const AGENT_ID = 'interview-inviter-agent';
const AGENT_NAME = 'interviewInviter';

export const interviewInviterAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Interview Inviter Agent',
    retries: 2,
    triggers: [{ event: 'INTERVIEW_INVITATION_REQUESTED' }],
  },
  async ({ event, step, logger, runId }) => {
    const paused = await skipIfRaasV1Paused(AGENT_ID, logger);
    if (paused) return paused;

    return await interviewInviterAgentHandler({ event, step, logger, runId });
  },
);

// ──────────────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────────────
//
// Exported so unit tests can drive it directly without spinning up Inngest
// (same pattern as ruleCheckAgentHandler).
export async function interviewInviterAgentHandler({ event, step, logger, runId }: any) {
  // RAAS 端发的事件信封形态:{ payload:{...}, trace?, entity_*? }。沿用
  // 其它 RAAS-emitted 事件的 unwrap 风格 — 优先从 .payload 取,扁平兜底。
  const raw = event.data as InterviewInvitationRequestedData & Record<string, unknown>;
  const payload: InterviewInvitationRequestedPayload =
    (raw?.payload && typeof raw.payload === 'object'
      ? (raw.payload as InterviewInvitationRequestedPayload)
      : (raw as unknown as InterviewInvitationRequestedPayload)) ?? ({} as InterviewInvitationRequestedPayload);

  const traceId =
    payload.runtime_context?.trace_id ??
    raw?.trace?.trace_id ??
    undefined;
  const candidateId = payload.candidate_id ?? '';
  const jrId = payload.job_requisition_id ?? '';
  const applicationId = payload.application_id ?? null;
  const stepKey = sanitizeStepKey(`${candidateId}-${jrId}`);

  const fileLogger = createAgentLogger({
    agent: AGENT_NAME,
    runId: runId ?? `local-${Date.now()}`,
    traceId: traceId ?? null,
    anchors: {
      candidate_id: candidateId || undefined,
      job_requisition_id: jrId || undefined,
      application_id: applicationId ?? undefined,
    },
  });

  return runWithLogger(fileLogger, async () => {
    fileLogger.event('handler.start', {
      event_name: event.name,
      candidate_id: candidateId,
      job_requisition_id: jrId,
      application_id: applicationId,
      recruiter_id: payload.recruiter_id ?? null,
      correlation_id: payload.correlation_id ?? null,
      job_posting_id: payload.job_posting_id ?? null,
      trigger_source: payload.trigger_source ?? null,
      requested_at: payload.requested_at ?? null,
      has_resume_text: Boolean(payload.resume_text),
      has_jd_text: Boolean(payload.jd_text),
      has_robohire_resume_id: Boolean(payload.robohire_resume_id),
      has_robohire_job_id: Boolean(payload.robohire_job_id),
    });

    // STEP 1 完整入参 — RAAS → AO 原始 event envelope (含 trace + 全部 RAAS payload 字段).
    // 2026-05-26 加: handler.start 上面只记 anchors+flags,实际 candidate_email /
    // recruiter_email / job_title / company_name / interview_duration 等 RAAS 给的
    // 全部参数没落地,Inngest dev event store 又会 evict,事故后 1 天就丢证据.
    fileLogger.event('handler.raw_input', {
      from: 'RAAS',
      to: 'AO.interviewInviter',
      event_name: event.name,
      raw_event_data: event.data,
    });

    // ── anchors 校验 — 缺关键字段直接 NonRetriable + emit FAILED ────────
    if (!candidateId || !jrId) {
      const failedPayload: InterviewInvitationFailedPayload = {
        candidate_id: candidateId || 'unknown',
        job_requisition_id: jrId || 'unknown',
        application_id: applicationId,
        error_code: 'MISSING_PAYLOAD',
        error_message: 'INTERVIEW_INVITATION_REQUESTED payload 缺 candidate_id 或 job_requisition_id',
        failed_at: new Date().toISOString(),
      };
      await emitFailed(step, stepKey, failedPayload, traceId);
      throw new NonRetriableError(
        `[${AGENT_NAME}] payload anchors 缺失:candidate_id=${candidateId} jr=${jrId}`,
      );
    }

    // ── 1. Backfill resume_text / jd_text(thin event 兜底)─────────────
    //
    // RoboHire /invite-candidate 接受 (resume OR resume_id) + (jd OR job_id);
    // 优先用 event 直传的 robohire_resume_id / robohire_job_id 走 RoboHire
    // server-side 取数;其次用 event 直传的 resume_text / jd_text;最后才
    // backfill。Backfill 失败 = NonRetriable(JR/简历不存在,重试无意义)。

    let resumeText: string | undefined = payload.resume_text;
    let jdText: string | undefined = payload.jd_text;

    if (!payload.robohire_resume_id && !resumeText) {
      const backfilled = await step.run(`backfill-resume-${stepKey}`, async () => {
        return await backfillResumeText(candidateId, payload.resume_id ?? null, fileLogger);
      });
      if (!backfilled.ok) {
        const failedPayload: InterviewInvitationFailedPayload = {
          candidate_id: candidateId,
          job_requisition_id: jrId,
          application_id: applicationId,
          error_code: 'BACKFILL_FAILED',
          error_message: `resume backfill 失败:${backfilled.error}`,
          failed_at: new Date().toISOString(),
        };
        await emitFailed(step, stepKey, failedPayload, traceId);
        throw new NonRetriableError(`[${AGENT_NAME}] ${failedPayload.error_message}`);
      }
      resumeText = backfilled.text;
    }

    if (!payload.robohire_job_id && !jdText) {
      const backfilled = await step.run(`backfill-jd-${stepKey}`, async () => {
        return await backfillJdText(jrId, fileLogger);
      });
      if (!backfilled.ok) {
        const failedPayload: InterviewInvitationFailedPayload = {
          candidate_id: candidateId,
          job_requisition_id: jrId,
          application_id: applicationId,
          error_code: 'BACKFILL_FAILED',
          error_message: `jd backfill 失败:${backfilled.error}`,
          failed_at: new Date().toISOString(),
        };
        await emitFailed(step, stepKey, failedPayload, traceId);
        throw new NonRetriableError(`[${AGENT_NAME}] ${failedPayload.error_message}`);
      }
      jdText = backfilled.text;
    }

    // External-dependency-health context — when RoboHire is dead (out-of-funds /
    // fault) we still emit INTERVIEW_INVITATION_FAILED, then fail the run instead
    // of reporting false success. GoHire business rejections (GOHIRE_REJECTED)
    // are NOT dependency failures and are left as-is.
    const depCtx = {
      agent: 'InterviewInviter',
      runId: runId ?? null,
      traceId: traceId ?? null,
      domain: RECRUITMENT_DOMAIN_ID,
      anchors: {
        candidate_id: candidateId || undefined,
        job_requisition_id: jrId || undefined,
        application_id: applicationId ?? undefined,
      },
    };

    // ── 2. RoboHire POST /api/v1/invite-candidate ──────────────────────
    const inviteResult = await step.run(`invite-${stepKey}`, async () => {
      const inviteInput = {
        resume: resumeText,
        resume_id: payload.robohire_resume_id,
        jd: jdText,
        job_id: payload.robohire_job_id,
        hiring_request_id: payload.hiring_request_id,
        candidate_email: payload.candidate_email,
        recruiter_email: payload.recruiter_email,
        interviewer_requirement: payload.interviewer_requirement,
        job_title: payload.job_title,
        company_name: payload.company_name,
        interview_language: payload.interview_language,
        interview_duration: payload.interview_duration,
        interview_mode: payload.interview_mode,
        passing_score: payload.passing_score,
        linked_assessment_id: payload.linked_assessment_id,
      };
      logger.info(
        `[${AGENT_NAME}] RoboHire /invite-candidate · candidate=${candidateId} jr=${jrId} ` +
          `email=${payload.candidate_email ?? 'inferred'} lang=${payload.interview_language ?? 'default'}`,
      );
      try {
        // 显式传 fileLogger → RoboHire invite-candidate 完整 in/out 进 per-run 审计
        // (Inngest step.run 内 ALS 不可靠,必须显式传闭包 logger).
        const r = await inviteCandidateDirect(inviteInput, {
          traceId: traceId ?? undefined,
          logger: fileLogger,
        });
        logger.info(
          `[${AGENT_NAME}] RoboHire invite OK · requestId=${r.requestId} reused=${r.data?.reused ?? false}`,
        );
        // raw = 完整 RoboHire envelope (含 success/data/requestId), 给 partner-pg
        // gohire_invite_log 字段做 1:1 JSON.stringify 用. 不要在这里 cherry-pick.
        return { ok: true as const, data: r.data, requestId: r.requestId, raw: r };
      } catch (e) {
        if (e instanceof RobohireApiError) {
          // 4xx(含 402/403 quota)— 不重试,转 emit FAILED
          if (e.isClientError || e.code === 'QUOTA_EXHAUSTED') {
            const code = e.code === 'QUOTA_EXHAUSTED' ? 'ROBOHIRE_QUOTA' : 'ROBOHIRE_4XX';
            return {
              ok: false as const,
              terminal: true as const,
              error_code: code,
              error_message: `${e.code}: ${e.message}`,
              http_status: e.httpStatus,
              request_id: e.requestId ?? null,
              // Dead-dependency signal (没钱了 / 凭证) — reported after FAILED is emitted.
              degraded: classifyRobohire('inviteCandidate', e) as Extract<DepOutcome, { ok: false }>,
            };
          }
          // 2026-05-25 fix(由 e2e 暴露):2xx + body.success=false 是上游业务拒绝
          // (例:RoboHire 返 "upload_resume failed after 3 attempts" — GoHire 端
          // resume 解析失败,RoboHire 内部已重试 3 次).handleJsonResponse 把这种
          // 情形标 code='SERVER',但 httpStatus 是 2xx — AO 这层重跑不会有不同结果.
          // 分类为 GOHIRE_REJECTED terminal,让 RaaS 拿到 _FAILED 而不是 Inngest
          // run 静默退休(use case doc §6 L1 fix).
          if (e.code === 'SERVER' && e.httpStatus >= 200 && e.httpStatus < 400) {
            return {
              ok: false as const,
              terminal: true as const,
              error_code: 'GOHIRE_REJECTED',
              error_message: `RoboHire 2xx 但 success=false: ${e.message}`,
              http_status: e.httpStatus,
              request_id: e.requestId ?? null,
            };
          }
          // 429 / 实际 5xx HTTP / NETWORK — 落 dependency 信号后抛错走 Inngest retry
        }
        // Transient (429/5xx/network) or unwrapped error — record the degraded
        // signal then throw (retriable; the run parks + retries, not green).
        const oc = classifyRobohire('inviteCandidate', e);
        if (!oc.ok) await reportDependencyDegraded(oc, depCtx);
        throw e; // an error always classifies as degraded; this also fails the run
      }
    });

    if (!inviteResult.ok) {
      const degraded = 'degraded' in inviteResult ? inviteResult.degraded : null;
      const recoverable = degraded ? isRecoverableReason(degraded.reason) : false;
      // Emit the terminal INTERVIEW_INVITATION_FAILED for business rejections
      // (GOHIRE_REJECTED) and non-recoverable dependency degrades (bad
      // credentials). A recoverable degrade (out-of-funds / transient) parks +
      // auto-resumes, so we skip the terminal event to avoid a spurious _FAILED
      // before a later retry-success.
      if (!recoverable) {
        const failedPayload: InterviewInvitationFailedPayload = {
          candidate_id: candidateId,
          job_requisition_id: jrId,
          application_id: applicationId,
          error_code: inviteResult.error_code as InterviewInvitationFailedPayload['error_code'],
          error_message: inviteResult.error_message,
          http_status: inviteResult.http_status,
          robohire_request_id: inviteResult.request_id,
          failed_at: new Date().toISOString(),
        };
        await emitFailed(step, stepKey, failedPayload, traceId);
      }
      // Dead dependency → record signal + fail the run (recoverable → retriable
      // park + auto-resume; otherwise NonRetriable). Business rejections carry no
      // `degraded` and behave as before (terminal _FAILED, returns).
      if (degraded) {
        await reportDependencyDegraded(degraded, depCtx);
      }
      return { ok: false, candidate_id: candidateId, job_requisition_id: jrId, error: inviteResult.error_code };
    }

    // ── 2b. Persistence-warning 旁路:RoboHire 邀请送出但自己落库失败 ─────
    // 不算 fatal(候选人能用 login_url 进面试),但 RAAS 端需要知情。
    // 仍然写 AO Neo4j(我们的写盘是独立路径)+ emit _FAILED 把警告抛上去。
    const persistenceWarning =
      typeof inviteResult.data?.persistenceWarning === 'string'
        ? inviteResult.data.persistenceWarning
        : null;

    // ── 2c. GoHire-rejected 旁路:RoboHire 200 但 data.message 含上游拒绝 ──
    // (RoboHire 在 GoHire 失败时一般会返 4xx + code:gohire_invitation_failed
    //  → 上面 isClientError 已捕获;此处只兜底极端情况)
    if (!inviteResult.data?.login_url && !inviteResult.data?.reused) {
      const failedPayload: InterviewInvitationFailedPayload = {
        candidate_id: candidateId,
        job_requisition_id: jrId,
        application_id: applicationId,
        error_code: 'GOHIRE_REJECTED',
        error_message: `RoboHire 200 但无 login_url(GoHire 可能未签发):${
          inviteResult.data?.message ?? 'no message'
        }`,
        robohire_request_id: inviteResult.requestId ?? null,
        failed_at: new Date().toISOString(),
      };
      await emitFailed(step, stepKey, failedPayload, traceId);
      return { ok: false, candidate_id: candidateId, job_requisition_id: jrId, error: 'GOHIRE_REJECTED' };
    }

    // ── 3. Allmeta 写实例(soft-fail;允许 Neo4j 写挂仍 emit _SENT)──────
    const sentAt = new Date().toISOString();
    const interviewRecordId = `ivr_${candidateId}_${jrId}_inv`;
    // 同一 candidate+jr 多次邀请会冲一个 PK;实际 RoboHire 那边自带 dedup
    // (reused:true),Neo4j 这边 allmeta upsert by PK 也只保留最新一条。
    const communicationLogId = `comm_invite_${candidateId}_${jrId}_${Date.now()}`;
    const technicalWarnings: string[] = [];

    const loginUrl = nullableString(inviteResult.data?.login_url);
    const qrcodeUrl = nullableString(inviteResult.data?.qrcode_url);
    const userId = inviteResult.data?.user_id ?? null;
    const requestIntroductionId = nullableString(inviteResult.data?.request_introduction_id);
    const gohireJobId = inviteResult.data?.gohire_job_id ?? null;
    const candidateEmail =
      nullableString(inviteResult.data?.email) ?? nullableString(payload.candidate_email);
    const interviewLanguage = nullableString(payload.interview_language);
    const durationMinutes =
      typeof inviteResult.data?.job_interview_duration === 'number'
        ? inviteResult.data.job_interview_duration
        : payload.interview_duration ?? null;

    const communicationWrite = await step.run(`write-comm-log-${stepKey}`, async () => {
      const contentLines: string[] = [];
      if (loginUrl) contentLines.push(`登陆链接:${loginUrl}`);
      if (qrcodeUrl) contentLines.push(`二维码:${qrcodeUrl}`);
      if (interviewLanguage) contentLines.push(`语言:${interviewLanguage}`);
      if (durationMinutes) contentLines.push(`时长:${durationMinutes} 分钟`);

      const r = await writeCommunicationLogInstance({
        communication_log_id: communicationLogId,
        application_id: applicationId,
        message_sender: payload.recruiter_id ?? 'AO.InterviewInviter',
        message_receiver: candidateEmail ?? candidateId,
        interaction_type: '面试邀请',
        message_content: contentLines.join('\n') || '已通过 RoboHire 发出 AI 视频面试邀请',
        content_summary: `AI 视频面试邀请已发出${
          inviteResult.data?.reused ? '(复用之前的 invite)' : ''
        }`,
        timestamp: sentAt,
      });
      if (r.ok) logger.info(`[${AGENT_NAME}] ✓ allmeta wrote Communication_Log ${communicationLogId}`);
      else logger.warn(`[${AGENT_NAME}] allmeta Communication_Log write failed: ${r.error}`);
      return r;
    });
    if (!communicationWrite.ok) {
      technicalWarnings.push(`Allmeta Communication_Log 写入失败: ${communicationWrite.error}`);
    }

    const interviewWrite = await step.run(`write-interview-record-${stepKey}`, async () => {
      const notes: Record<string, unknown> = {
        invite_request_id: inviteResult.requestId,
        invite_user_id: userId,
        invite_request_introduction_id: requestIntroductionId,
        invite_gohire_job_id: gohireJobId,
        invite_reused: inviteResult.data?.reused === true,
        invite_qrcode_url: qrcodeUrl,
        invite_login_url: loginUrl,
        invite_message: inviteResult.data?.message ?? null,
      };
      const r = await writeInterviewRecordInstance({
        interview_record_id: interviewRecordId,
        application_id: applicationId,
        interviewer_employee_id: payload.recruiter_id ?? null,
        interview_type: '我司面试',
        interview_round: '一面',
        interview_mode: payload.interview_mode ?? 'AI视频面试',
        duration_minutes: durationMinutes,
        // recording_url 邀请阶段暂存 login_url;真实录像 URL 等面试结束后
        // 由下游 agent 在同 PK upsert 覆盖。
        recording_url: loginUrl,
        raw_interview_notes: JSON.stringify(notes),
      });
      if (r.ok) logger.info(`[${AGENT_NAME}] ✓ allmeta wrote Interview_Record ${interviewRecordId}`);
      else logger.warn(`[${AGENT_NAME}] allmeta Interview_Record write failed: ${r.error}`);
      return r;
    });
    if (!interviewWrite.ok) {
      technicalWarnings.push(`Allmeta Interview_Record 写入失败: ${interviewWrite.error}`);
    }

    // ── 3b. partner-pg dual-write:UPDATE interview_invitation by correlation_id ─
    //
    // RaaS emit _REQUESTED 前已经在 partner-pg INSERT 了一行 (status='requested');
    // AO 这边按 correlation_id 找到那行, 写回 GoHire 回执 (login_url / qrcode_url /
    // gohire_user_id / request_introduction_id) + 把 RoboHire 响应原文塞进
    // gohire_invite_log + status='sent'. UPDATE 天然幂等.
    //
    // Soft-fail: 候选人已经收到邮件 (login_url 是事实), partner-pg 写挂或没命中
    // 行不该把整条 run 拖死;落 warn 日志, 继续 emit _SENT, RaaS 可以从事件
    // payload 自行 reconcile.
    const correlationId = nullableString(payload.correlation_id);
    if (correlationId) {
      const partnerWrite = await step.run(`update-invitation-pg-${stepKey}`, async () => {
        const r = await markInterviewInvitationSent(correlationId, {
          login_url: loginUrl,
          qrcode_url: qrcodeUrl,
          gohire_user_id:
            typeof userId === 'string' || typeof userId === 'number' ? userId : null,
          request_introduction_id: requestIntroductionId,
          // RoboHire 响应原始 JSON 字符串 — 1:1 stringify, 不重排不 cherry-pick.
          gohire_invite_log: JSON.stringify(inviteResult.raw),
        });
        if (r.ok && r.updated) {
          logger.info(
            `[${AGENT_NAME}] ✓ partner-pg interview_invitation UPDATE · correlation_id=${correlationId}`,
          );
        } else if (r.ok) {
          logger.warn(
            `[${AGENT_NAME}] partner-pg interview_invitation correlation_id=${correlationId} ` +
              '命中 0 行 — RaaS 可能未先 INSERT, 仍 emit _SENT 让 RaaS 自行 reconcile',
          );
        } else {
          logger.warn(
            `[${AGENT_NAME}] partner-pg interview_invitation UPDATE 失败 · ` +
              `correlation_id=${correlationId} err=${r.error} — soft-fail, 仍 emit _SENT`,
          );
        }
        return r;
      });
      if (!partnerWrite.ok) {
        technicalWarnings.push(`Partner-PG interview_invitation 更新失败: ${partnerWrite.error}`);
      } else if (!partnerWrite.updated) {
        technicalWarnings.push(`Partner-PG interview_invitation 未命中 correlation_id=${correlationId}`);
      }
    } else {
      logger.warn(
        `[${AGENT_NAME}] payload 缺 correlation_id, 跳过 partner-pg interview_invitation UPDATE`,
      );
      technicalWarnings.push('缺 correlation_id，未回写 Partner-PG interview_invitation');
    }

    // ── 4a. PERSISTENCE_WARNING 旁路:Neo4j 写完后仍要 emit _FAILED 通知 ──
    if (persistenceWarning) {
      technicalWarnings.push(`RoboHire 邀请送达但 RoboHire 端 DB 写失败: ${persistenceWarning}`);
      const failedPayload: InterviewInvitationFailedPayload = {
        candidate_id: candidateId,
        job_requisition_id: jrId,
        application_id: applicationId,
        error_code: 'PERSISTENCE_WARNING',
        error_message: `RoboHire 邀请送达但 RoboHire 端 DB 写失败:${persistenceWarning}`,
        robohire_request_id: inviteResult.requestId ?? null,
        failed_at: sentAt,
      };
      await emitFailed(step, stepKey, failedPayload, traceId);
      // 不 return — 仍然 emit _SENT(候选人确实拿到了 login_url),让 RAAS 两条都看见。
    }

    if (technicalWarnings.length > 0) {
      fileLogger.event('persistence.failed', {
        candidate_id: candidateId,
        job_requisition_id: jrId,
        warnings: technicalWarnings,
      });
      await recordNotification({
        level: 'warn',
        category: 'agent_error',
        source: 'InterviewInviter',
        agent: 'InterviewInviter',
        runId: runId ?? null,
        traceId: traceId ?? null,
        message: `面试邀约已送达，但存在 ${technicalWarnings.length} 个持久化问题: ${technicalWarnings.join('; ')}`,
        anchors: { candidate_id: candidateId, job_requisition_id: jrId, application_id: applicationId },
        dedupeHint: 'interview_invitation.persistence_partial',
      });
    }

    // ── 4b. Success — emit _SENT ───────────────────────────────────────
    const sentPayload: InterviewInvitationSentPayload = {
      candidate_id: candidateId,
      job_requisition_id: jrId,
      application_id: applicationId,
      candidate_match_result_id: payload.candidate_match_result_id ?? null,
      correlation_id: correlationId,
      interview_record_id: interviewRecordId,
      communication_log_id: communicationLogId,
      login_url: loginUrl,
      qrcode_url: qrcodeUrl,
      user_id: typeof userId === 'string' || typeof userId === 'number' ? userId : null,
      request_introduction_id: requestIntroductionId,
      gohire_job_id:
        typeof gohireJobId === 'string' || typeof gohireJobId === 'number' ? gohireJobId : null,
      candidate_email: candidateEmail,
      interview_language: interviewLanguage,
      interview_duration_minutes: typeof durationMinutes === 'number' ? durationMinutes : null,
      robohire_request_id: inviteResult.requestId ?? null,
      execution_success: true,
      business_outcome: 'passed',
      technical_warnings: technicalWarnings,
      sent_at: sentAt,
    };

    fileLogger.event('emit.invitation-sent', {
      from: 'AO.interviewInviter',
      to: 'RAAS (Inngest event INTERVIEW_INVITATION_SENT)',
      candidate_id: candidateId,
      job_requisition_id: jrId,
      interview_record_id: interviewRecordId,
      communication_log_id: communicationLogId,
      login_url: loginUrl,
      full_payload: sentPayload,    // 完整 emit payload 全字段
    });
    await step.sendEvent(`emit-invitation-sent-${stepKey}`, {
      name: 'INTERVIEW_INVITATION_SENT',
      data: {
        entity_type: 'Interview_Record',
        entity_id: interviewRecordId,
        event_id: `inv_sent_${candidateId}_${jrId}_${Date.now()}`,
        payload: sentPayload,
        trace: { trace_id: traceId ?? null },
      },
    });
    await notifyRecruitmentLifecycle(step, 'INTERVIEW_INVITATION_SENT', {
      anchors: { candidate_id: candidateId, job_requisition_id: jrId, application_id: interviewRecordId },
      runId: runId ?? null,
      traceId: traceId ?? null,
    });

    logger.info(
      `[${AGENT_NAME}] ✅ emitted INTERVIEW_INVITATION_SENT · candidate=${candidateId} jr=${jrId} ` +
        `interview_record_id=${interviewRecordId}`,
    );
    fileLogger.event('handler.done', {
      from: 'AO.interviewInviter',
      to: '(handler return)',
      candidate_id: candidateId,
      job_requisition_id: jrId,
      interview_record_id: interviewRecordId,
      communication_log_id: communicationLogId,
      reused: inviteResult.data?.reused === true,
      login_url: loginUrl,
      qrcode_url: qrcodeUrl,
      user_id: userId,
      robohire_request_id: inviteResult.requestId ?? null,
      sent_at: sentAt,
    });
    return {
      ok: true,
      candidate_id: candidateId,
      job_requisition_id: jrId,
      interview_record_id: interviewRecordId,
      communication_log_id: communicationLogId,
      reused: inviteResult.data?.reused === true,
      execution_success: true,
      business_outcome: 'passed',
      technical_warnings: technicalWarnings,
    };
  }); // runWithLogger
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

async function emitFailed(
  step: any,
  stepKey: string,
  failedPayload: InterviewInvitationFailedPayload,
  traceId: string | undefined,
): Promise<void> {
  const logger = currentLogger();
  const payloadWithOutcome: InterviewInvitationFailedPayload = {
    ...failedPayload,
    execution_success: false,
    business_outcome: failedPayload.error_code === 'GOHIRE_REJECTED' ? 'rejected' : 'blocked',
  };
  logger?.event('emit.invitation-failed', {
    from: 'AO.interviewInviter',
    to: 'RAAS (Inngest event INTERVIEW_INVITATION_FAILED)',
    error_code: failedPayload.error_code,
    full_payload: payloadWithOutcome,    // 完整 _FAILED payload
  });
  await step.sendEvent(`emit-invitation-failed-${stepKey}-${failedPayload.error_code}`, {
    name: 'INTERVIEW_INVITATION_FAILED',
    data: {
      entity_type: 'Candidate',
      entity_id: failedPayload.candidate_id,
      event_id: `inv_failed_${failedPayload.candidate_id}_${failedPayload.job_requisition_id}_${Date.now()}`,
      payload: payloadWithOutcome,
      trace: { trace_id: traceId ?? null },
    },
  });
  await notifyRecruitmentLifecycle(step, 'INTERVIEW_INVITATION_FAILED', {
    anchors: {
      candidate_id: failedPayload.candidate_id,
      job_requisition_id: failedPayload.job_requisition_id,
      application_id: failedPayload.application_id,
    },
    runId: logger?.ctx?.runId ?? null,
    traceId: traceId ?? null,
  });
}

type BackfillResult = { ok: true; text: string } | { ok: false; error: string };

async function backfillResumeText(
  candidateId: string,
  resumeId: string | null,
  fileLogger: ReturnType<typeof createAgentLogger>,
): Promise<BackfillResult> {
  if (!resumeId) {
    return { ok: false, error: 'event 缺 resume_id,无法回查 parsed_content' };
  }
  try {
    const r = await getParsedResume(candidateId, resumeId);
    if (!r) return { ok: false, error: `partner-pg 找不到 candidate=${candidateId} resume=${resumeId}` };
    const text =
      typeof r.parsed_content === 'string' && r.parsed_content.trim().length > 0
        ? r.parsed_content
        : r.data
          ? JSON.stringify(r.data)
          : '';
    if (!text.trim()) return { ok: false, error: 'parsed_content 与 raw_parse_result 均空' };
    fileLogger.event('backfill.resume.ok', {
      from: '候选人数据库',
      to: '智能体 (→ 外部面试服务)',
      candidate_id: candidateId,
      resume_id: resumeId,
      src: typeof r.parsed_content === 'string' && r.parsed_content.trim().length > 0
        ? 'parsed_content'
        : 'raw_parse_result_json',
      chars: text.length,
      text,    // 完整简历正文 — 让对比"AO 拉到的 vs GoHire 邮件称谓"成为可能
    });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function backfillJdText(
  jrId: string,
  fileLogger: ReturnType<typeof createAgentLogger>,
): Promise<BackfillResult> {
  try {
    const req = await getRequirementDetail(jrId);
    if (!req) return { ok: false, error: `partner-pg 找不到 JR ${jrId}` };
    const text = flattenRequirementForJd(req as unknown as Record<string, unknown>);
    if (!text.trim()) return { ok: false, error: 'JR 行存在但展平后 jd 文本为空' };
    fileLogger.event('backfill.jd.ok', {
      from: '岗位数据库',
      to: '智能体 (→ 外部面试服务)',
      job_requisition_id: jrId,
      chars: text.length,
      text,    // 完整 JD 文本
    });
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * Flatten partner-pg JR row → JD plain text(供 RoboHire `/invite-candidate`
 * 的 `jd` 字段)。复制自 match-resume-agent 同名 helper,字段集对齐:
 * 简单复制比拉出 export + 跨文件耦合更便宜(20 行规模)。
 */
function flattenRequirementForJd(req: Record<string, unknown>): string {
  const r = req as Record<string, any>;
  const lines: string[] = [];
  if (r.client_job_title || r.title) lines.push(`职位: ${r.client_job_title ?? r.title}`);
  if (r.expected_level) lines.push(`期望级别: ${r.expected_level}`);
  if (r.work_city || r.city) lines.push(`工作城市: ${r.work_city ?? r.city}`);
  if (r.salary_range) lines.push(`薪资范围: ${r.salary_range}`);
  if (r.recruitment_type) lines.push(`招聘类型: ${r.recruitment_type}`);
  if (r.interview_mode) lines.push(`面试形式: ${r.interview_mode}`);
  if (r.work_years != null) lines.push(`\n工作年限: ${r.work_years} 年`);
  if (r.degree_requirement) lines.push(`学历要求: ${r.degree_requirement}`);
  if (r.education_requirement) lines.push(`专业要求: ${r.education_requirement}`);
  if (r.language_requirements) lines.push(`语言要求: ${r.language_requirements}`);
  if (Array.isArray(r.must_have_skills) && r.must_have_skills.length)
    lines.push(`\n必备技能:\n  - ${r.must_have_skills.join('\n  - ')}`);
  if (Array.isArray(r.nice_to_have_skills) && r.nice_to_have_skills.length)
    lines.push(`\n加分技能:\n  - ${r.nice_to_have_skills.join('\n  - ')}`);
  if (r.negative_requirement && r.negative_requirement !== '无')
    lines.push(`\n排除条件:\n${r.negative_requirement}`);
  if (r.job_responsibility) lines.push(`\n岗位职责:\n${r.job_responsibility}`);
  if (r.job_requirement) lines.push(`\n任职要求:\n${r.job_requirement}`);
  return lines.join('\n');
}

function sanitizeStepKey(s: string): string {
  return s.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 80) || 'unknown';
}

function nullableString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v;
  return null;
}
