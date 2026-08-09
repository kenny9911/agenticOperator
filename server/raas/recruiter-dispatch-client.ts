import { z } from 'zod';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;

const teamPolicySchema = z.object({
  minimum_size: z.literal(2),
  maximum_size: z.literal(4),
  target_size: z.union([z.literal(2), z.literal(3), z.literal(4)]),
});

const activeClaimSchema = z.object({
  claim_id: z.string().trim().min(1),
  recruiter_id: z.string().trim().min(1),
  claimed_at: z.string().trim().min(1),
});

const capabilitySchema = z.object({
  capability_id: z.string().min(1),
  taxonomy_level: z.string().min(1),
  family: z.string().nullable(),
  group: z.string().nullable(),
  sequence: z.string().nullable(),
  standard_job_role_id: z.string().nullable(),
  scope_key: z.string().min(1),
  skill_tags: z.array(z.string()),
  status: z.string().min(1),
  source_type: z.string().min(1),
});

const dispatchCandidateSchema = z.object({
  recruiter_id: z.string().trim().min(1),
  responsibility: z.object({
    level: z.enum([
      'department_primary',
      'client_primary',
      'department_backup',
      'client_backup',
      'none',
    ]),
    priority: z.number().finite(),
    responsibility_id: z.string().nullable(),
  }),
  capabilities: z.array(capabilitySchema),
  job_capability: z.object({
    status: z.enum(['confirmed_match', 'suggested_match', 'no_match', 'unknown']),
    matched_scope_keys: z.array(z.string()),
    matched_taxonomy_levels: z.array(z.string()),
    skill_tag_overlap: z.array(z.string()),
  }),
  auto_claim_preference: z.enum(['confirmed', 'unconfirmed', 'absent']),
  eligibility: z.object({
    has_recruiter_role: z.boolean(),
    is_active: z.boolean(),
    permission: z.enum(['allowed', 'denied', 'unknown']),
    bg_boundary: z.enum(['allowed', 'denied', 'unknown']),
    availability: z.enum(['available', 'scheduled', 'unavailable', 'unknown']),
    available_at: z.string().nullable(),
    capacity: z.enum(['available', 'full', 'unknown']),
    suspension: z.enum(['clear', 'suspended', 'unknown']),
    manual_lock: z.enum(['clear', 'locked', 'unknown']),
    dispatchable: z.boolean(),
    block_reasons: z.array(z.string()),
  }),
});

const dispatchContextSchema = z.object({
  contract_version: z.literal(2),
  context_version: z.string().trim().min(1),
  rules_status: z.enum(['ready', 'suggestion_only']),
  write_guards: z.object({
    legacy_auto_claim_disabled: z.boolean(),
  }),
  requirement: z.object({
    job_requisition_id: z.string().trim().min(1),
    client_id: z.string().nullable(),
    client_department_id: z.string().nullable(),
    csi_department_id: z.string().nullable(),
    service_bg: z.string().nullable(),
    bg_id: z.string().nullable(),
    latest_safe_start_at: z.string().nullable(),
    required_capability: z.object({
      family: z.string().nullable(),
      group: z.string().nullable(),
      sequence: z.string().nullable(),
      standard_job_role_id: z.string().nullable(),
      skill_tags: z.array(z.string()),
    }),
    team_policy: teamPolicySchema,
    active_recruiter_claims: z.array(activeClaimSchema),
  }),
  candidates: z.array(dispatchCandidateSchema),
});

const dispatchContextResponseSchema = z.union([
  dispatchContextSchema,
  z.object({ data: dispatchContextSchema }).passthrough().transform((value) => value.data),
]);

export const recruiterDispatchAssignStatusSchema = z.enum([
  'assigned',
  'already_satisfied',
  'already_applied',
  'resource_gap',
]);

