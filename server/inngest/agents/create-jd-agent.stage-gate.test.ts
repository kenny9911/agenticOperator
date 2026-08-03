// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateJdDirect: vi.fn(),
  getRequirementDetail: vi.fn(),
  getClarificationRecords: vi.fn(),
  getClientContext: vi.fn(),
  fetchOntologyActionRules: vi.fn(),
  writeJobRequisitionInstance: vi.fn(),
  writeJobPostingInstance: vi.fn(),
  syncJdToPartnerPg: vi.fn(),
  notifyRecruitmentLifecycle: vi.fn(),
}));

vi.mock('@/server/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((cfg: unknown, handler: unknown) => ({ cfg, handler })),
  },
}));

vi.mock('@/server/inngest/raas-v1', () => ({
  skipIfRaasV1Paused: vi.fn(async () => false),
}));

vi.mock('@/lib/partner-pg/client', () => ({
  isPartnerPgConfigured: vi.fn(() => true),
}));

vi.mock('@/lib/partner-pg/requirements', () => ({
  getRequirementDetail: mocks.getRequirementDetail,
  getClarificationRecords: mocks.getClarificationRecords,
  getClientContext: mocks.getClientContext,
}));

vi.mock('@/lib/ontology-rules', () => ({
  fetchOntologyActionRules: mocks.fetchOntologyActionRules,
}));

// Keep the real error type and strict stage helper used by classifyRobohire, but
// replace the outbound call so this test can inject a partial vendor response.
vi.mock('@/lib/robohire-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/robohire-client')>(
    '@/lib/robohire-client',
  );
  return { ...actual, generateJdDirect: mocks.generateJdDirect };
});

vi.mock('@/lib/allmeta-writers', () => ({
  writeJobRequisitionInstance: mocks.writeJobRequisitionInstance,
  writeJobPostingInstance: mocks.writeJobPostingInstance,
}));

vi.mock('@/lib/partner-pg/job-posting', () => ({
  syncJdToPartnerPg: mocks.syncJdToPartnerPg,
}));

vi.mock('@/lib/agent-logger', () => ({
  createAgentLogger: vi.fn(() => ({ event: vi.fn(), apiCall: vi.fn() })),
  runWithLogger: vi.fn(async (_logger: unknown, fn: () => unknown) => fn()),
  currentLogger: vi.fn(() => null),
}));

vi.mock('@/server/notifications/recruitment-lifecycle', () => ({
  notifyRecruitmentLifecycle: mocks.notifyRecruitmentLifecycle,
}));

// Preserve production throw/retry semantics while replacing the audit-log writer
// so the regression test never creates a real dependency-degraded LogEvent.
vi.mock('@/lib/dependency-health/report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/dependency-health/report')>();
  const noopLog = { recordLogEvent: async () => {} };
  return {
    ...actual,
    recordDependencySignal: vi.fn((outcome: never, context: never) =>
      actual.recordDependencySignal(outcome, context, noopLog)),
    reportDependencyDegraded: vi.fn((outcome: never, context: never) =>
      actual.reportDependencyDegraded(outcome, context, noopLog)),
  };
});

import { createJdAgent } from './create-jd-agent';
import { reportDependencyDegraded } from '@/lib/dependency-health/report';

type AgentHandler = (ctx: {
  event: { name: string; data: Record<string, unknown> };
  step: {
    run: (key: string, fn: () => Promise<unknown>) => Promise<unknown>;
    sendEvent: ReturnType<typeof vi.fn>;
  };
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
  runId: string;
}) => Promise<unknown>;

const handler = (createJdAgent as unknown as { handler: AgentHandler }).handler;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getRequirementDetail.mockResolvedValue({
    job_requisition_id: 'jr-stage-gate',
    client_id: 'client-stage-gate',
    client_job_title: '高级后端工程师',
    job_responsibility: '负责核心服务开发与交付',
    job_requirement: '本科及以上，五年后端经验',
    specification: null,
  });
  mocks.getClarificationRecords.mockResolvedValue([]);
  mocks.getClientContext.mockResolvedValue(null);
  mocks.fetchOntologyActionRules.mockResolvedValue({
    action: 'createJD',
    domain: 'RAAS-v1',
    ruleCount: 0,
    rules: [],
  });
});

describe('createJdAgent — generate-jd strict stage gate', () => {
  it.each([
    ['parse failed', { parse: 'failed', generate: 'success' }],
    ['generate failed', { parse: 'success', generate: 'failed' }],
    ['stages missing', undefined],
  ])('%s: rejects memoized output without persisting or emitting JD_GENERATED', async (_label, stages) => {
    const memoizedGenerated = {
      data: {
        title: '看似可用的标题',
        description: '即使存在正文，也不得绕过 stage 门禁。',
      },
      ...(stages === undefined ? {} : { meta: { stages } }),
      requestId: 'rh-stage-gate-failed',
    };
    mocks.generateJdDirect.mockResolvedValue(memoizedGenerated);

    const sendEvent = vi.fn();
    const step = {
      run: async (key: string, fn: () => Promise<unknown>) => {
        // Model Inngest replay: a completed generate step returns its historical
        // output and does not execute the newly deployed callback or client gate.
        if (key.startsWith('generate-')) return memoizedGenerated;
        return fn();
      },
      sendEvent,
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await expect(handler({
      event: {
        name: 'REQUIREMENT_LOGGED',
        data: {
          entity_type: 'Job_Requisition',
          entity_id: 'jr-stage-gate',
          trace: { trace_id: 'trace-stage-gate' },
        },
      },
      step,
      logger,
      runId: 'run-stage-gate',
    })).rejects.toThrow(/stage gate failed/);

    expect(mocks.generateJdDirect).not.toHaveBeenCalled();
    expect(reportDependencyDegraded).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        provider: 'robohire',
        op: 'generateJd',
        reason: 'server',
      }),
      expect.any(Object),
    );
    expect(mocks.writeJobRequisitionInstance).not.toHaveBeenCalled();
    expect(mocks.syncJdToPartnerPg).not.toHaveBeenCalled();
    expect(mocks.writeJobPostingInstance).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
    expect(mocks.notifyRecruitmentLifecycle).not.toHaveBeenCalled();
  });
});
