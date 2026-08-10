import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/inngest/client', () => ({
  inngest: { createFunction: vi.fn((cfg: unknown, handler: unknown) => ({ cfg, handler })) },
}));
vi.mock('@/server/inngest/raas-v1', () => ({ skipIfRaasV1Paused: vi.fn(async () => null) }));
vi.mock('@/lib/minio', () => ({ getResumeBuffer: vi.fn(), statResume: vi.fn() }));
vi.mock('@/lib/partner-pg/client', () => ({ isPartnerPgConfigured: vi.fn(() => true) }));
vi.mock('@/lib/partner-pg/candidates', () => ({
  saveCandidateToPartnerPg: vi.fn(async (input: any) => ({
    candidate_id: 'C-DEFERRED',
    resume_id: 'R-DEFERRED',
    application_id: null,
    candidate_expectation_id: null,
    candidate_created: true,
    resume_created: true,
    idempotent_replay: false,
    mobile_normalized:
      input.authoritative_identity?.phone ?? input.parsed?.data?.phone ?? null,
    candidate_lock_snapshot: {
      employee_id: null,
      is_locked: false,
      lock_start_time: null,
    },
    candidate_snapshot: {
      name: input.authoritative_identity?.name ?? input.parsed?.data?.name ?? '未命名候选人',
      mobile: input.authoritative_identity?.phone ?? input.parsed?.data?.phone ?? null,
      mobile_normalized: input.authoritative_identity?.phone ?? input.parsed?.data?.phone ?? null,
      email: null,
      gender: null,
      birth_date: null,
      current_location: null,
      highest_acquired_degree: null,
      work_years: null,
      employee_id: null,
    },
  })),
  markResumeUploadFailed: vi.fn(async () => undefined),
}));
vi.mock('@/lib/allmeta-writers', () => ({
  writeCandidateInstance: vi.fn(async () => ({ ok: true, nameWasPlaceholder: false })),
  writeCandidateExpectationInstance: vi.fn(async () => ({ ok: true })),
  writeResumeInstance: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@/lib/robohire-client', () => ({
  parseResumeDirect: vi.fn(),
  RobohireApiError: class RobohireApiError extends Error {},
}));
vi.mock('@/lib/resume-convert/prepare-resume-pdf', () => ({
  DocumentConversionError: class DocumentConversionError extends Error {},
}));
vi.mock('@/lib/resume-convert/route-conversion-failure', () => ({
  routeDocumentConversionFailure: vi.fn(async () => undefined),
}));
vi.mock('@/lib/mappers/candidate-preferences', () => ({
  extractCandidateExpectation: vi.fn(() => ({
    expected_salary_monthly_min: null,
    expected_salary_monthly_max: null,
    expected_cities: [],
    expected_industries: [],
    expected_roles: [],
    expected_work_mode: null,
  })),
}));
vi.mock('@/lib/dependency-health/classify', () => ({ classifyRobohire: vi.fn() }));
vi.mock('@/lib/dependency-health/report', () => ({ reportDependencyDegraded: vi.fn() }));
vi.mock('@/lib/agent-logger', () => ({
  createAgentLogger: vi.fn(() => ({ event: vi.fn(), apiCall: vi.fn() })),
  runWithLogger: vi.fn(async (_logger: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/server/db', () => ({
  prisma: { agentActivity: { create: vi.fn(async () => ({})) } },
}));
vi.mock('@/server/notifications/recruitment-lifecycle', () => ({
  notifyRecruitmentLifecycle: vi.fn(async () => undefined),
}));
vi.mock('@/lib/candidate-lock/run-lock-check', () => ({ runLockCheck: vi.fn() }));

import { saveCandidateToPartnerPg } from '@/lib/partner-pg/candidates';
import { writeCandidateInstance, writeResumeInstance } from '@/lib/allmeta-writers';
import { runLockCheck } from '@/lib/candidate-lock/run-lock-check';
import { resumeParserAgent } from './resume-parser-agent';

const originalLockCheckEnabled = process.env.LOCK_CHECK_ENABLED;
const originalLockCheckEnforce = process.env.LOCK_CHECK_ENFORCE;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LOCK_CHECK_ENABLED = '1';
  process.env.LOCK_CHECK_ENFORCE = '1';
});

afterEach(() => {
  if (originalLockCheckEnabled === undefined) delete process.env.LOCK_CHECK_ENABLED;
  else process.env.LOCK_CHECK_ENABLED = originalLockCheckEnabled;
  if (originalLockCheckEnforce === undefined) delete process.env.LOCK_CHECK_ENFORCE;
  else process.env.LOCK_CHECK_ENFORCE = originalLockCheckEnforce;
});