const assignTeamInputSchema = z.object({
  contract_version: z.literal(2),
  decision_id: z.string().trim().min(1),
  expected_context_version: z.string().trim().min(1),
  dispatch_mode: z.enum(['auto', 'shadow']),
  policy_version: z.string().trim().min(1),
  team_policy: teamPolicySchema,
  assignments: z
    .array(
      z.object({
        recruiter_employee_id: z.string().trim().min(1),
        available_at: z.string().nullable().optional(),
        reason_codes: z.array(z.string()).optional(),
      }),
    )
    .min(1)
    .max(4)
    .superRefine((assignments, context) => {
      const ids = assignments.map((assignment) => assignment.recruiter_employee_id);
      if (new Set(ids).size !== ids.length) {
        context.addIssue({
          code: 'custom',
          message: 'assignments must contain unique recruiter_employee_id values',
        });
      }
      const sortedIds = [...ids].sort(compareCodePoint);
      if (ids.some((id, index) => id !== sortedIds[index])) {
        context.addIssue({
          code: 'custom',
          message: 'assignments must be sorted by recruiter_employee_id',
        });
      }
    }),
});

const assignTeamResponseBodySchema = z.object({
  contract_version: z.literal(2),
  status: recruiterDispatchAssignStatusSchema,
  decision_id: z.string().trim().min(1),
  context_version: z.string().trim().min(1),
  claims: z.array(activeClaimSchema),
  active_recruiter_ids: z.array(z.string().trim().min(1)),
  team_status: z.object({
    minimum_size: z.literal(2),
    maximum_size: z.literal(4),
    target_size: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    active_count: z.number().int().nonnegative(),
    minimum_met: z.boolean(),
    target_met: z.boolean(),
    added_count: z.number().int().nonnegative(),
  }),
  reasons: z.array(z.string()).optional(),
});

const assignTeamResponseSchema = z.union([
  assignTeamResponseBodySchema,
  z
    .object({ data: assignTeamResponseBodySchema })
    .passthrough()
    .transform((value) => value.data),
]);

const staleContextErrorSchema = z
  .object({
    success: z.literal(false),
    error: z.string().trim().min(1),
    code: z.literal('CONTEXT_VERSION_STALE'),
    details: z.object({
      current_context_version: z.string().min(1),
    }),
  })
  .passthrough();

export type RecruiterDispatchAssignStatus = z.infer<
  typeof recruiterDispatchAssignStatusSchema
>;
export type RecruiterDispatchContextV2 = z.infer<typeof dispatchContextSchema>;
export type RecruiterDispatchAssignTeamInput = z.infer<typeof assignTeamInputSchema>;
export type RecruiterDispatchAssignTeamResponse = z.infer<
  typeof assignTeamResponseBodySchema
>;

export class RecruiterDispatchApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly responseBody?: unknown,
    public readonly currentContextVersion?: string,
  ) {
    super(`RAAS recruiter dispatch ${status} ${code}: ${message}`);
    this.name = 'RecruiterDispatchApiError';
  }

  get isRetryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }

  get isStaleContext(): boolean {
    return this.status === 409 && this.code === 'CONTEXT_VERSION_STALE';
  }
}

type RequestOptions = {
  traceId?: string | null;
};

function getConfig(): { baseUrl: string; agentKey: string; timeoutMs: number } {
  const baseUrl = firstNonEmpty(
    process.env.RAAS_API_BASE_URL,
    process.env.RAAS_INTERNAL_API_URL,
  );
  const agentKey = firstNonEmpty(
    process.env.RAAS_AGENT_API_KEY,
    process.env.AGENT_API_KEY,
  );

  if (!baseUrl || !agentKey) {
    throw new RecruiterDispatchApiError(
      0,
      'CONFIG',
      'RAAS_API_BASE_URL/RAAS_INTERNAL_API_URL and RAAS_AGENT_API_KEY/AGENT_API_KEY are required',
    );
  }

  const configuredTimeout = Number(
    process.env.TASK_ASSIGNER_RAAS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(1_000, configuredTimeout))
    : DEFAULT_TIMEOUT_MS;

  return { baseUrl: baseUrl.replace(/\/+$/, ''), agentKey, timeoutMs };
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.map((value) => value?.trim() ?? '').find(Boolean) ?? '';
}

