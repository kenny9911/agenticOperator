// matchResume agent — Workflow node 10-2 (`matchResume`).
//
// 2026-05-19 consolidation: 只订 MATCH_RULE_CHECK_PASSED。
// (原第一段 — RESUME_PROCESSED → 拉 JR + emit RULE_CHECK_REQUESTED —
// 已搬到 ruleCheckAgent。)
//
// 流程:
//   1. 直连 RoboHire POST /match-resume(不走 RAAS proxy)
//   2. RAAS POST /match-results 落 overall match 字段
//   3. score 阈值分发(F3,2026-05-21 单阈值化):
//        < 40                    → MATCH_FAILED
//        其它(含 null / 缺分)     → MATCH_PASSED_NEED_INTERVIEW
//        调用失败                → MATCH_FAILED (上方 RobohireApiError 分支)
//
// 见 docs/superpowers/specs/2026-05-19-rule-check-consolidation-design.md

import { NonRetriableError } from 'inngest';
import { saveMatchResultsToPartnerPg } from '@/lib/partner-pg/match-results';
import { resolveMatchPayload } from '@/lib/partner-pg/_robohire-normalize';
import { writeCandidateMatchResultInstance } from '@/lib/allmeta-writers';
import { matchResumeDirect } from '@/lib/robohire-client';
import { classifyRobohire } from '@/lib/dependency-health/classify';
import { reportDependencyDegraded, isRecoverableReason } from '@/lib/dependency-health/report';
import { RECRUITMENT_DOMAIN_ID } from '@/lib/domain-ids';
import type { DepOutcome } from '@/lib/dependency-health/types';
import { createAgentLogger, runWithLogger } from '@/lib/agent-logger';
import { notifyRecruitmentLifecycle } from '@/server/notifications/recruitment-lifecycle';
import { recordNotification } from '@/server/notifications/ingest';
import {
  inngest,
  type MatchEventData,
  type MatchRuleCheckPassedData,
  type RuleCheckAuditMeta,
} from '@/server/inngest/client';
import { skipIfRaasV1Paused } from '@/server/inngest/raas-v1';
import { appendRuleCheckToJd } from '@/lib/rule-check/match-jd-augment';
import {
  extractCandidateExpectation,
  formatCandidatePreferences,
} from '@/lib/mappers/candidate-preferences';

// Loose shape — the merged JR object from rule-check carries arbitrary
// keys (path A flatten + path B agent-view item). Field-name probes below.
type RequirementsAgentViewItem = Record<string, unknown>;

const AGENT_ID = 'match-resume-agent';
const AGENT_NAME = 'matchResume';

export const matchResumeAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Match Resume Agent',
    retries: 2,
    triggers: [{ event: 'MATCH_RULE_CHECK_PASSED' }],
  },
  async ({ event, step, logger, runId }) => {
    const paused = await skipIfRaasV1Paused(AGENT_ID, logger);
    if (paused) return paused;

    return await matchResumeAgentHandler({ event, step, logger, runId });
  },
);

// ──────────────────────────────────────────────────────────────────────
// MATCH_RULE_CHECK_PASSED → RoboHire match → saveMatchResults → emit MATCH_*
// ──────────────────────────────────────────────────────────────────────

