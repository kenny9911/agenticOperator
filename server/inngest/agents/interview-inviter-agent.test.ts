// interview-inviter-agent.test.ts — unit tests for interviewInviterAgentHandler.
//
// 2026-05-25: 新 agent,触发 INTERVIEW_INVITATION_REQUESTED,调 RoboHire
// /api/v1/invite-candidate,写 Neo4j Interview_Record + Communication_Log,
// 回发 INTERVIEW_INVITATION_SENT / _FAILED。
//
// Pattern 同 rule-check-agent.test.ts:mock @/server/inngest/client +
// 所有 module-level 依赖,import handler 直接驱动。

import { describe, it, expect, beforeEach, vi } from 'vitest';

// 1) inngest client — 阻止 createFunction 真注册。
vi.mock('@/server/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((cfg: unknown, handler: unknown) => ({ cfg, handler })),
  },
}));

// 2) RoboHire 客户端
vi.mock('@/lib/robohire-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/robohire-client')>(
    '@/lib/robohire-client',
  );
  return {
    ...actual,
    inviteCandidateDirect: vi.fn(),
  };
});

// 3) Allmeta writers — 双写 Neo4j
vi.mock('@/lib/allmeta-writers', () => ({
  writeCommunicationLogInstance: vi.fn(async () => ({ ok: true, instance: {} })),
  writeInterviewRecordInstance: vi.fn(async () => ({ ok: true, instance: {} })),
}));

// 4) partner-pg backfill + interview_invitation UPDATE
vi.mock('@/lib/partner-pg/parsed-resume', () => ({
  getParsedResume: vi.fn(),
}));
vi.mock('@/lib/partner-pg/requirements', () => ({
  getRequirementDetail: vi.fn(),
}));
vi.mock('@/lib/partner-pg/interview-invitations', () => ({
  markInterviewInvitationSent: vi.fn(async () => ({ ok: true, updated: true })),
}));

// 5) agent-logger — runWithLogger 必须 unwrap callback;createAgentLogger
//    返回带 event() 方法的对象。
vi.mock('@/lib/agent-logger', () => ({
  createAgentLogger: vi.fn(() => ({
    event: vi.fn(),
    apiCall: vi.fn(),
  })),
  runWithLogger: vi.fn(async (_l: unknown, fn: () => unknown) => fn()),
  currentLogger: vi.fn(() => ({
    event: vi.fn(),
    apiCall: vi.fn(),
  })),
}));

// 6) 业务里程碑通知 — 不 mock 会把"面试邀约已发送"写进真 Postgres
//    (2026-06-11 审计:413 条 r1 测试残留的成因)。Pattern 同 rule-check-agent.test.ts。
const notifyRecruitmentLifecycle = vi.fn(async (_step: unknown, _signal: unknown, _ctx: unknown) => {});
vi.mock('@/server/notifications/recruitment-lifecycle', () => ({
  notifyRecruitmentLifecycle: (step: unknown, signal: unknown, ctx: unknown) =>
    notifyRecruitmentLifecycle(step, signal, ctx),
}));
const recordNotification = vi.fn(async (_input: unknown) => ({ id: 'n1' }));
vi.mock('@/server/notifications/ingest', () => ({
  recordNotification: (input: unknown) => recordNotification(input),
}));

// 7) dependency-health — recordDependencySignal 直写真 LogEvent,测试跑出的
//    "降级"信号会被 live sweeper 判成真告警(2026-06-11 审计:'RoboHire 额度
//    不足' r1 残留的成因)。用模块自带的 DI 注 noop recordLogEvent,throw/park
//    语义原样保留。
vi.mock('@/lib/dependency-health/report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dependency-health/report')>();
  const noopLog = { recordLogEvent: async () => {} };
  return {
    ...actual,
    recordDependencySignal: (o: never, ctx: never) => actual.recordDependencySignal(o, ctx, noopLog),
    reportDependencyDegraded: (o: never, ctx: never) => actual.reportDependencyDegraded(o, ctx, noopLog),
  };
});