describe('resumeParserAgent rmhr_deferred', () => {
  it('rejects a malformed deferred contract before persistence', async () => {
    const handler = (resumeParserAgent as unknown as {
      handler: (input: Record<string, unknown>) => Promise<unknown>;
    }).handler;

    await expect(
      handler({
        event: {
          name: 'RESUME_DOWNLOADED',
          data: {
            payload: {
              upload_id: 'UP-BAD',
              bucket: 'resumes',
              object_key: 'incoming/bad.pdf',
              contract_version: 2,
              processing_mode: 'rmhr_deferred',
              processing_reason: 'rmhr_email_not_found',
              operator_id: null,
            },
          },
        },
        step: { run: vi.fn(), sendEvent: vi.fn() },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toThrow(/operator_id/);
    expect(saveCandidateToPartnerPg).not.toHaveBeenCalled();
  });

  it('persists Candidate/Resume without uploader ownership, skips AO lock check, and propagates anchors', async () => {
    const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
    const runIds: string[] = [];
    const handler = (resumeParserAgent as unknown as {
      handler: (input: Record<string, unknown>) => Promise<unknown>;
    }).handler;
    const result = await handler({
      event: {
        name: 'RESUME_DOWNLOADED',
        data: {
          payload: {
            upload_id: 'UP-DEFERRED',
            bucket: 'resumes',
            object_key: 'incoming/deferred.pdf',
            filename: 'deferred.pdf',
            employee_id: null,
            operator_id: 'EMP-OPERATOR',
            job_requisition_id: 'JR-1',
            job_posting_id: 'JP-1',
            contract_version: 2,
            processing_mode: 'rmhr_deferred',
            processing_reason: 'rmhr_email_not_found',
            parsed: { data: { name: 'Deferred Candidate', rawText: 'TypeScript' } },
          },
          trace: { trace_id: 'TRACE-1' },
        },
      },
      step: {
        run: async (id: string, fn: () => Promise<unknown>) => {
          runIds.push(id);
          return fn();
        },
        sendEvent: async (_id: string, event: { name: string; data: Record<string, unknown> }) => {
          sent.push(event);
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runId: 'RUN-1',
    });

    expect(result).toMatchObject({ ok: true, candidate_id: 'C-DEFERRED', resume_id: 'R-DEFERRED' });
    expect(runIds).not.toContain('rmhr-lock-check');
    expect(runLockCheck).not.toHaveBeenCalled();
    expect(saveCandidateToPartnerPg).toHaveBeenCalledWith(
      expect.objectContaining({
        employee_id: 'EMP-OPERATOR',
        locked_by_employee_id: undefined,
        job_requisition_id: 'JR-1',
      }),
    );
    expect(writeCandidateInstance).toHaveBeenCalledWith(
      expect.objectContaining({ employee_id: null, is_locked: false }),
    );
    expect(writeResumeInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate_id: 'C-DEFERRED',
        resume_id: 'R-DEFERRED',
        employee_id: 'EMP-OPERATOR',
      }),
    );
    expect(sent.map((event) => event.name)).toEqual(['RESUME_PROCESSED']);
    const processed = sent.find((event) => event.name === 'RESUME_PROCESSED');
    expect(processed?.data).toMatchObject({
      operator_id: 'EMP-OPERATOR',
      contract_version: 2,
      processing_mode: 'rmhr_deferred',
      processing_reason: 'rmhr_email_not_found',
      job_requisition_id: 'JR-1',
      job_posting_id: 'JP-1',
      candidate_id: 'C-DEFERRED',
      resume_id: 'R-DEFERRED',
    });
  });

  it('keeps RoboHire evidence raw while applying RMHR manual identity to Candidate and downstream', async () => {
    process.env.LOCK_CHECK_ENABLED = '0';
    const sent: Array<{ name: string; data: Record<string, unknown> }> = [];
    const handler = (resumeParserAgent as unknown as {
      handler: (input: Record<string, unknown>) => Promise<unknown>;
    }).handler;

    await handler({
      event: {
        name: 'RESUME_DOWNLOADED',
        data: {
          payload: {
            upload_id: 'UP-MANUAL-IDENTITY',
            bucket: 'resumes',
            object_key: 'incoming/manual-identity.pdf',
            filename: 'manual-identity.pdf',
            operator_id: 'EMP-OPERATOR',
            contract_version: 2,
            processing_mode: 'full',
            processing_reason: null,
            candidate_name: '人工姓名',
            candidate_phone: '13800138000',
            candidate_identity_source: 'rmhr_manual_refill',
            parsed: {
              data: {
                name: null,
                phone: '13900139000',
                rawText: 'original parser evidence',
              },
            },
          },
        },
      },
      step: {
        run: async (_id: string, fn: () => Promise<unknown>) => fn(),
        sendEvent: async (_id: string, event: { name: string; data: Record<string, unknown> }) => {
          sent.push(event);
        },
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runId: 'RUN-MANUAL-IDENTITY',
    });

    expect(saveCandidateToPartnerPg).toHaveBeenCalledWith(
      expect.objectContaining({
        authoritative_identity: {
          source: 'rmhr_manual_refill',
          name: '人工姓名',
          phone: '13800138000',
        },
        parsed: {
          data: {
            name: null,
            phone: '13900139000',
            rawText: 'original parser evidence',
          },
        },
      }),
    );
    expect(writeCandidateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        parsed: {
          name: '人工姓名',
          phone: '13900139000',
          rawText: 'original parser evidence',
        },
        normalized_phone: '13800138000',
        persisted_candidate: null,
      }),
    );
    expect(writeResumeInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        parsed: {
          name: null,
          phone: '13900139000',
          rawText: 'original parser evidence',
        },
      }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(expect.objectContaining({
      name: 'RESUME_PROCESSED',
      data: expect.objectContaining({
        parsed: {
          data: {
            name: null,
            phone: '13900139000',
            rawText: 'original parser evidence',
          },
        },
      }),
    }));
  });

  it('re-mirrors the persisted Candidate snapshot on an idempotent event replay', async () => {
    process.env.LOCK_CHECK_ENABLED = '0';
    const snapshot = {
      name: '已持久化姓名',
      mobile: '13800138000',
      mobile_normalized: '13800138000',
      email: 'stored@example.com',
      gender: '女',
      birth_date: '1990-01-01T00:00:00.000Z',
      current_location: '上海',
      highest_acquired_degree: '本科',
      work_years: 8,
      employee_id: 'EMP-OWNER',
      is_locked: true,
      lock_start_time: '2026-07-01T00:00:00.000Z',
    };
    vi.mocked(saveCandidateToPartnerPg).mockResolvedValueOnce({
      candidate_id: 'C-REPLAY',
      resume_id: 'R-REPLAY',
      application_id: null,
      candidate_expectation_id: null,
      candidate_created: false,
      resume_created: false,
      idempotent_replay: true,
      mobile_normalized: '13800138000',
      mobile_review_status: 'valid',
      candidate_snapshot: snapshot,
      candidate_lock_snapshot: {
        employee_id: 'EMP-OWNER',
        is_locked: true,
        lock_start_time: '2026-07-01T00:00:00.000Z',
      },
    });
    const handler = (resumeParserAgent as unknown as {
      handler: (input: Record<string, unknown>) => Promise<unknown>;
    }).handler;

    await handler({
      event: {
        name: 'RESUME_DOWNLOADED',
        data: {
          payload: {
            upload_id: 'UP-REPLAY',
            bucket: 'resumes',
            object_key: 'incoming/replay.pdf',
            operator_id: 'EMP-OPERATOR',
            parsed: { data: { name: '重放解析姓名', phone: '13900139000' } },
          },
        },
      },
      step: {
        run: async (_id: string, fn: () => Promise<unknown>) => fn(),
        sendEvent: vi.fn(async () => undefined),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runId: 'RUN-REPLAY',
    });

    expect(writeCandidateInstance).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate_id: 'C-REPLAY',
        persisted_candidate: snapshot,
        normalized_phone: '13800138000',
        employee_id: 'EMP-OWNER',
        identity_lock_only: true,
      }),
    );
  });

  it('does not emit RESUME_PROCESSED when an RMHR manual identity mirror fails', async () => {
    process.env.LOCK_CHECK_ENABLED = '0';
    vi.mocked(writeCandidateInstance).mockResolvedValueOnce({
      ok: false,
      error: 'allmeta unavailable',
    });
    const sent = vi.fn(async () => undefined);
    const handler = (resumeParserAgent as unknown as {
      handler: (input: Record<string, unknown>) => Promise<unknown>;
    }).handler;

    await expect(handler({
      event: {
        name: 'RESUME_DOWNLOADED',
        data: {
          payload: {
            upload_id: 'UP-MANUAL-MIRROR-FAIL',
            bucket: 'resumes',
            object_key: 'incoming/manual-mirror-fail.pdf',
            operator_id: 'EMP-OPERATOR',
            candidate_name: '人工姓名',
            candidate_phone: '13800138000',
            candidate_identity_source: 'rmhr_manual_refill',
            parsed: { data: { name: null, phone: null } },
          },
        },
      },
      step: {
        run: async (_id: string, fn: () => Promise<unknown>) => fn(),
        sendEvent: sent,
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      runId: 'RUN-MANUAL-MIRROR-FAIL',
    })).rejects.toThrow(/RMHR manual Candidate mirror failed/);
    expect(sent).not.toHaveBeenCalled();
  });
});