export async function matchResumeAgentHandler({ event, step, logger, runId }: any) {
  const data = event.data as MatchRuleCheckPassedData;
  const traceId = data.runtime_context?.trace_id ?? undefined;
  const stepKey = sanitizeStepKey(data.job_requisition_id);
  const req = (data.job_requisition ?? {}) as RequirementsAgentViewItem;
  const candidateId = data.candidate_id ?? '';
  const uploadId = data.upload_id ?? '';

  const fileLogger = createAgentLogger({
    agent: 'matchResume',
    runId: runId ?? `local-${Date.now()}`,
    traceId: traceId ?? null,
    anchors: {
      candidate_id: candidateId || undefined,
      job_requisition_id: data.job_requisition_id,
      upload_id: uploadId || undefined,
    },
  });
  return runWithLogger(fileLogger, async () => {
    fileLogger.event('handler.start', {
      event_name: event.name,
      candidate_id: candidateId,
      job_requisition_id: data.job_requisition_id,
    });

    const ruleCheckGate = verifyRuleCheckPassedForMatch(data);
    if (!ruleCheckGate.ok) {
      logger.warn(
        `[${AGENT_NAME}] MATCH_RULE_CHECK_PASSED blocked before RoboHire · ` +
          `jr=${data.job_requisition_id} reason=${ruleCheckGate.reason}` +
          (ruleCheckGate.detail ? ` detail=${ruleCheckGate.detail}` : ''),
      );
      fileLogger.event('handler.rule-check-gate-blocked', {
        candidate_id: candidateId,
        job_requisition_id: data.job_requisition_id,
        reason: ruleCheckGate.reason,
        detail: ruleCheckGate.detail,
      });
      await recordNotification({
        level: 'warn',
        category: 'agent_error',
        source: 'Matcher',
        agent: 'Matcher',
        runId: runId ?? null,
        traceId: traceId ?? null,
        message: `匹配前置校验阻断: ${ruleCheckGate.reason}${ruleCheckGate.detail ? ` (${ruleCheckGate.detail})` : ''}`,
        anchors: { candidate_id: candidateId, job_requisition_id: data.job_requisition_id, upload_id: uploadId },
        dedupeHint: `match_precondition.${ruleCheckGate.reason}`,
      });
      return {
        ok: false,
        job_requisition_id: data.job_requisition_id,
        error: ruleCheckGate.reason,
        detail: ruleCheckGate.detail,
      };
    }

    if (!data.job_requisition || !data.parsed_resume) {
      logger.warn(
        `[${AGENT_NAME}] MATCH_RULE_CHECK_PASSED missing job_requisition or parsed_resume for JR=${data.job_requisition_id} — cannot match`,
      );
      await recordNotification({
        level: 'warn',
        category: 'agent_error',
        source: 'Matcher',
        agent: 'Matcher',
        runId: runId ?? null,
        traceId: traceId ?? null,
        message: `匹配输入缺失: JR=${data.job_requisition_id} 缺 job_requisition 或 parsed_resume`,
        anchors: { candidate_id: candidateId, job_requisition_id: data.job_requisition_id, upload_id: uploadId },
        dedupeHint: 'match_precondition.missing-input',
      });
      return {
        ok: false,
        job_requisition_id: data.job_requisition_id,
        error: 'missing-job-requisition-or-parsed-resume',
      };
    }

  // 2026-06-25: pass RoboHire's STRUCTURED parse — rendered to clean labeled text
  // by buildResumeTextFromParsed — as the `resume` parameter, mirroring how the jd
  // side is built from structured job_requisition fields via
  // flattenRequirementForMatch. The raw PDF text (parsed_content / rawText) is now
  // a fallback used only when the structured parse yields nothing renderable, so we
  // never send an empty resume to /match-resume.
  // (Supersedes the 2026-05-21 rawText-first contract; rawText stays in the event
  //  payload for rule-check / identity, this only changes the matcher's input.)
  const parsedContent =
    typeof data.parsed_content === 'string' && data.parsed_content.trim().length > 0
      ? data.parsed_content
      : null;
  const structuredResumeText = buildResumeTextFromParsed(data.parsed_resume);
  const usingStructured = structuredResumeText.trim().length > 0;
  const resumeText = usingStructured ? structuredResumeText : parsedContent ?? '';
  const resumeSource: 'parsed_resume_structured' | 'parsed_content' = usingStructured
    ? 'parsed_resume_structured'
    : 'parsed_content';
  // 2026-06-12(领导要求):把规则检查结论追加进 jd 文本发给 RoboHire 做深度匹配
  // (接口仍是 {resume, jd})。MATCH_ATTACH_RULECHECK=0 可关回纯 JD。
  const jdText =
    process.env.MATCH_ATTACH_RULECHECK === '0'
      ? flattenRequirementForMatch(req)
      : appendRuleCheckToJd(flattenRequirementForMatch(req), data.rule_check_rules);

  // 候选人求职期望 → RoboHire `candidatePreferences` 通道(接口一直支持,此前从未接线,
  // 导致候选人的期望薪资/城市/职位/工作模式从不参与匹配)。优先用 ruleCheck 透传的
  // 结构化 candidate_expectation;为空则从结构化简历 / rawText 现抽。抽不到 → 不传,
  // 匹配退回纯 {resume, jd}(零回归)。
  const candidateExpectation =
    data.candidate_expectation && Object.keys(data.candidate_expectation).length > 0
      ? data.candidate_expectation
      : extractCandidateExpectation({
          parsed: data.parsed_resume,
          rawText: data.parsed_content,
        });
  const candidatePreferences = formatCandidatePreferences(candidateExpectation) || undefined;

  if (!resumeText.trim()) {
    throw new NonRetriableError(
      `[${AGENT_NAME}] resume text empty for JR ${data.job_requisition_id}`,
    );
  }

  // External-dependency-health context — when RoboHire is dead we still emit
  // MATCH_FAILED (downstream keeps its context) but then fail the run instead of
  // reporting false success, and the monitor alerts (没钱/故障/说不准).
  const depCtx = {
    agent: 'Matcher',
    runId: runId ?? null,
    traceId: traceId ?? null,
    domain: RECRUITMENT_DOMAIN_ID,
    anchors: {
      candidate_id: candidateId || undefined,
      job_requisition_id: data.job_requisition_id,
      upload_id: uploadId || undefined,
    },
  };

  const matchResult = await step.run(`match-${stepKey}`, async () => {
    logger.info(
      `[${AGENT_NAME}] calling RoboHire /match-resume · jr=${data.job_requisition_id} ` +
        `jd_chars=${jdText.length} resume_chars=${resumeText.length} resume_src=${resumeSource}`,
    );
    fileLogger.event('match.input', {
      job_requisition_id: data.job_requisition_id,
      candidate_id: candidateId || undefined,
      resume_chars: resumeText.length,
      resume_src: resumeSource,
      jd_chars: jdText.length,
      candidate_preferences_chars: candidatePreferences?.length ?? 0,
    });
    let r: Awaited<ReturnType<typeof matchResumeDirect>>;
    try {
      r = await matchResumeDirect(
        candidatePreferences
          ? { resume: resumeText, jd: jdText, candidatePreferences }
          : { resume: resumeText, jd: jdText },
        // 显式传 fileLogger → RoboHire match-resume 完整 in/out 进 per-run 审计
        // (Inngest step.run 内 ALS 不可靠,必须显式传闭包 logger).
        { traceId: traceId ?? undefined, logger: fileLogger },
      );
    } catch (e) {
      // Carry the classified degrade out so the handler can emit MATCH_FAILED
      // then report+throw (instead of returning a green run).
      const degraded = classifyRobohire('matchResume', e) as Extract<DepOutcome, { ok: false }>;
      return { ok: false as const, error: `${degraded.reason}: ${degraded.detail}`, degraded };
    }
    // Silent degrade: 200 OK but no usable match score.
    const oc = classifyRobohire('matchResume', r);
    if (!oc.ok) {
      return { ok: false as const, error: `${oc.reason}: ${oc.detail}`, degraded: oc };
    }
    logger.info(
      `[${AGENT_NAME}] RoboHire match OK · score=${r.data.matchScore} rec=${r.data.recommendation} requestId=${r.requestId}`,
    );
    return { ok: true as const, data: r.data, requestId: r.requestId, savedAs: r.savedAs };
  });

  if (!matchResult.ok) {
    const oc = matchResult.degraded;
    // Non-recoverable degrade (bad credentials / empty result) = we give up on
    // this candidate → emit the terminal MATCH_FAILED so downstream is informed.
    // Recoverable (out-of-funds / transient) → park + auto-resume after recovery,
    // so we do NOT emit a terminal event (avoids a spurious MATCH_FAILED before a
    // later retry-success). Mirrors rule-check's infra-failure park model.
    if (!isRecoverableReason(oc.reason)) {
      const failedPayload: MatchEventData = {
        job_requisition_id: data.job_requisition_id,
        candidate_id: candidateId || null,
        matching_score: null,
        upload_id: uploadId || null,
        overall_status: '不匹配',
        success: false,
        execution_success: false,
        business_outcome: 'blocked',
        business_reason: matchResult.error,
        data: { error_kind: 'robohire-match-call-failed' },
        error: matchResult.error,
      };
      fileLogger.event('emit.match-failed-robohire-error', {
        candidate_id: candidateId,
        job_requisition_id: data.job_requisition_id,
        error: matchResult.error,
      });
      await step.sendEvent(`emit-match-failed-${stepKey}`, {
        name: 'MATCH_FAILED',
        data: failedPayload,
      });
    }
    // Record the dependency signal + fail the run (recoverable → retriable park).
    await reportDependencyDegraded(oc, depCtx);
    return { ok: false, job_requisition_id: data.job_requisition_id, error: matchResult.error };
  }

  const saveResult = await step.run(`save-match-${stepKey}`, async () => {
    // 2026-05-21: pass the RoboHire envelope verbatim — the writer now
    // ports raas_v4's resolveMatchPayload / buildShapeDInner so real scores
    // (nested under overallMatchScore.score + breakdown) land in the right
    // columns. job_posting_id is resolved server-side from the JR if absent.
    const rd = matchResult.data as Record<string, unknown>;
    const r = await saveMatchResultsToPartnerPg({
      candidate_id: candidateId,
      job_requisition_id: data.job_requisition_id,
      client_id: pickClientId(req) ?? null,
      job_posting_id:
        typeof (req as Record<string, unknown>).job_posting_id === 'string'
          ? ((req as Record<string, unknown>).job_posting_id as string)
          : null,
      source: 'need_interview',
      created_by: 'ai_engine',
      raw_llm_response: rd,
    });
    logger.info(
      `[${AGENT_NAME}] partner-pg saveMatchResults OK · jr=${data.job_requisition_id} ` +
        `cmr=${r.candidate_match_result_id} jp=${r.job_posting_id ?? '-'} ` +
        `created=${r.created}${r.skipped ? ` skipped=${r.reason}` : ''}`,
    );
    return r;
  });

  const matching_score = extractMatchingScore(matchResult.data);
  const eventName = decideMatchEvent(matching_score);
  const overall_status: '匹配' | '不匹配' = eventName === 'MATCH_FAILED' ? '不匹配' : '匹配';

  // ── 写 Neo4j Candidate_Match_Result overall_* fields via allmeta ──
  // PK 复用 ruleCheckAgent 已建的 cmr_<candidate>_<jr>(allmeta upsert by PK)
  // 跟 ruleCheckAgent 那条 row 合并 — 覆盖 overall_* 不动 rule_check_*
  const neo4jWrite = await step.run(`write-cmr-neo4j-${stepKey}`, async () => {
    const rd = matchResult.data as Record<string, unknown>;
    const cmrId = `cmr_${candidateId || 'unknown'}_${data.job_requisition_id}`;
    const r = await writeCandidateMatchResultInstance({
      candidate_match_result_id: cmrId,
      client_id: pickClientId(req) ?? null,
      candidate_id: candidateId,
      job_requisition_id: data.job_requisition_id,
      overall_match_score: matching_score,
      overall_fit_verdict: overall_status,
      overall_fit_summary:
        typeof rd.recommendation === 'string' ? rd.recommendation : null,
      overall_match_grade: gradeFromScore(matching_score),
    });
    if (r.ok)
      logger.info(`[${AGENT_NAME}] ✓ allmeta wrote Candidate_Match_Result ${cmrId} overall_*`);
    else logger.warn(`[${AGENT_NAME}] allmeta CMR write failed: ${r.error}`);
    return r;
  });
  const technicalWarnings: string[] = [];
  if (!neo4jWrite.ok) {
    const warning = `Allmeta Candidate_Match_Result 写入失败: ${neo4jWrite.error}`;
    technicalWarnings.push(warning);
    fileLogger.event('persistence.failed', {
      target: 'Allmeta.Candidate_Match_Result',
      candidate_id: candidateId,
      job_requisition_id: data.job_requisition_id,
      error: neo4jWrite.error,
    });
    await recordNotification({
      level: 'warn',
      category: 'agent_error',
      source: 'Matcher',
      agent: 'Matcher',
      runId: runId ?? null,
      traceId: traceId ?? null,
      message: `匹配结论已生成，但 ${warning}`,
      anchors: { candidate_id: candidateId, job_requisition_id: data.job_requisition_id, upload_id: uploadId },
      dedupeHint: 'match_persistence.allmeta_cmr',
    });
  }

  const payload: MatchEventData = {
    job_requisition_id: data.job_requisition_id,
    candidate_id: candidateId || null,
    matching_score,
    upload_id: uploadId || null,
    job_posting_id:
      typeof (req as any).job_posting_id === 'string' && (req as any).job_posting_id.trim()
        ? ((req as any).job_posting_id as string).trim()
        : null,
    candidate_match_result_id: saveResult.candidate_match_result_id,
    overall_status,
    success: true,
    execution_success: true,
    business_outcome: eventName === 'MATCH_FAILED' ? 'rejected' : 'passed',
    business_reason: eventName === 'MATCH_FAILED' ? `匹配分 ${matching_score ?? '—'} 未达到面试阈值` : null,
    technical_warnings: technicalWarnings,
    data: matchResult.data as unknown as Record<string, unknown>,
    requestId: matchResult.requestId,
    savedAs: matchResult.savedAs,
  };
  fileLogger.event('emit.match-event', {
    event_name: eventName,
    candidate_id: candidateId,
    job_requisition_id: data.job_requisition_id,
    matching_score,
    candidate_match_result_id: saveResult.candidate_match_result_id,
    overall_status,
  });
  await step.sendEvent(`emit-match-${stepKey}`, { name: eventName, data: payload });
  if (eventName === 'MATCH_PASSED_NEED_INTERVIEW' || eventName === 'MATCH_FAILED') {
    await notifyRecruitmentLifecycle(step, eventName, {
      anchors: { candidate_id: candidateId, job_requisition_id: data.job_requisition_id, upload_id: uploadId },
      runId: runId ?? null,
      traceId,
    });
  }

  logger.info(
    `[${AGENT_NAME}] ✅ emitted ${eventName} · jr=${data.job_requisition_id} score=${matching_score}`,
  );
  fileLogger.event('handler.done', {
    event_name: eventName,
    candidate_id: candidateId,
    job_requisition_id: data.job_requisition_id,
    matching_score,
  });
  return {
    ok: true,
    job_requisition_id: data.job_requisition_id,
    requestId: matchResult.requestId,
    eventName,
    matching_score,
    execution_success: true,
    business_outcome: eventName === 'MATCH_FAILED' ? 'rejected' : 'passed',
    technical_warnings: technicalWarnings,
  };
  }); // runWithLogger
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function pickClientId(req: RequirementsAgentViewItem): string | undefined {
  for (const c of [(req as any).client_id, (req as any).clientId]) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }
  return undefined;
}

