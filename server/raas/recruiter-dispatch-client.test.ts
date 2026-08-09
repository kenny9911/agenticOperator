import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  RecruiterDispatchApiError,
  assignRecruiterTeam,
  getRecruiterDispatchContext,
  type RecruiterDispatchAssignTeamInput,
} from './recruiter-dispatch-client';

const teamPolicy = {
  minimum_size: 2 as const,
  maximum_size: 4 as const,
  target_size: 2 as const,
};

const dispatchContext = {
  contract_version: 2 as const,
  context_version: 'context-v7',
  rules_status: 'ready' as const,
  write_guards: { legacy_auto_claim_disabled: true },
  requirement: {
    job_requisition_id: 'JR-1',
    client_id: 'client-1',
    client_department_id: 'department-1',
    csi_department_id: 'csi-1',
    service_bg: 'service-bg-1',
    bg_id: 'bg-1',
    latest_safe_start_at: '2026-08-10T00:00:00.000Z',
    required_capability: {
      family: 'family-development',
      group: 'group-frontend',
      sequence: 'sequence-web',
      standard_job_role_id: 'role-web-frontend',
      skill_tags: ['Vue'],
    },
    team_policy: teamPolicy,
    active_recruiter_claims: [],
  },
  candidates: [
    {
      recruiter_id: 'employee-1',
      responsibility: {
        level: 'department_primary' as const,
        priority: 400,
        responsibility_id: 'responsibility-1',
      },
      capabilities: [
        {
          capability_id: 'capability-1',
          taxonomy_level: 'role',
          family: 'family-development',
          group: 'group-frontend',
          sequence: 'sequence-web',
          standard_job_role_id: 'role-web-frontend',
          scope_key: 'role:role-web-frontend',
          skill_tags: ['Vue'],
          status: 'confirmed',
          source_type: 'manual',
        },
      ],
      job_capability: {
        status: 'confirmed_match' as const,
        matched_scope_keys: ['role:role-web-frontend'],
        matched_taxonomy_levels: ['role'],
        skill_tag_overlap: ['Vue'],
      },
      auto_claim_preference: 'confirmed' as const,
      eligibility: {
        has_recruiter_role: true,
        is_active: true,
        permission: 'allowed' as const,
        bg_boundary: 'allowed' as const,
        availability: 'available' as const,
        available_at: null,
        capacity: 'available' as const,
        suspension: 'clear' as const,
        manual_lock: 'clear' as const,
        dispatchable: true,
        block_reasons: [],
      },
    },
  ],
};

const assignInput: RecruiterDispatchAssignTeamInput = {
  contract_version: 2,
  decision_id: 'team-decision-123',
  expected_context_version: 'context-v7',
  dispatch_mode: 'auto',
  policy_version: 'policy-v2',
  team_policy: teamPolicy,
  assignments: [
    {
      recruiter_employee_id: 'employee-1',
      available_at: null,
      reason_codes: ['DEPARTMENT_PRIMARY', 'JOB_CAPABILITY_CONFIRMED_MATCH'],
    },
    {
      recruiter_employee_id: 'employee-2',
      available_at: null,
      reason_codes: ['CLIENT_PRIMARY', 'JOB_CAPABILITY_CONFIRMED_MATCH'],
    },
  ],
};

