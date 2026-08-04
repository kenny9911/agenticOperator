import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/inngest/client', () => ({
  inngest: { createFunction: vi.fn((cfg: unknown, handler: unknown) => ({ cfg, handler })) },
}));
vi.mock('@/server/inngest/raas-v1', () => ({ skipIfRaasV1Paused: vi.fn(async () => null) }));
vi.mock('@/lib/minio', () => ({ getResumeBuffer: vi.fn(), statResume: vi.fn() }));
vi.mock('@/lib/partner-pg/client', () => ({ isPartnerPgConfigured: vi.fn(() => true) }));
vi.mock('@/lib/partner-pg/candidates', () => ({
  saveCandidateToPartnerPg: vi.fn(async () => ({
    candidate_id: 'C-DEFERRED',
    resume_id: 'R-DEFERRED',
    application_id: null,
    candidate_expectation_id: null,
    candidate_created: true,
    resume_created: true,
    idempotent_replay: false,
    mobile_normalized: null,
    candidate_lock_snapshot: {
      employee_id: null,
      is_locked: false,
      lock_start_time: null,
    },
    candidate_snapshot: { candidate_id: 'C-DEFERRED', employee_id: null },
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
});