// Render RoboHire's structured parse (name / experience[] / education[] / skills)
// into clean labeled resume text — the candidate-side mirror of
// flattenRequirementForMatch (which does the same for the JD side). We send this
// instead of raw PDF text so /match-resume sees denoised, structured signal.
// Returns '' when nothing usable can be extracted, so the caller falls back to
// the raw parsed_content (rawText) rather than sending an empty resume.
export function buildResumeTextFromParsed(parsed: Record<string, unknown> | null | undefined): string {
  if (!parsed) return '';
  if (typeof parsed === 'string') return parsed;
  if (typeof parsed !== 'object') return '';

  const r = parsed as Record<string, any>;
  const lines: string[] = [];
  const str = (v: unknown): string =>
    typeof v === 'string' ? v.trim() : v == null ? '' : String(v);

  if (str(r.name)) lines.push(`姓名: ${str(r.name)}`);

  const contact = [str(r.phone ?? r.mobile), str(r.email)].filter(Boolean).join(' · ');
  if (contact) lines.push(`联系方式: ${contact}`);

  const exp = Array.isArray(r.experience)
    ? r.experience
    : Array.isArray(r.workExperience)
      ? r.workExperience
      : [];
  const expLines = exp
    .map((e: any) => {
      if (!e || typeof e !== 'object') return str(e);
      const head = [str(e.company), str(e.title)].filter(Boolean).join(' · ');
      const span = [str(e.startDate), str(e.endDate)].filter(Boolean).join(' - ');
      return [head, span ? `(${span})` : ''].filter(Boolean).join(' ');
    })
    .filter(Boolean);
  if (expLines.length) lines.push(`\n工作经历:\n  - ${expLines.join('\n  - ')}`);

  const edu = Array.isArray(r.education) ? r.education : [];
  const eduLines = edu
    .map((e: any) => {
      if (!e || typeof e !== 'object') return str(e);
      const head = [str(e.school), str(e.degree), str(e.major)].filter(Boolean).join(' · ');
      const span = str(e.endDate ?? e.graduationYear);
      return [head, span ? `(${span})` : ''].filter(Boolean).join(' ');
    })
    .filter(Boolean);
  if (eduLines.length) lines.push(`\n教育背景:\n  - ${eduLines.join('\n  - ')}`);

  const skillItems: string[] = [];
  const s = r.skills;
  if (Array.isArray(s)) skillItems.push(...s.map(str));
  else if (s && typeof s === 'object')
    for (const v of Object.values(s)) {
      if (Array.isArray(v)) skillItems.push(...v.map(str));
      else if (str(v)) skillItems.push(str(v));
    }
  else if (str(s)) skillItems.push(str(s));
  const skills = skillItems.filter(Boolean);
  if (skills.length) lines.push(`\n技能:\n  - ${skills.join('\n  - ')}`);

  if (str(r.summary)) lines.push(`\n个人摘要:\n${str(r.summary)}`);
  if (str(r.selfEvaluation)) lines.push(`\n自我评价:\n${str(r.selfEvaluation)}`);

  return lines.join('\n').trim();
}

type RuleCheckGateResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'rule-check-result-not-pass'
        | 'rule-check-audit-missing'
        | 'rule-check-bypassed'
        | 'rule-check-fail-reason-present'
        | 'rule-check-rules-not-evaluated'
        | 'rule-check-rules-missing'
        | 'rule-check-rules-malformed'
        | 'rule-check-rules-contain-fail';
      detail?: string;
    };

/**
 * Final pre-RoboHire gate: the matcher may only run after a real rule-check pass.
 *
 * The event name alone is not enough proof: dev bypass and manual event injection
 * can both produce MATCH_RULE_CHECK_PASSED-shaped payloads. Requiring a non-bypass
 * audit plus per-rule results keeps the expensive/external match step downstream
 * of an actual rule-check decision.
 */
export function verifyRuleCheckPassedForMatch(
  data: Partial<MatchRuleCheckPassedData>,
): RuleCheckGateResult {
  if ((data as { rule_check_result?: unknown }).rule_check_result !== '通过') {
    return {
      ok: false,
      reason: 'rule-check-result-not-pass',
      detail: `rule_check_result=${String((data as { rule_check_result?: unknown }).rule_check_result)}`,
    };
  }

  if (!data.audit || typeof data.audit !== 'object') {
    return { ok: false, reason: 'rule-check-audit-missing' };
  }

  const audit = data.audit as Partial<RuleCheckAuditMeta>;
  if (audit.llm_model === 'bypass' || audit.fail_reason === 'bypassed') {
    return { ok: false, reason: 'rule-check-bypassed' };
  }
  if (typeof audit.fail_reason === 'string' && audit.fail_reason.trim().length > 0) {
    return {
      ok: false,
      reason: 'rule-check-fail-reason-present',
      detail: audit.fail_reason.trim(),
    };
  }
  if (typeof audit.rules_evaluated !== 'number' || audit.rules_evaluated <= 0) {
    return {
      ok: false,
      reason: 'rule-check-rules-not-evaluated',
      detail: `rules_evaluated=${String(audit.rules_evaluated)}`,
    };
  }

  const rules = data.rule_check_rules;
  if (!Array.isArray(rules) || rules.length === 0) {
    return { ok: false, reason: 'rule-check-rules-missing' };
  }

  const malformed = rules.find(
    (r) =>
      !r ||
      typeof r.rule_id !== 'string' ||
      !r.rule_id.trim() ||
      typeof r.rule_name !== 'string' ||
      !r.rule_name.trim() ||
      typeof r.status !== 'string' ||
      !r.status.trim(),
  );
  if (malformed) {
    return {
      ok: false,
      reason: 'rule-check-rules-malformed',
      detail: JSON.stringify(malformed).slice(0, 200),
    };
  }

  const failed = rules.find(
    (r) =>
      normalizeRuleStatus(r.status) === 'fail' &&
      r.blocking !== false &&
      r.enforcement_level !== 'optional',
  );
  if (failed) {
    return {
      ok: false,
      reason: 'rule-check-rules-contain-fail',
      detail: `${failed.rule_id} ${failed.rule_name}`,
    };
  }

  return { ok: true };
}