import { interviewInviterAgentHandler } from './interview-inviter-agent';
import { inviteCandidateDirect, RobohireApiError } from '@/lib/robohire-client';
import {
  writeCommunicationLogInstance,
  writeInterviewRecordInstance,
} from '@/lib/allmeta-writers';
import { getParsedResume } from '@/lib/partner-pg/parsed-resume';
import { getRequirementDetail } from '@/lib/partner-pg/requirements';
import { markInterviewInvitationSent } from '@/lib/partner-pg/interview-invitations';

const mockInvite = inviteCandidateDirect as ReturnType<typeof vi.fn>;
const mockWriteComm = writeCommunicationLogInstance as ReturnType<typeof vi.fn>;
const mockWriteIvr = writeInterviewRecordInstance as ReturnType<typeof vi.fn>;
const mockGetParsedResume = getParsedResume as ReturnType<typeof vi.fn>;
const mockGetRequirementDetail = getRequirementDetail as ReturnType<typeof vi.fn>;
const mockMarkSent = markInterviewInvitationSent as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ── helpers ────────────────────────────────────────────────────────────

type StepCalls = {
  runs: Array<{ key: string; fn: () => Promise<unknown> }>;
  events: Array<{ key: string; payload: { name: string; data: any } }>;
};

function fakeStep(): { step: any; calls: StepCalls } {
  const calls: StepCalls = { runs: [], events: [] };
  const step = {
    run: async (key: string, fn: () => Promise<unknown>) => {
      calls.runs.push({ key, fn });
      return await fn();
    },
    sendEvent: async (key: string, payload: { name: string; data: any }) => {
      calls.events.push({ key, payload });
    },
  };
  return { step, calls };
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function envelope(payload: Record<string, unknown>) {
  return {
    name: 'INTERVIEW_INVITATION_REQUESTED',
    data: {
      entity_type: 'Candidate',
      entity_id: payload.candidate_id ?? null,
      event_id: 'evt_test',
      payload,
      trace: { trace_id: 'trace-test' },
    },
  };
}

// ── tests ──────────────────────────────────────────────────────────────

describe('interviewInviterAgentHandler — happy path', () => {
  it('调 RoboHire → 写 Comm_Log + Interview_Record → UPDATE partner-pg interview_invitation → emit _SENT', async () => {
    const robohireResponse = {
      success: true,
      data: {
        login_url: 'https://gohire.top/i/abc',
        qrcode_url: 'https://gohire.top/qr/abc.png',
        user_id: 1234,
        request_introduction_id: 'rii_xyz',
        gohire_job_id: 'gh_42',
        email: 'cand@example.com',
        job_interview_duration: 30,
      },
      requestId: 'req_invite_1',
    };
    mockInvite.mockResolvedValueOnce(robohireResponse);

    const { step, calls } = fakeStep();
    const event = envelope({
      candidate_id: 'C1',
      job_requisition_id: 'JR1',
      application_id: 'APP1',
      recruiter_id: 'EMP_TEST',
      correlation_id: 'corr_abc_123',
      resume_text: 'resume text body',
      jd_text: 'jd text body',
      interview_language: 'zh',
      interview_duration: 30,
    });

    const out = await interviewInviterAgentHandler({
      event,
      step,
      logger: fakeLogger(),
      runId: 'r1',
    });

    expect(out).toMatchObject({ ok: true, candidate_id: 'C1', job_requisition_id: 'JR1' });
    expect(mockInvite).toHaveBeenCalledTimes(1);
    expect(mockWriteComm).toHaveBeenCalledTimes(1);
    expect(mockWriteIvr).toHaveBeenCalledTimes(1);

    // 不应有 backfill(payload 已给了 resume_text + jd_text)
    expect(mockGetParsedResume).not.toHaveBeenCalled();
    expect(mockGetRequirementDetail).not.toHaveBeenCalled();

    // partner-pg interview_invitation UPDATE 按 correlation_id 调一次,字段 1:1 透传
    expect(mockMarkSent).toHaveBeenCalledTimes(1);
    expect(mockMarkSent).toHaveBeenCalledWith('corr_abc_123', {
      login_url: 'https://gohire.top/i/abc',
      qrcode_url: 'https://gohire.top/qr/abc.png',
      gohire_user_id: 1234,
      request_introduction_id: 'rii_xyz',
      gohire_invite_log: JSON.stringify(robohireResponse),
    });

    // 只 emit _SENT,无 _FAILED
    const emits = calls.events.map((e) => e.payload.name);
    expect(emits).toEqual(['INTERVIEW_INVITATION_SENT']);

    const sent = calls.events[0].payload.data.payload;
    expect(sent).toMatchObject({
      candidate_id: 'C1',
      job_requisition_id: 'JR1',
      application_id: 'APP1',
      correlation_id: 'corr_abc_123',
      login_url: 'https://gohire.top/i/abc',
      qrcode_url: 'https://gohire.top/qr/abc.png',
      user_id: 1234,
      gohire_job_id: 'gh_42',
      candidate_email: 'cand@example.com',
      interview_duration_minutes: 30,
      robohire_request_id: 'req_invite_1',
    });
    expect(sent.interview_record_id).toBe('ivr_C1_JR1_inv');
    expect(sent.communication_log_id).toMatch(/^comm_invite_C1_JR1_\d+$/);
  });

  it('payload 缺 correlation_id → 跳过 partner-pg UPDATE,仍 emit _SENT', async () => {
    mockInvite.mockResolvedValueOnce({
      success: true,
      data: { login_url: 'https://x', user_id: 1 },
      requestId: 'r_no_corr',
    });
    const { step, calls } = fakeStep();
    const out = await interviewInviterAgentHandler({
      event: envelope({
        candidate_id: 'C2',
        job_requisition_id: 'JR2',
        resume_text: 'r',
        jd_text: 'j',
        // 故意不带 correlation_id
      }),
      step,
      logger: fakeLogger(),
      runId: 'r1',
    });
    expect(out).toMatchObject({ ok: true });
    expect(mockMarkSent).not.toHaveBeenCalled();
    const emits = calls.events.map((e) => e.payload.name);
    expect(emits).toEqual(['INTERVIEW_INVITATION_SENT']);
    expect(calls.events[0].payload.data.payload.correlation_id).toBeNull();
  });

  it('partner-pg UPDATE 命中 0 行 → soft-fail,仍 emit _SENT', async () => {
    mockInvite.mockResolvedValueOnce({
      success: true,
      data: { login_url: 'https://x', user_id: 1 },
      requestId: 'r_no_row',
    });
    mockMarkSent.mockResolvedValueOnce({ ok: true, updated: false });
    const { step, calls } = fakeStep();
    const out = await interviewInviterAgentHandler({
      event: envelope({
        candidate_id: 'C3',
        job_requisition_id: 'JR3',
        correlation_id: 'corr_orphan',
        resume_text: 'r',
        jd_text: 'j',
      }),
      step,
      logger: fakeLogger(),
      runId: 'r1',
    });
    expect(out).toMatchObject({ ok: true });
    expect(mockMarkSent).toHaveBeenCalledTimes(1);
    const emits = calls.events.map((e) => e.payload.name);
    expect(emits).toEqual(['INTERVIEW_INVITATION_SENT']);
  });

  it('partner-pg UPDATE 抛错 → soft-fail,仍 emit _SENT', async () => {
    mockInvite.mockResolvedValueOnce({
      success: true,
      data: { login_url: 'https://x', user_id: 1 },
      requestId: 'r_pg_err',
    });
    mockMarkSent.mockResolvedValueOnce({ ok: false, error: 'connection refused' });
    const { step, calls } = fakeStep();
    const out = await interviewInviterAgentHandler({
      event: envelope({
        candidate_id: 'C4',
        job_requisition_id: 'JR4',
        correlation_id: 'corr_err',
        resume_text: 'r',
        jd_text: 'j',
      }),
      step,
      logger: fakeLogger(),
      runId: 'r1',
    });
    expect(out).toMatchObject({ ok: true });
    const emits = calls.events.map((e) => e.payload.name);
    expect(emits).toEqual(['INTERVIEW_INVITATION_SENT']);
  });
});

describe('interviewInviterAgentHandler — backfill paths', () => {
  it('payload thin → backfill resume_text from partner-pg', async () => {
    mockGetParsedResume.mockResolvedValueOnce({
      candidate_id: 'C1',
      resume_id: 'R1',
      parsed_content: 'backfilled resume body',
      data: { name: '张三' },
    });
    mockInvite.mockResolvedValueOnce({
      data: { login_url: 'https://gohire.top/i/x', user_id: 1 },
      requestId: 'r1',
    });

    const { step } = fakeStep();
    await interviewInviterAgentHandler({
      event: envelope({
        candidate_id: 'C1',
        job_requisition_id: 'JR1',
        resume_id: 'R1',
        jd_text: 'jd body',
      }),
      step,
      logger: fakeLogger(),
      runId: 'r1',
    });

    expect(mockGetParsedResume).toHaveBeenCalledWith('C1', 'R1');
    expect(mockInvite).toHaveBeenCalledTimes(1);
    const inviteArg = mockInvite.mock.calls[0][0] as { resume?: string };
    expect(inviteArg.resume).toBe('backfilled resume body');
  });

  it('payload 缺 resume_id 又缺 resume_text → emit _FAILED BACKFILL_FAILED + NonRetriable', async () => {
    const { step, calls } = fakeStep();
    await expect(
      interviewInviterAgentHandler({
        event: envelope({
          candidate_id: 'C1',
          job_requisition_id: 'JR1',
          jd_text: 'jd body',
          // 故意不带 resume_text / resume_id / robohire_resume_id
        }),
        step,
        logger: fakeLogger(),
        runId: 'r1',
      }),
    ).rejects.toThrow();
    expect(mockInvite).not.toHaveBeenCalled();
    const failedEmit = calls.events.find(
      (e) => e.payload.name === 'INTERVIEW_INVITATION_FAILED',
    );
    expect(failedEmit?.payload.data.payload).toMatchObject({
      candidate_id: 'C1',
      job_requisition_id: 'JR1',
      error_code: 'BACKFILL_FAILED',
    });
  });

  it('robohire_resume_id 直传 → 不走 partner-pg backfill', async () => {
    mockInvite.mockResolvedValueOnce({
      data: { login_url: 'https://x', user_id: 1 },
      requestId: 'r1',
    });
    const { step } = fakeStep();
    await interviewInviterAgentHandler({
      event: envelope({
        candidate_id: 'C1',
        job_requisition_id: 'JR1',
        robohire_resume_id: 'rsm_x',
        robohire_job_id: 'job_x',
      }),
      step,
      logger: fakeLogger(),
      runId: 'r1',
    });
    expect(mockGetParsedResume).not.toHaveBeenCalled();
    expect(mockGetRequirementDetail).not.toHaveBeenCalled();
    const inviteArg = mockInvite.mock.calls[0][0] as { resume_id?: string; job_id?: string };
    expect(inviteArg.resume_id).toBe('rsm_x');
    expect(inviteArg.job_id).toBe('job_x');
  });
});

describe('interviewInviterAgentHandler — error paths', () => {
  it('缺 candidate_id → emit _FAILED MISSING_PAYLOAD + NonRetriable', async () => {
    const { step, calls } = fakeStep();
    await expect(
      interviewInviterAgentHandler({
        event: envelope({ job_requisition_id: 'JR1' }),
        step,
        logger: fakeLogger(),
        runId: 'r1',
      }),
    ).rejects.toThrow();
    expect(mockInvite).not.toHaveBeenCalled();
    const failedEmit = calls.events.find(
      (e) => e.payload.name === 'INTERVIEW_INVITATION_FAILED',
    );
    expect(failedEmit?.payload.data.payload.error_code).toBe('MISSING_PAYLOAD');
  });

  it('RoboHire 422(GoHire reject, non-recoverable) → emit _FAILED ROBOHIRE_4XX + 标失败(throws)', async () => {
    mockInvite.mockRejectedValueOnce(
      new RobohireApiError(422, 'CLIENT', 'gohire_invitation_failed', 'req_x'),
    );
    const { step, calls } = fakeStep();
    // Dead-dependency degrade now fails the run instead of returning a green
    // success. A non-recoverable (auth/bad-input) degrade still emits the
    // terminal _FAILED before throwing so downstream is informed.
    await expect(
      interviewInviterAgentHandler({
        event: envelope({
          candidate_id: 'C1',
          job_requisition_id: 'JR1',
          resume_text: 'r',
          jd_text: 'j',
        }),
        step,
        logger: fakeLogger(),
        runId: 'r1',
      }),
    ).rejects.toThrow();
    expect(mockWriteComm).not.toHaveBeenCalled();
    expect(mockWriteIvr).not.toHaveBeenCalled();
    const failedEmit = calls.events.find(
      (e) => e.payload.name === 'INTERVIEW_INVITATION_FAILED',
    );
    expect(failedEmit?.payload.data.payload).toMatchObject({
      error_code: 'ROBOHIRE_4XX',
      http_status: 422,
      robohire_request_id: 'req_x',
    });
  });

  it('RoboHire 402 quota(recoverable) → 标失败(throws) + parks, NO terminal _FAILED (auto-resumes after top-up)', async () => {
    mockInvite.mockRejectedValueOnce(
      new RobohireApiError(402, 'QUOTA_EXHAUSTED', 'out of quota'),
    );
    const { step, calls } = fakeStep();
    // Out-of-funds is recoverable: the run parks (throws retriable) and resumes
    // after a top-up, so we must NOT emit a terminal INTERVIEW_INVITATION_FAILED
    // (it would race a later retry-success).
    await expect(
      interviewInviterAgentHandler({
        event: envelope({
          candidate_id: 'C1',
          job_requisition_id: 'JR1',
          resume_text: 'r',
          jd_text: 'j',
        }),
        step,
        logger: fakeLogger(),
        runId: 'r1',
      }),
    ).rejects.toThrow();
    const failedEmit = calls.events.find(
      (e) => e.payload.name === 'INTERVIEW_INVITATION_FAILED',
    );
    expect(failedEmit).toBeUndefined();
  });

  it('RoboHire 2xx 但 success=false(GoHire upload_resume 失败)→ emit _FAILED GOHIRE_REJECTED 不重试', async () => {
    // 这是 e2e 真实发现的场景:RoboHire 内部把简历转给 GoHire 解析失败 3 次后
    // 返 HTTP 200 + { success: false, error: 'upload_resume failed after 3 attempts' }.
    // handleJsonResponse 抛 RobohireApiError(200, 'SERVER', ...) — 重跑不会有不同结果,
    // 必须分类为 terminal,否则 Inngest run 静默退休,RaaS 永远拿不到 _FAILED.
    mockInvite.mockRejectedValueOnce(
      new RobohireApiError(
        200,
        'SERVER',
        'invite-candidate returned success=false: upload_resume failed after 3 attempts',
        'req_upload_fail',
      ),
    );
    const { step, calls } = fakeStep();
    const out = await interviewInviterAgentHandler({
      event: envelope({
        candidate_id: 'C1',
        job_requisition_id: 'JR1',
        resume_text: 'r',
        jd_text: 'j',
      }),
      step,
      logger: fakeLogger(),
      runId: 'r1',
    });
    expect(out).toMatchObject({ ok: false, error: 'GOHIRE_REJECTED' });
    expect(mockWriteComm).not.toHaveBeenCalled();
    expect(mockWriteIvr).not.toHaveBeenCalled();
    const failed = calls.events.find(
      (e) => e.payload.name === 'INTERVIEW_INVITATION_FAILED',
    );
    expect(failed?.payload.data.payload).toMatchObject({
      error_code: 'GOHIRE_REJECTED',
      http_status: 200,
      robohire_request_id: 'req_upload_fail',
    });
    expect(failed?.payload.data.payload.error_message).toMatch(/upload_resume failed/);
  });

  it('RoboHire 500 → 抛错走 Inngest retry(不 emit _FAILED)', async () => {
    mockInvite.mockRejectedValueOnce(
      new RobohireApiError(500, 'SERVER', 'internal'),
    );
    const { step, calls } = fakeStep();
    await expect(
      interviewInviterAgentHandler({
        event: envelope({
          candidate_id: 'C1',
          job_requisition_id: 'JR1',
          resume_text: 'r',
          jd_text: 'j',
        }),
        step,
        logger: fakeLogger(),
        runId: 'r1',
      }),
    ).rejects.toThrow();
    expect(calls.events.length).toBe(0);
  });

  it('persistenceWarning → 仍写 Neo4j + emit _FAILED PERSISTENCE_WARNING + emit _SENT', async () => {
    mockInvite.mockResolvedValueOnce({
      data: {
        login_url: 'https://x',
        user_id: 1,
        persistenceWarning: 'DB write failed,but invite was sent',
      },
      requestId: 'req_warn',
    });
    const { step, calls } = fakeStep();
    await interviewInviterAgentHandler({
      event: envelope({
        candidate_id: 'C1',
        job_requisition_id: 'JR1',
        resume_text: 'r',
        jd_text: 'j',
      }),
      step,
      logger: fakeLogger(),
      runId: 'r1',
    });
    const emitNames = calls.events.map((e) => e.payload.name);
    expect(emitNames).toContain('INTERVIEW_INVITATION_FAILED');
    expect(emitNames).toContain('INTERVIEW_INVITATION_SENT');
    const failed = calls.events.find(
      (e) => e.payload.name === 'INTERVIEW_INVITATION_FAILED',
    );
    expect(failed?.payload.data.payload.error_code).toBe('PERSISTENCE_WARNING');
    // Neo4j 写应该照常发生(候选人确实拿到了 login_url)
    expect(mockWriteComm).toHaveBeenCalledTimes(1);
    expect(mockWriteIvr).toHaveBeenCalledTimes(1);
  });

  it('RoboHire 200 但无 login_url 且非 reused → emit _FAILED GOHIRE_REJECTED', async () => {
    mockInvite.mockResolvedValueOnce({
      data: { message: 'something went wrong' },
      requestId: 'req_nourl',
    });
    const { step, calls } = fakeStep();
    const out = await interviewInviterAgentHandler({
      event: envelope({
        candidate_id: 'C1',
        job_requisition_id: 'JR1',
        resume_text: 'r',
        jd_text: 'j',
      }),
      step,
      logger: fakeLogger(),
      runId: 'r1',
    });
    expect(out).toMatchObject({ ok: false, error: 'GOHIRE_REJECTED' });
    expect(mockWriteComm).not.toHaveBeenCalled();
    expect(mockWriteIvr).not.toHaveBeenCalled();
    const failed = calls.events.find(
      (e) => e.payload.name === 'INTERVIEW_INVITATION_FAILED',
    );
    expect(failed?.payload.data.payload.error_code).toBe('GOHIRE_REJECTED');
  });
});