const assignedResponse = {
  contract_version: 2,
  status: 'assigned',
  decision_id: 'team-decision-123',
  context_version: 'context-v8',
  claims: [
    {
      claim_id: 'claim-1',
      recruiter_id: 'employee-1',
      claimed_at: '2026-08-09T01:00:00.000Z',
    },
    {
      claim_id: 'claim-2',
      recruiter_id: 'employee-2',
      claimed_at: '2026-08-09T01:00:00.000Z',
    },
  ],
  active_recruiter_ids: ['employee-1', 'employee-2'],
  team_status: {
    minimum_size: 2,
    maximum_size: 4,
    target_size: 2,
    active_count: 2,
    minimum_met: true,
    target_met: true,
    added_count: 2,
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function rejectedValue(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject');
}

describe('recruiter-dispatch-client v2', () => {
  beforeEach(() => {
    vi.stubEnv('RAAS_API_BASE_URL', 'https://raas.example.test/');
    vi.stubEnv('RAAS_INTERNAL_API_URL', '');
    vi.stubEnv('RAAS_AGENT_API_KEY', 'agent-secret');
    vi.stubEnv('AGENT_API_KEY', '');
    vi.stubEnv('TASK_ASSIGNER_RAAS_TIMEOUT_MS', '30000');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['direct response', dispatchContext],
    ['data envelope', { success: true, data: dispatchContext, request_id: 'request-1' }],
  ])('GET parses a v2 %s and sends bearer plus trace headers', async (_label, responseBody) => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(responseBody));

    const result = await getRecruiterDispatchContext('job/req 42', {
      traceId: 'trace-abc',
    });

    expect(result).toEqual(dispatchContext);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      'https://raas.example.test/api/v1/recruiter-dispatch/requirements/job%2Freq%2042/context',
    );
    expect(init?.method).toBeUndefined();
    expect(init?.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer agent-secret',
      'X-Trace-Id': 'trace-abc',
    });
  });

  it('rejects the old v1 context shape instead of silently adapting it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        context_version: 'context-v1',
        rules_status: 'available',
        requirement: { has_existing_recruiter_claim: false },
        candidates: [],
      }),
    );

    const error = await rejectedValue(getRecruiterDispatchContext('req-1'));

    expect(error).toBeInstanceOf(RecruiterDispatchApiError);
    expect(error).toMatchObject({ status: 200, code: 'INVALID_CONTEXT' });
  });

  it('fails closed before fetch when the endpoint or API key is not configured', async () => {
    vi.stubEnv('RAAS_API_BASE_URL', '');
    vi.stubEnv('RAAS_INTERNAL_API_URL', '');
    vi.stubEnv('RAAS_AGENT_API_KEY', '');
    vi.stubEnv('AGENT_API_KEY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const error = await rejectedValue(getRecruiterDispatchContext('req-1'));

    expect(error).toBeInstanceOf(RecruiterDispatchApiError);
    expect(error).toMatchObject({ status: 0, code: 'CONFIG', isRetryable: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uses non-empty legacy env aliases and clamps timeout to 60 seconds', async () => {
    vi.stubEnv('RAAS_API_BASE_URL', '   ');
    vi.stubEnv('RAAS_INTERNAL_API_URL', 'https://legacy-raas.example.test');
    vi.stubEnv('RAAS_AGENT_API_KEY', '');
    vi.stubEnv('AGENT_API_KEY', 'legacy-agent-key');
    vi.stubEnv('TASK_ASSIGNER_RAAS_TIMEOUT_MS', '120000');
    const timeoutSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(dispatchContext));

    await getRecruiterDispatchContext('req-legacy');

    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      'https://legacy-raas.example.test/api/v1/recruiter-dispatch/requirements/req-legacy/context',
    );
    expect(fetchSpy.mock.calls[0][1]?.headers).toMatchObject({
      Authorization: 'Bearer legacy-agent-key',
    });
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    expect(fetchSpy.mock.calls[0][1]?.signal).toBe(timeoutSignal);
  });

  it('POST /assign-team sends one complete atomic batch and uses decision_id as idempotency key', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse({ success: true, data: assignedResponse }));

    const result = await assignRecruiterTeam('job/req 42', assignInput, {
      traceId: 'trace-post',
    });

    expect(result).toEqual(assignedResponse);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      'https://raas.example.test/api/v1/recruiter-dispatch/requirements/job%2Freq%2042/assign-team',
    );
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer agent-secret',
        'Content-Type': 'application/json',
        'Idempotency-Key': 'team-decision-123',
        'X-Trace-Id': 'trace-post',
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual(assignInput);
  });

  it.each(['already_satisfied', 'already_applied', 'resource_gap'] as const)(
    'accepts the v2 success status %s',
    async (status) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        jsonResponse({ ...assignedResponse, status }),
      );

      await expect(assignRecruiterTeam('req-1', assignInput)).resolves.toMatchObject({
        status,
        contract_version: 2,
      });
    },
  );

  it('surfaces only CONTEXT_VERSION_STALE 409 as a recognizable stale error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(
        {
          success: false,
          error: 'context changed',
          code: 'CONTEXT_VERSION_STALE',
          details: { current_context_version: 'context-v8' },
        },
        409,
      ),
    );

    const error = await rejectedValue(assignRecruiterTeam('req-1', assignInput));

    expect(error).toBeInstanceOf(RecruiterDispatchApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'CONTEXT_VERSION_STALE',
      currentContextVersion: 'context-v8',
      isStaleContext: true,
      isRetryable: false,
    });
  });

  it.each([
    {
      error: 'missing success flag',
      code: 'CONTEXT_VERSION_STALE',
      details: { current_context_version: 'context-v8' },
    },
    {
      success: true,
      error: 'wrong success flag',
      code: 'CONTEXT_VERSION_STALE',
      details: { current_context_version: 'context-v8' },
    },
  ])('does not recognize a non-canonical stale 409 envelope', async (body) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(body, 409));

    const error = await rejectedValue(assignRecruiterTeam('req-1', assignInput));

    expect(error).toBeInstanceOf(RecruiterDispatchApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'HTTP_409',
      isStaleContext: false,
      isRetryable: false,
    });
  });

  it('does not classify an unrelated 409 as stale or retryable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ success: false, code: 'OTHER_CONFLICT', message: 'conflict' }, 409),
    );

    const error = await rejectedValue(assignRecruiterTeam('req-1', assignInput));

    expect(error).toBeInstanceOf(RecruiterDispatchApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'HTTP_409',
      isStaleContext: false,
      isRetryable: false,
    });
  });

  it('throws a retryable RecruiterDispatchApiError for a 5xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ message: 'RAAS temporarily unavailable' }, 503),
    );

    const error = await rejectedValue(assignRecruiterTeam('req-1', assignInput));

    expect(error).toBeInstanceOf(RecruiterDispatchApiError);
    expect(error).toMatchObject({
      status: 503,
      code: 'HTTP_503',
      responseBody: { message: 'RAAS temporarily unavailable' },
      isRetryable: true,
    });
  });

  it('rejects an invalid v2 success response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ contract_version: 2, status: 'assigned', claims: [] }),
    );

    const error = await rejectedValue(assignRecruiterTeam('req-1', assignInput));

    expect(error).toBeInstanceOf(RecruiterDispatchApiError);
    expect(error).toMatchObject({ status: 200, code: 'INVALID_RESPONSE' });
  });

  it('rejects a response that echoes a different batch decision_id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({ ...assignedResponse, decision_id: 'different-decision' }),
    );

    const error = await rejectedValue(assignRecruiterTeam('req-1', assignInput));

    expect(error).toBeInstanceOf(RecruiterDispatchApiError);
    expect(error).toMatchObject({ status: 200, code: 'INVALID_RESPONSE' });
  });

  it('rejects an empty assignment batch before fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const error = await rejectedValue(
      assignRecruiterTeam('req-1', { ...assignInput, assignments: [] }),
    );

    expect(error).toBeInstanceOf(RecruiterDispatchApiError);
    expect(error).toMatchObject({ status: 0, code: 'INVALID_ASSIGN_INPUT' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      'duplicates',
      [assignInput.assignments[0], assignInput.assignments[0]],
    ],
    [
      'non-canonical order',
      [assignInput.assignments[1], assignInput.assignments[0]],
    ],
  ])('rejects %s in assignments before fetch', async (_label, assignments) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const error = await rejectedValue(
      assignRecruiterTeam('req-1', { ...assignInput, assignments }),
    );

    expect(error).toBeInstanceOf(RecruiterDispatchApiError);
    expect(error).toMatchObject({ status: 0, code: 'INVALID_ASSIGN_INPUT' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