function authHeaders(agentKey: string, traceId?: string | null): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${agentKey}`,
    ...(traceId ? { 'X-Trace-Id': traceId } : {}),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 2_000) };
  }
}

function messageFromBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const record = body as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail']) {
    if (typeof record[key] === 'string' && record[key]) return record[key];
  }
  return fallback;
}

export function parseRecruiterDispatchContextV2(
  value: unknown,
): RecruiterDispatchContextV2 {
  const parsed = dispatchContextSchema.safeParse(value);
  if (!parsed.success) {
    throw new RecruiterDispatchApiError(
      0,
      'INVALID_CONTEXT',
      parsed.error.issues.map((issue) => issue.message).join('; '),
      value,
    );
  }
  return parsed.data;
}

export function parseRecruiterDispatchAssignTeamResponse(
  value: unknown,
  expectedDecisionId?: string,
  status = 0,
): RecruiterDispatchAssignTeamResponse {
  const parsed = assignTeamResponseBodySchema.safeParse(value);
  if (!parsed.success) {
    throw new RecruiterDispatchApiError(
      status,
      'INVALID_RESPONSE',
      parsed.error.issues.map((issue) => issue.message).join('; '),
      value,
    );
  }
  if (expectedDecisionId && parsed.data.decision_id !== expectedDecisionId) {
    throw new RecruiterDispatchApiError(
      status,
      'INVALID_RESPONSE',
      'response decision_id does not match the submitted batch',
      value,
    );
  }
  return parsed.data;
}

export async function getRecruiterDispatchContext(
  jobRequisitionId: string,
  options: RequestOptions = {},
): Promise<RecruiterDispatchContextV2> {
  const { baseUrl, agentKey, timeoutMs } = getConfig();
  const url = new URL(
    `/api/v1/recruiter-dispatch/requirements/${encodeURIComponent(jobRequisitionId)}/context`,
    `${baseUrl}/`,
  );

  const response = await fetch(url, {
    headers: authHeaders(agentKey, options.traceId),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await readJson(response);

  if (!response.ok) {
    throw new RecruiterDispatchApiError(
      response.status,
      `HTTP_${response.status}`,
      messageFromBody(body, response.statusText),
      body,
    );
  }

  const parsed = dispatchContextResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new RecruiterDispatchApiError(
      response.status,
      'INVALID_CONTEXT',
      parsed.error.issues.map((issue) => issue.message).join('; '),
      body,
    );
  }

  return parseRecruiterDispatchContextV2(parsed.data);
}

export async function assignRecruiterTeam(
  jobRequisitionId: string,
  input: RecruiterDispatchAssignTeamInput,
  options: RequestOptions = {},
): Promise<RecruiterDispatchAssignTeamResponse> {
  const parsedInput = assignTeamInputSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new RecruiterDispatchApiError(
      0,
      'INVALID_ASSIGN_INPUT',
      parsedInput.error.issues.map((issue) => issue.message).join('; '),
      input,
    );
  }

  const { baseUrl, agentKey, timeoutMs } = getConfig();
  const url = new URL(
    `/api/v1/recruiter-dispatch/requirements/${encodeURIComponent(jobRequisitionId)}/assign-team`,
    `${baseUrl}/`,
  );

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...authHeaders(agentKey, options.traceId),
      'Content-Type': 'application/json',
      'Idempotency-Key': parsedInput.data.decision_id,
    },
    body: JSON.stringify(parsedInput.data),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await readJson(response);

  if (response.status === 409) {
    const stale = staleContextErrorSchema.safeParse(body);
    if (stale.success) {
      throw new RecruiterDispatchApiError(
        response.status,
        stale.data.code,
        stale.data.error,
        body,
        stale.data.details.current_context_version,
      );
    }
  }

  if (!response.ok) {
    throw new RecruiterDispatchApiError(
      response.status,
      `HTTP_${response.status}`,
      messageFromBody(body, response.statusText),
      body,
    );
  }

  const parsed = assignTeamResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new RecruiterDispatchApiError(
      response.status,
      'INVALID_RESPONSE',
      parsed.error.issues.map((issue) => issue.message).join('; '),
      body,
    );
  }

  return parseRecruiterDispatchAssignTeamResponse(
    parsed.data,
    parsedInput.data.decision_id,
    response.status,
  );
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
