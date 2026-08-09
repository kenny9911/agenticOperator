import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/inngest/client', () => ({
  inngest: {
    createFunction: vi.fn((config: unknown, handler: unknown) => ({ config, handler })),
  },
}));

vi.mock('@/lib/agent-logger', () => ({
  createAgentLogger: vi.fn(() => ({
    event: vi.fn(),
    apiCall: vi.fn(),
  })),
  runWithLogger: vi.fn(async (_logger: unknown, fn: () => unknown) => fn()),
}));

import { decideRecruiterDispatch } from '@/lib/recruiter-dispatch/decision';
import type { DispatchCandidate, DispatchContext, DispatchDecision } from '@/lib/recruiter-dispatch/types';
import { RecruiterDispatchApiError } from '@/server/raas/recruiter-dispatch-client';
import {
  createDispatchDecisionId,
  createTeamAssignmentDecisionId,
  taskAssignerAgent,
  taskAssignerAgentHandler,
} from './task-assigner-agent';

type FakeStepCalls = {
  runs: string[];
  sleeps: Array<{ key: string; until: Date }>;
  events: Array<{
    key: string;
    payload: { name: string; data: Record<string, unknown> };
  }>;
  sequence: string[];
};

type RunInterceptor = (
  key: string,
  fn: () => Promise<unknown> | unknown,
) => Promise<unknown> | unknown;

function fakeStep(interceptor?: RunInterceptor): { step: any; calls: FakeStepCalls } {
  const calls: FakeStepCalls = {
    runs: [],
    sleeps: [],
    events: [],
    sequence: [],
  };

  return {
    calls,
    step: {
      run: async (key: string, fn: () => Promise<unknown> | unknown) => {
        calls.runs.push(key);
        calls.sequence.push(`run:${key}`);
        return interceptor ? await interceptor(key, fn) : await fn();
      },
      sleepUntil: async (key: string, until: Date) => {
        calls.sleeps.push({ key, until });
        calls.sequence.push(`sleepUntil:${key}`);
      },
      sendEvent: async (
        key: string,
        payload: { name: string; data: Record<string, unknown> },
      ) => {
        calls.events.push({ key, payload });
        calls.sequence.push(`sendEvent:${key}`);
      },
    },
  };
}

function jdApprovedEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'JD_APPROVED',
    data: {
      entity_type: 'Job_Requisition',
      entity_id: 'JR-1',
      event_id: 'evt-jd-approved-1',
      payload: {
        job_requisition_id: 'JR-1',
        jd_id: 'JP-1',
      },
      trace: { trace_id: 'trace-1' },
      ...overrides,
    },
  };
}

function candidate(
  recruiterId: string,
  overrides: Partial<DispatchCandidate> = {},
): DispatchCandidate {
  return {
    recruiter_id: recruiterId,
    responsibility: {
      level: 'department_primary',
      priority: 400,
      responsibility_id: `RESP-${recruiterId}`,
    },
    capabilities: [
      {
        capability_id: `CAP-${recruiterId}`,
        taxonomy_level: 'role',
        family: 'FAMILY-DEV',
        group: 'GROUP-FRONTEND',
        sequence: 'SEQUENCE-WEB',
        standard_job_role_id: 'ROLE-WEB',
        scope_key: 'role:ROLE-WEB',
        skill_tags: ['Vue'],
        status: 'confirmed',
        source_type: 'manual',
      },
    ],
    job_capability: {
      status: 'confirmed_match',
      matched_scope_keys: ['role:ROLE-WEB'],
      matched_taxonomy_levels: ['role'],
      skill_tag_overlap: ['Vue'],
    },
    auto_claim_preference: 'absent',
    eligibility: {
      has_recruiter_role: true,
      is_active: true,
      permission: 'allowed',
      bg_boundary: 'allowed',
      availability: 'available',
      available_at: null,
      capacity: 'available',
      suspension: 'clear',
      manual_lock: 'clear',
      dispatchable: true,
      block_reasons: [],
    },
    ...overrides,
  };
}

function activeClaim(recruiterId: string, suffix = recruiterId) {
  return {
    claim_id: `CLAIM-${suffix}`,
    recruiter_id: recruiterId,
    claimed_at: '2026-08-01T00:00:00.000Z',
  };
}