function normalizeRuleStatus(status: string): string {
  const s = status.trim().toLowerCase();
  if (s === 'fail' || s === 'failed' || s === '未通过' || s === '不通过') return 'fail';
  return s;
}

function flattenRequirementForMatch(req: RequirementsAgentViewItem): string {
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

function extractMatchingScore(robohireData: unknown): number | null {
  // RoboHire real-shape: d.matchScore is always null, real score nests at
  // d.overallMatchScore.score. Reuse the normalizer (same logic as
  // saveMatchResultsToPartnerPg) so event routing and DB write agree.
  if (!robohireData || typeof robohireData !== 'object') return null;
  const { inner } = resolveMatchPayload(robohireData as Record<string, unknown>);
  const s = (inner as { matchScore?: unknown }).matchScore;
  return typeof s === 'number' ? s : null;
}

/**
 * F3 score → event-name dispatch (2026-05-21 单阈值化):
 *   score < 40 → MATCH_FAILED
 *   其它(含 null) → MATCH_PASSED_NEED_INTERVIEW
 *
 * MATCH_PASSED_NO_INTERVIEW 路径已下线 —— 不再按分数自动免面试,统一让 ≥40
 * 的候选人都进面试环节。
 */
function decideMatchEvent(
  score: number | null,
): 'MATCH_PASSED_NEED_INTERVIEW' | 'MATCH_FAILED' {
  if (score === null) return 'MATCH_PASSED_NEED_INTERVIEW';
  if (score < 40) return 'MATCH_FAILED';
  return 'MATCH_PASSED_NEED_INTERVIEW';
}

function gradeFromScore(score: number | null): string {
  if (score === null) return '未评级';
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}