function dispatchContext(input: {
  contextVersion?: string;
  candidates?: DispatchCandidate[];
  activeRecruiterIds?: string[];
  targetSize?: 2 | 3 | 4;
  rulesStatus?: 'ready' | 'suggestion_only';
  legacyWriterDisabled?: boolean;
  jobRequisitionId?: string;
} = {}): DispatchContext {
  return {
    contract_version: 2,
    context_version: input.contextVersion ?? 'ctx-v2-1',
    rules_status: input.rulesStatus ?? 'ready',
    write_guards: {
      legacy_auto_claim_disabled: input.legacyWriterDisabled ?? true,
    },
    requirement: {
      job_requisition_id: input.jobRequisitionId ?? 'JR-1',
      client_id: 'CLIENT-1',
      client_department_id: 'DEPT-1',
      csi_department_id: 'CSI-1',
      service_bg: 'BG-1',
      bg_id: 'BG-1',
      latest_safe_start_at: '2026-08-10T00:00:00.000Z',
      required_capability: {
        family: 'FAMILY-DEV',
        group: 'GROUP-FRONTEND',
        sequence: 'SEQUENCE-WEB',
        standard_job_role_id: 'ROLE-WEB',
        skill_tags: ['Vue'],
      },
      team_policy: {
        minimum_size: 2,
        maximum_size: 4,
        target_size: input.targetSize ?? 2,
      },
      active_recruiter_claims: (input.activeRecruiterIds ?? []).map((id) =>
        activeClaim(id),
      ),
    },
    candidates: input.candidates ?? [candidate('RECRUITER-B'), candidate('RECRUITER-A')],
  };
}

function assignmentResponse(
  input: any,
  status: 'assigned' | 'already_satisfied' | 'already_applied' | 'resource_gap' = 'assigned',
) {
  const recruiterIds = input.assignments.map((assignment: any) =>
    assignment.recruiter_employee_id,
  );
  return {
    contract_version: 2 as const,
    status,
    decision_id: input.decision_id,
    context_version: `${input.expected_context_version}-written`,
    claims: recruiterIds.map((recruiterId: string) => activeClaim(recruiterId)),
    active_recruiter_ids: recruiterIds,
    team_status: {
      minimum_size: 2 as const,
      maximum_size: 4 as const,
      target_size: input.team_policy.target_size,
      active_count: recruiterIds.length,
      minimum_met: recruiterIds.length >= 2,
      target_met: recruiterIds.length >= input.team_policy.target_size,
      added_count: status === 'assigned' ? recruiterIds.length : 0,
    },
  };
}

function injectedDependencies(overrides: Record<string, unknown> = {}) {
  return {
    loadContext: vi.fn(async () => dispatchContext()),
    decide: vi.fn((context: DispatchContext, now?: Date) =>
      decideRecruiterDispatch(context, now),
    ),
    apply: vi.fn(async (_jobRequisitionId: string, input: any) =>
      assignmentResponse(input),
    ),
    now: vi.fn(() => new Date('2026-08-02T01:00:00.000Z')),
    mode: vi.fn(() => 'auto' as const),
    policyVersion: vi.fn(() => 'policy-test-v2'),
    legacyAutoClaimDisabled: vi.fn(() => true),
    ...overrides,
  };
}

const inngestLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function runHandler(
  dependencies: ReturnType<typeof injectedDependencies>,
  options: {
    event?: Record<string, unknown>;
    runId?: string;
    interceptor?: RunInterceptor;
  } = {},
) {
  const { step, calls } = fakeStep(options.interceptor);
  const result = await taskAssignerAgentHandler(
    {
      event: options.event ?? jdApprovedEvent(),
      step,
      logger: inngestLogger,
      runId: options.runId ?? 'run-1',
    },
    dependencies as any,
  );
  return { result, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('taskAssignerAgent v2 function contract', () => {
  it('按 event_id 幂等并以 JR 串行处理 JD_APPROVED', () => {
    expect((taskAssignerAgent as any).config).toMatchObject({
      id: 'task-assigner-agent',
      retries: 2,
      idempotency: 'event.data.event_id',
      concurrency: {
        key:
          'has(event.data.payload.job_requisition_id) ? ' +
          'event.data.payload.job_requisition_id : event.data.entity_id',
        limit: 1,
      },
      triggers: [{ event: 'JD_APPROVED' }],
    });
  });
});

describe('taskAssignerAgentHandler v2', () => {
  it('disabled 模式不读取上下文、不规划也不写 RAAS', async () => {
    const dependencies = injectedDependencies({ mode: vi.fn(() => 'disabled' as const) });

    const { result, calls } = await runHandler(dependencies);

    expect(result).toMatchObject({ ok: true, mode: 'disabled', outcome: 'disabled' });
    expect(dependencies.loadContext).not.toHaveBeenCalled();
    expect(dependencies.decide).not.toHaveBeenCalled();
    expect(dependencies.apply).not.toHaveBeenCalled();
    expect(calls.runs).toEqual([]);
    expect(calls.events).toEqual([]);
  });

  it('shadow 模式读取 v2 context 并在 step 外重算，但零写入、零事件', async () => {
    const dependencies = injectedDependencies({ mode: vi.fn(() => 'shadow' as const) });

    const { result, calls } = await runHandler(dependencies);

    expect(result).toMatchObject({
      ok: true,
      mode: 'shadow',
      outcome: 'shadow',
      decision: {
        contract_version: 2,
        outcome: 'auto_assign_team',
        additions: [
          { recruiter_id: 'RECRUITER-A' },
          { recruiter_id: 'RECRUITER-B' },
        ],
      },
      emitted_event: null,
    });
    expect(dependencies.decide).toHaveBeenCalledTimes(2);
    expect(dependencies.apply).not.toHaveBeenCalled();
    expect(calls.runs).toEqual([
      'v2-load-dispatch-context-JR-1',
      'v2-plan-recruiter-team-JR-1',
    ]);
    expect(calls.events).toEqual([]);
  });

  it('已有一名 active recruiter 时只补一人，并 canonical POST 一次 /assign-team', async () => {
    const context = dispatchContext({
      activeRecruiterIds: ['RECRUITER-A'],
      candidates: [candidate('RECRUITER-A'), candidate('RECRUITER-B')],
    });
    const dependencies = injectedDependencies({
      loadContext: vi.fn(async () => context),
    });

    const { result, calls } = await runHandler(dependencies);
    const expectedBatchId = createTeamAssignmentDecisionId({
      jobRequisitionId: 'JR-1',
      policyVersion: 'policy-test-v2',
      contextVersion: 'ctx-v2-1',
      recruiterIds: ['RECRUITER-B'],
    });

    expect(result).toMatchObject({
      ok: true,
      mode: 'auto',
      outcome: 'assigned',
      assignment_decision_id: expectedBatchId,
      recruiter_ids: ['RECRUITER-B'],
      emitted_event: null,
    });
    expect(dependencies.apply).toHaveBeenCalledTimes(1);
    expect(dependencies.apply).toHaveBeenCalledWith(
      'JR-1',
      {
        contract_version: 2,
        decision_id: expectedBatchId,
        expected_context_version: 'ctx-v2-1',
        dispatch_mode: 'auto',
        policy_version: 'policy-test-v2',
        team_policy: { minimum_size: 2, maximum_size: 4, target_size: 2 },
        assignments: [
          expect.objectContaining({
            recruiter_employee_id: 'RECRUITER-B',
            available_at: null,
          }),
        ],
      },
      { traceId: 'trace-1' },
    );
    expect(calls.runs.slice(0, 2)).toEqual([
      'v2-load-dispatch-context-JR-1',
      'v2-plan-recruiter-team-JR-1',
    ]);
    expect(calls.runs[2]).toMatch(/^v2-assign-recruiter-team-JR-1-/);
    expect(calls.runs.every((key) => key.startsWith('v2-'))).toBe(true);
    expect(calls.events).toEqual([]);
  });

  it('不足 minimum 或 active 已满足 target 时均零写', async () => {
    const shortage = injectedDependencies({
      loadContext: vi.fn(async () =>
        dispatchContext({ candidates: [candidate('RECRUITER-ONLY')] }),
      ),
    });
    const shortageRun = await runHandler(shortage);
    expect(shortageRun.result).toMatchObject({
      outcome: 'resource_gap',
      write_skipped: true,
    });
    expect(shortage.apply).not.toHaveBeenCalled();

    const complete = injectedDependencies({
      loadContext: vi.fn(async () =>
        dispatchContext({ activeRecruiterIds: ['RECRUITER-A', 'RECRUITER-B'] }),
      ),
    });
    const completeRun = await runHandler(complete);
    expect(completeRun.result).toMatchObject({
      outcome: 'team_complete',
      write_skipped: true,
    });
    expect(complete.apply).not.toHaveBeenCalled();
    expect(shortageRun.calls.events).toEqual([]);
    expect(completeRun.calls.events).toEqual([]);
  });

  it('scheduled 仅等待一次，醒后重读并只写当前 available 团队', async () => {
    const scheduledFor = '2026-08-02T02:00:00.000Z';
    const before = dispatchContext({
      contextVersion: 'ctx-before-wait',
      candidates: [
        candidate('RECRUITER-A'),
        candidate('RECRUITER-B', {
          eligibility: {
            ...candidate('base').eligibility,
            availability: 'scheduled',
            available_at: scheduledFor,
            dispatchable: false,
            block_reasons: ['availability_scheduled'],
          },
        }),
      ],
    });
    const after = dispatchContext({
      contextVersion: 'ctx-after-wait',
      candidates: [candidate('RECRUITER-A'), candidate('RECRUITER-B')],
    });
    const loadContext = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const dependencies = injectedDependencies({ loadContext });

    const { result, calls } = await runHandler(dependencies);

    expect(result).toMatchObject({ ok: true, outcome: 'assigned' });
    expect(calls.sleeps).toEqual([
      {
        key: 'v2-wait-recruiter-team-minimum-JR-1',
        until: new Date(scheduledFor),
      },
    ]);
    expect(loadContext).toHaveBeenCalledTimes(2);
    expect(dependencies.apply).toHaveBeenCalledTimes(1);
    expect(dependencies.apply.mock.calls[0][1].expected_context_version).toBe(
      'ctx-after-wait',
    );
    expect(calls.runs).toEqual(
      expect.arrayContaining([
        'v2-reload-dispatch-context-JR-1-after-wait',
        'v2-plan-recruiter-team-JR-1-after-wait',
      ]),
    );
    expect(calls.events).toEqual([]);
  });

  it('醒后仍只得到 scheduled 计划时不二次等待，终止为 resource_gap', async () => {
    const scheduled = dispatchContext({
      candidates: [
        candidate('RECRUITER-A'),
        candidate('RECRUITER-B', {
          eligibility: {
            ...candidate('base').eligibility,
            availability: 'scheduled',
            available_at: '2026-08-02T02:00:00.000Z',
            dispatchable: false,
            block_reasons: ['availability_scheduled'],
          },
        }),
      ],
    });
    const dependencies = injectedDependencies({
      loadContext: vi.fn(async () => scheduled),
    });

    const { result, calls } = await runHandler(dependencies);

    expect(result).toMatchObject({
      outcome: 'resource_gap',
      write_skipped: true,
      reason: 'wait-refresh-still-below-minimum',
    });
    expect(calls.sleeps).toHaveLength(1);
    expect(dependencies.loadContext).toHaveBeenCalledTimes(2);
    expect(dependencies.apply).not.toHaveBeenCalled();
    expect(calls.events).toEqual([]);
  });

  it('memoized v1 context 在 step 外重新解析并失败关闭', async () => {
    const oldContext = {
      context_version: 'ctx-v1',
      rules_status: 'available',
      requirement: { has_existing_recruiter_claim: false },
      candidates: [],
    };
    const dependencies = injectedDependencies();
    const { step, calls } = fakeStep((key, fn) =>
      key === 'v2-load-dispatch-context-JR-1' ? oldContext : fn(),
    );

    await expect(
      taskAssignerAgentHandler(
        { event: jdApprovedEvent(), step, logger: inngestLogger, runId: 'run-old-context' },
        dependencies as any,
      ),
    ).rejects.toMatchObject({ name: 'NonRetriableError' });
    expect(dependencies.loadContext).not.toHaveBeenCalled();
    expect(dependencies.decide).not.toHaveBeenCalled();
    expect(dependencies.apply).not.toHaveBeenCalled();
    expect(calls.runs).toEqual(['v2-load-dispatch-context-JR-1']);
  });

  it('memoized v1 单人 decision 被忽略，step 外按当前代码重算团队', async () => {
    const oldSingleDecision = {
      context_version: 'ctx-v2-1',
      outcome: 'auto_assign',
      selected: { recruiter_id: 'RECRUITER-OLD' },
    };
    const dependencies = injectedDependencies();

    const { result, calls } = await runHandler(dependencies, {
      interceptor: (key, fn) =>
        key === 'v2-plan-recruiter-team-JR-1' ? oldSingleDecision : fn(),
    });

    expect(result).toMatchObject({
      outcome: 'assigned',
      recruiter_ids: ['RECRUITER-A', 'RECRUITER-B'],
    });
    expect(dependencies.decide).toHaveBeenCalledTimes(1);
    expect(dependencies.apply).toHaveBeenCalledTimes(1);
    expect(calls.events).toEqual([]);
  });

  it('step 外当前决策若仍是旧 selected shape，硬闸阻止任何写入', async () => {
    const oldDecision = {
      context_version: 'ctx-v2-1',
      outcome: 'auto_assign',
      selected: { recruiter_id: 'RECRUITER-A' },
    };
    const dependencies = injectedDependencies({
      decide: vi.fn(() => oldDecision),
    });

    await expect(runHandler(dependencies)).rejects.toMatchObject({
      name: 'NonRetriableError',
    });
    expect(dependencies.apply).not.toHaveBeenCalled();
  });

  it('唯一一次 stale 409 会重读重算，并用新 context 和新 batch id 再写一次', async () => {
    const first = dispatchContext({
      contextVersion: 'ctx-before-stale',
      candidates: [candidate('RECRUITER-A'), candidate('RECRUITER-B')],
    });
    const second = dispatchContext({
      contextVersion: 'ctx-after-stale',
      activeRecruiterIds: ['RECRUITER-A'],
      candidates: [candidate('RECRUITER-A'), candidate('RECRUITER-C')],
    });
    const loadContext = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const apply = vi
      .fn()
      .mockRejectedValueOnce(
        new RecruiterDispatchApiError(
          409,
          'CONTEXT_VERSION_STALE',
          'stale',
          {},
          'ctx-after-stale',
        ),
      )
      .mockImplementationOnce(async (_jobRequisitionId: string, input: any) =>
        assignmentResponse(input),
      );
    const dependencies = injectedDependencies({ loadContext, apply });
    const persistedAssignmentSteps: unknown[] = [];

    const { result, calls } = await runHandler(dependencies, {
      interceptor: async (key, fn) => {
        const value = await fn();
        if (!key.startsWith('v2-assign-recruiter-team-')) return value;
        // Real Inngest memoizes successful step data. JSON round-tripping here
        // proves stale does not depend on a custom Error prototype surviving.
        const persisted = JSON.parse(JSON.stringify(value)) as unknown;
        persistedAssignmentSteps.push(persisted);
        return persisted;
      },
    });

    expect(result).toMatchObject({
      ok: true,
      outcome: 'assigned',
      recruiter_ids: ['RECRUITER-C'],
    });
    expect(loadContext).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[0][1].expected_context_version).toBe('ctx-before-stale');
    expect(apply.mock.calls[1][1].expected_context_version).toBe('ctx-after-stale');
    expect(apply.mock.calls[0][1].decision_id).not.toBe(
      apply.mock.calls[1][1].decision_id,
    );
    expect(persistedAssignmentSteps).toEqual([
      { kind: 'stale', current_context_version: 'ctx-after-stale' },
      { kind: 'response', response: assignmentResponse(apply.mock.calls[1][1]) },
    ]);
    expect(calls.runs).toEqual(
      expect.arrayContaining([
        'v2-reload-dispatch-context-JR-1-after-stale',
        'v2-plan-recruiter-team-JR-1-after-stale',
      ]),
    );
    expect(calls.events).toEqual([]);
  });

  it('第二次 stale 终止且不再第三次重读/写入', async () => {
    const loadContext = vi
      .fn()
      .mockResolvedValueOnce(dispatchContext({ contextVersion: 'ctx-1' }))
      .mockResolvedValueOnce(dispatchContext({ contextVersion: 'ctx-2' }));
    const apply = vi.fn(async () => {
      throw new RecruiterDispatchApiError(
        409,
        'CONTEXT_VERSION_STALE',
        'stale again',
        {},
        'ctx-next',
      );
    });
    const dependencies = injectedDependencies({ loadContext, apply });

    await expect(runHandler(dependencies)).rejects.toMatchObject({
      name: 'NonRetriableError',
      message: expect.stringContaining('after one v2 team replan'),
    });
    expect(loadContext).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('其他 409 与 RAAS resource_gap 均不重读重试', async () => {
    const conflictDependencies = injectedDependencies({
      apply: vi.fn(async () => {
        throw new RecruiterDispatchApiError(409, 'HTTP_409', 'other conflict');
      }),
    });
    await expect(runHandler(conflictDependencies)).rejects.toMatchObject({
      name: 'NonRetriableError',
    });
    expect(conflictDependencies.loadContext).toHaveBeenCalledTimes(1);
    expect(conflictDependencies.apply).toHaveBeenCalledTimes(1);

    const gapDependencies = injectedDependencies({
      apply: vi.fn(async (_jobRequisitionId: string, input: any) =>
        assignmentResponse(input, 'resource_gap'),
      ),
    });
    const gapRun = await runHandler(gapDependencies);
    expect(gapRun.result).toMatchObject({ ok: false, outcome: 'resource_gap' });
    expect(gapDependencies.loadContext).toHaveBeenCalledTimes(1);
    expect(gapDependencies.apply).toHaveBeenCalledTimes(1);
    expect(gapRun.calls.events).toEqual([]);
  });

  it('环境与 live context 两道旧 writer 门禁分别 fail closed', async () => {
    const unattested = injectedDependencies({
      legacyAutoClaimDisabled: vi.fn(() => false),
    });
    await expect(runHandler(unattested)).rejects.toMatchObject({
      name: 'NonRetriableError',
    });
    expect(unattested.loadContext).not.toHaveBeenCalled();
    expect(unattested.apply).not.toHaveBeenCalled();

    const liveGuardClosed = injectedDependencies({
      loadContext: vi.fn(async () =>
        dispatchContext({ legacyWriterDisabled: false }),
      ),
    });
    const liveRun = await runHandler(liveGuardClosed);
    expect(liveRun.result).toMatchObject({
      outcome: 'resource_gap',
      write_skipped: true,
    });
    expect(liveGuardClosed.apply).not.toHaveBeenCalled();
  });

  it('context 的 JR 与事件不一致时在 step 外失败关闭', async () => {
    const dependencies = injectedDependencies({
      loadContext: vi.fn(async () =>
        dispatchContext({ jobRequisitionId: 'JR-OTHER' }),
      ),
    });

    await expect(runHandler(dependencies)).rejects.toMatchObject({
      name: 'NonRetriableError',
      message: expect.stringContaining('CONTEXT_JR_MISMATCH'),
    });
    expect(dependencies.decide).not.toHaveBeenCalled();
    expect(dependencies.apply).not.toHaveBeenCalled();
  });

  it('step 外写闸拒绝重复 addition，且不会调用 RAAS', async () => {
    const context = dispatchContext();
    const valid = decideRecruiterDispatch(context);
    const firstAddition = valid.additions[0];
    if (!firstAddition) throw new Error('fixture requires one addition');
    const duplicateDecision: DispatchDecision = {
      ...valid,
      additions: [firstAddition, firstAddition],
    };
    const dependencies = injectedDependencies({
      loadContext: vi.fn(async () => context),
      decide: vi.fn(() => duplicateDecision),
    });

    await expect(runHandler(dependencies)).rejects.toMatchObject({
      name: 'NonRetriableError',
      message: expect.stringContaining('duplicate-addition'),
    });
    expect(dependencies.apply).not.toHaveBeenCalled();
  });

  it('step 外硬闸不信任结构完整的伪决策：live guard、unknown permission、addition block 均零写', async () => {
    const baseline = dispatchContext();
    const valid = decideRecruiterDispatch(baseline);
    const firstAddition = valid.additions[0];
    if (!firstAddition) throw new Error('fixture requires one addition');
    const unknownPermission = dispatchContext({
      candidates: [
        candidate('RECRUITER-A', {
          eligibility: {
            ...candidate('RECRUITER-A').eligibility,
            permission: 'unknown',
          },
        }),
        candidate('RECRUITER-B'),
      ],
    });
    const cases: Array<{ context: DispatchContext; decision: DispatchDecision }> = [
      {
        context: dispatchContext({ legacyWriterDisabled: false }),
        decision: valid,
      },
      { context: unknownPermission, decision: valid },
      {
        context: baseline,
        decision: {
          ...valid,
          additions: [
            { ...firstAddition, source_block_reasons: ['unexpected_live_block'] },
            ...valid.additions.slice(1),
          ],
        },
      },
    ];

    for (const testCase of cases) {
      const dependencies = injectedDependencies({
        loadContext: vi.fn(async () => testCase.context),
        decide: vi.fn(() => testCase.decision),
      });
      await expect(runHandler(dependencies)).rejects.toMatchObject({
        name: 'NonRetriableError',
      });
      expect(dependencies.apply).not.toHaveBeenCalled();
    }
  });

  it('业务优先级顺序不影响 canonical 批量 body 与 decision_id', async () => {
    const context = dispatchContext({
      candidates: [
        candidate('RECRUITER-A', {
          responsibility: {
            level: 'client_backup',
            priority: 100,
            responsibility_id: 'RESP-A',
          },
        }),
        candidate('RECRUITER-B', {
          responsibility: {
            level: 'department_primary',
            priority: 400,
            responsibility_id: 'RESP-B',
          },
        }),
      ],
    });
    expect(
      decideRecruiterDispatch(context).additions.map((addition) => addition.recruiter_id),
    ).toEqual(['RECRUITER-B', 'RECRUITER-A']);
    const dependencies = injectedDependencies({
      loadContext: vi.fn(async () => context),
    });

    const { result } = await runHandler(dependencies);

    const submitted = dependencies.apply.mock.calls[0]?.[1];
    expect(submitted.assignments.map((assignment: any) => assignment.recruiter_employee_id)).toEqual([
      'RECRUITER-A',
      'RECRUITER-B',
    ]);
    expect(submitted.decision_id).toBe(
      createTeamAssignmentDecisionId({
        jobRequisitionId: 'JR-1',
        policyVersion: 'policy-test-v2',
        contextVersion: context.context_version,
        recruiterIds: ['RECRUITER-A', 'RECRUITER-B'],
      }),
    );
    expect(result).toMatchObject({ recruiter_ids: ['RECRUITER-A', 'RECRUITER-B'] });
  });

  it('同一成员集合不同顺序生成同一批次 ID，并使用 codepoint 排序', () => {
    const input = {
      jobRequisitionId: 'JR-1',
      policyVersion: 'policy-test-v2',
      contextVersion: 'ctx-v2',
    };
    const first = createTeamAssignmentDecisionId({
      ...input,
      recruiterIds: ['招聘-B', 'Recruiter-A', 'recruiter-c'],
    });
    const second = createTeamAssignmentDecisionId({
      ...input,
      recruiterIds: ['recruiter-c', '招聘-B', 'Recruiter-A'],
    });

    expect(first).toBe(second);
  });

  it('相同事件重放的 dispatch decision id 与 runId 无关', async () => {
    const event = jdApprovedEvent();
    const first = await runHandler(
      injectedDependencies({ mode: vi.fn(() => 'disabled' as const) }),
      { event, runId: 'run-first' },
    );
    const replay = await runHandler(
      injectedDependencies({ mode: vi.fn(() => 'disabled' as const) }),
      { event, runId: 'run-replay' },
    );

    expect(first.result.decision_id).toBe(replay.result.decision_id);
    expect(first.result.decision_id).toBe(
      createDispatchDecisionId({
        jobRequisitionId: 'JR-1',
        jdId: 'JP-1',
        policyVersion: 'policy-test-v2',
      }),
    );
  });
});
