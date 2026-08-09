// TaskAssigner — Workflow node 6.
//
// JD_APPROVED is the review gate. AO plans a privacy-safe recruiter team; RAAS
// remains the only RequirementClaim writer and atomically revalidates the live
// v2 context, permission, capability, availability, capacity and idempotency.

import { createHash } from 'node:crypto';
import { NonRetriableError } from 'inngest';
import { createAgentLogger, runWithLogger, type AgentLogger } from '@/lib/agent-logger';
import {
  decideRecruiterDispatch,
  type DispatchContext,
  type DispatchDecision,
} from '@/lib/recruiter-dispatch/decision';
import {
  assignRecruiterTeam,
  getRecruiterDispatchContext,
  parseRecruiterDispatchAssignTeamResponse,
  parseRecruiterDispatchContextV2,
  RecruiterDispatchApiError,
  type RecruiterDispatchAssignTeamInput,
  type RecruiterDispatchAssignTeamResponse,
} from '@/server/raas/recruiter-dispatch-client';
import { inngest } from '@/server/inngest/client';
import { skipIfRaasV1Paused } from '@/server/inngest/raas-v1';

const AGENT_ID = 'task-assigner-agent';
const AGENT_NAME = 'taskAssigner';

export type TaskAssignerMode = 'disabled' | 'shadow' | 'auto';

type DispatchClientOptions = { traceId?: string | null };

type TaskAssignerDependencies = {
  loadContext: (
    jobRequisitionId: string,
    options?: DispatchClientOptions,
  ) => Promise<unknown>;
  decide: (context: DispatchContext, now?: Date) => unknown;
  apply: (
    jobRequisitionId: string,
    input: RecruiterDispatchAssignTeamInput,
    options?: DispatchClientOptions,
  ) => Promise<RecruiterDispatchAssignTeamResponse>;
  now: () => Date;
  mode: () => TaskAssignerMode;
  policyVersion: () => string;
  legacyAutoClaimDisabled: () => boolean;
  createLogger: typeof createAgentLogger;
};

const defaultDependencies: TaskAssignerDependencies = {
  loadContext: (jobRequisitionId, options) =>
    getRecruiterDispatchContext(jobRequisitionId, options),
  decide: decideRecruiterDispatch,
  apply: assignRecruiterTeam,
  now: () => new Date(),
  mode: getTaskAssignerMode,
  policyVersion: getPolicyVersion,
  legacyAutoClaimDisabled: () =>
    process.env.TASK_ASSIGNER_LEGACY_AUTO_CLAIM_DISABLED?.trim() === '1',
  createLogger: createAgentLogger,
};

export const taskAssignerAgent = inngest.createFunction(
  {
    id: AGENT_ID,
    name: 'Task Assigner Agent',
    retries: 2,
    idempotency: 'event.data.event_id',
    concurrency: {
      key:
        'has(event.data.payload.job_requisition_id) ? ' +
        'event.data.payload.job_requisition_id : event.data.entity_id',
      limit: 1,
    },
    triggers: [{ event: 'JD_APPROVED' }],
  },
  async ({ event, step, logger, runId }) => {
    const paused = await skipIfRaasV1Paused(AGENT_ID, logger);
    if (paused) return paused;

    return taskAssignerAgentHandler({ event, step, logger, runId });
  },
);

/** Exported for event-replay tests without an Inngest server. */
export async function taskAssignerAgentHandler(
  { event, step, logger, runId }: any,
  dependencyOverrides: Partial<TaskAssignerDependencies> = {},
) {
  const dependencies: TaskAssignerDependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };
  const envelope = unwrapJdApprovedEvent(event?.data);
  const mode = dependencies.mode();
  const jobRequisitionId = envelope.jobRequisitionId;
  const jdId = envelope.jdId;
  const policyVersion = dependencies.policyVersion();
  const dispatchDecisionId = createDispatchDecisionId({
    jobRequisitionId: jobRequisitionId ?? 'missing',
    jdId: jdId ?? 'missing',
    policyVersion,
  });
  const fileLogger = dependencies.createLogger({
    agent: AGENT_NAME,
    runId: runId ?? `local-${dispatchDecisionId.slice(-12)}`,
    traceId: envelope.traceId,
    anchors: {
      job_requisition_id: jobRequisitionId,
      job_posting_id: jdId,
    },
  });

  return runWithLogger(fileLogger, async () => {
    fileLogger.event('handler.start', {
      event_name: event?.name ?? 'JD_APPROVED',
      mode,
      job_requisition_id: jobRequisitionId,
      job_posting_id: jdId,
      decision_id: dispatchDecisionId,
      contract_version: 2,
      policy_version: policyVersion,
    });

    if (mode === 'disabled') {
      logger?.info?.(`[${AGENT_NAME}] disabled; JD_APPROVED ignored`);
      const result = {
        ok: true,
        mode,
        outcome: 'disabled' as const,
        decision_id: dispatchDecisionId,
      };
      fileLogger.event('handler.done', result);
      return result;
    }

    // Deployment attestation is the first writer gate. The live context carries
    // the independent RAAS-side guard checked again immediately before POST.
    if (mode === 'auto' && !dependencies.legacyAutoClaimDisabled()) {
      fileLogger.event('handler.error', { reason: 'legacy-auto-claim-not-disabled' });
      throw new NonRetriableError(
        `[${AGENT_NAME}] auto mode blocked: RAAS legacy auto-claim disablement is not attested`,
      );
    }

    if (!jobRequisitionId) {
      fileLogger.event('handler.error', { reason: 'missing-job-requisition-id' });
      throw new NonRetriableError(
        `[${AGENT_NAME}] JD_APPROVED missing payload.job_requisition_id/entity_id`,
      );
    }

    const stepKey = sanitizeStepKey(jobRequisitionId);
    let context = await loadV2Context({
      step,
      stepId: `v2-load-dispatch-context-${stepKey}`,
      jobRequisitionId,
      traceId: envelope.traceId,
      dependencies,
    });
    let decision = await planV2OutsideStep({
      step,
      stepId: `v2-plan-recruiter-team-${stepKey}`,
      context,
      dependencies,
      fileLogger,
    });

    logDecision(fileLogger, mode, context, decision, dispatchDecisionId);

    if (mode === 'shadow') {
      const result = {
        ok: true,
        mode,
        outcome: 'shadow' as const,
        decision_id: dispatchDecisionId,
        decision,
        emitted_event: null,
      };
      fileLogger.event('handler.done', summarizeResult(result));
      return result;
    }

    let didWaitForMinimum = false;
    let didRetryStale = false;

    while (true) {
      if (decision.outcome === 'wait_for_refresh') {
        if (didWaitForMinimum) {
          return finishWithoutWrite(
            fileLogger,
            mode,
            dispatchDecisionId,
            decision,
            'wait-refresh-still-below-minimum',
            'resource_gap',
          );
        }
        const waitUntil = toValidDate(decision.wait_until);
        if (!waitUntil) {
          return finishWithoutWrite(
            fileLogger,
            mode,
            dispatchDecisionId,
            decision,
            'invalid-wait-until',
            'resource_gap',
          );
        }
        if (waitUntil.getTime() > dependencies.now().getTime()) {
          await step.sleepUntil(`v2-wait-recruiter-team-minimum-${stepKey}`, waitUntil);
        }
        didWaitForMinimum = true;

        // Scheduled availability is never a reservation. Wake exactly once,
        // reload the entire v2 snapshot, and require present dispatchability.
        context = await loadV2Context({
          step,
          stepId: `v2-reload-dispatch-context-${stepKey}-after-wait`,
          jobRequisitionId,
          traceId: envelope.traceId,
          dependencies,
        });
        decision = await planV2OutsideStep({
          step,
          stepId: `v2-plan-recruiter-team-${stepKey}-after-wait`,
          context,
          dependencies,
          fileLogger,
        });
        logDecision(fileLogger, mode, context, decision, dispatchDecisionId, 'after-wait');
        continue;
      }

      if (decision.outcome !== 'auto_assign_team') {
        return finishWithoutWrite(
          fileLogger,
          mode,
          dispatchDecisionId,
          decision,
          'team-plan-not-write-ready',
        );
      }

      // This gate is deliberately outside step.run. Inngest may return a
      // memoized historical planning output without executing a newly deployed
      // callback; only the current-code recomputation can reach this boundary.
      const write = buildCanonicalTeamWrite({
        context,
        decision,
        jobRequisitionId,
        policyVersion,
      });

      const rawAssignmentResult = await step.run(
        `v2-assign-recruiter-team-${stepKey}-${write.decisionId.slice(-12)}`,
        async () => {
          try {
            const response = await callRaas(() =>
              dependencies.apply(jobRequisitionId, write.input, {
                traceId: envelope.traceId,
              }),
            );
            return { kind: 'response' as const, response };
          } catch (error) {
            if (error instanceof RecruiterDispatchApiError && error.isStaleContext) {
              const currentContextVersion = clean(error.currentContextVersion);
              if (!currentContextVersion) {
                throw new NonRetriableError(
                  `[${AGENT_NAME}] canonical stale response is missing current_context_version`,
                );
              }
              // Failed Inngest steps are replayed as StepError and lose custom
              // fields/prototypes. Persist canonical stale as successful step
              // data so the outer workflow can deterministically replan once.
              return {
                kind: 'stale' as const,
                current_context_version: currentContextVersion,
              };
            }
            throw error;
          }
        },
      );
      const assignmentResult = requireTeamAssignmentStepResult(
        rawAssignmentResult,
        write.decisionId,
      );

      if (assignmentResult.kind === 'stale') {
        if (didRetryStale) {
          throw new NonRetriableError(
            `[${AGENT_NAME}] context remained stale after one v2 team replan`,
          );
        }
        didRetryStale = true;
        fileLogger.event('dispatch.context-stale', {
          assignment_decision_id: write.decisionId,
          submitted_context_version: context.context_version,
          current_context_version: assignmentResult.current_context_version,
        });

        context = await loadV2Context({
          step,
          stepId: `v2-reload-dispatch-context-${stepKey}-after-stale`,
          jobRequisitionId,
          traceId: envelope.traceId,
          dependencies,
        });
        decision = await planV2OutsideStep({
          step,
          stepId: `v2-plan-recruiter-team-${stepKey}-after-stale`,
          context,
          dependencies,
          fileLogger,
        });
        logDecision(fileLogger, mode, context, decision, dispatchDecisionId, 'after-stale');
        continue;
      }

      const assignment = assignmentResult.response;
      const ok = assignment.status !== 'resource_gap';
      const result = {
        ok,
        mode,
        outcome: assignment.status,
        decision_id: dispatchDecisionId,
        assignment_decision_id: write.decisionId,
        recruiter_ids: write.recruiterIds,
        claims: assignment.claims,
        active_recruiter_ids: assignment.active_recruiter_ids,
        team_status: assignment.team_status,
        planned_gap: decision.gap,
        // RAAS owns any canonical post-transaction event. AO deliberately
        // emits no TASK_ASSIGNED (or replacement) event.
        emitted_event: null,
      };
      fileLogger.event('handler.done', result);
      return result;
    }
  });
}

function requireTeamAssignmentStepResult(
  value: unknown,
  expectedDecisionId: string,
):
  | {
      kind: 'response';
      response: RecruiterDispatchAssignTeamResponse;
    }
  | {
      kind: 'stale';
      current_context_version: string;
    } {
  if (isRecord(value) && value.kind === 'stale') {
    const currentContextVersion = clean(value.current_context_version);
    if (currentContextVersion) {
      return {
        kind: 'stale',
        current_context_version: currentContextVersion,
      };
    }
  }
  if (isRecord(value) && value.kind === 'response') {
    try {
      return {
        kind: 'response',
        response: parseRecruiterDispatchAssignTeamResponse(
          value.response,
          expectedDecisionId,
        ),
      };
    } catch (error) {
      if (error instanceof RecruiterDispatchApiError) {
        throw new NonRetriableError(error.message);
      }
      throw error;
    }
  }
  throw new NonRetriableError(
    `[${AGENT_NAME}] memoized v2 team assignment step has an incompatible shape`,
  );
}

async function loadV2Context(input: {
  step: any;
  stepId: string;
  jobRequisitionId: string;
  traceId?: string | null;
  dependencies: TaskAssignerDependencies;
}): Promise<DispatchContext> {
  const raw = await input.step.run(input.stepId, () =>
    callRaas(() =>
      input.dependencies.loadContext(input.jobRequisitionId, {
        traceId: input.traceId,
      }),
    ),
  );

  // Replay-safe context boundary: a memoized step bypasses the client parser.
  try {
    const context = parseRecruiterDispatchContextV2(raw);
    if (context.requirement.job_requisition_id !== input.jobRequisitionId) {
      throw new RecruiterDispatchApiError(
        0,
        'CONTEXT_JR_MISMATCH',
        'context requirement.job_requisition_id does not match the event',
        {
          expected_job_requisition_id: input.jobRequisitionId,
          actual_job_requisition_id: context.requirement.job_requisition_id,
        },
      );
    }
    return context as DispatchContext;
  } catch (error) {
    if (error instanceof RecruiterDispatchApiError) {
      throw new NonRetriableError(error.message);
    }
    throw error;
  }
}

async function planV2OutsideStep(input: {
  step: any;
  stepId: string;
  context: DispatchContext;
  dependencies: TaskAssignerDependencies;
  fileLogger: AgentLogger;
}): Promise<DispatchDecision> {
  const planningNow = input.dependencies.now();
  const stepDecision = await input.step.run(input.stepId, async () =>
    input.dependencies.decide(input.context, planningNow),
  );

  // Always recompute with current code outside step.run. `stepDecision` is audit
  // evidence only and can be an old memoized `{ selected: ... }` value.
  const currentDecision = input.dependencies.decide(input.context, planningNow);
  const decision = requireV2Decision(currentDecision, input.context);
  input.fileLogger.event('dispatch.replay-safe-plan', {
    step_contract_version: recordNumber(stepDecision, 'contract_version'),
    current_contract_version: decision.contract_version,
    memoized_shape_replaced: !isCompatibleV2Decision(stepDecision, input.context),
  });
  return decision;
}

function requireV2Decision(value: unknown, context: DispatchContext): DispatchDecision {
  if (!isCompatibleV2Decision(value, context)) {
    throw new NonRetriableError(
      `[${AGENT_NAME}] v2 team plan failed replay-safe contract validation`,
    );
  }
  return value;
}

function isCompatibleV2Decision(
  value: unknown,
  context: DispatchContext,
): value is DispatchDecision {
  if (!isRecord(value)) return false;
  if (value.contract_version !== 2 || value.context_version !== context.context_version) {
    return false;
  }
  if (!isTeamPolicy(value.team_policy) || !sameTeamPolicy(value.team_policy, context.requirement.team_policy)) {
    return false;
  }
  if (!Array.isArray(value.active_recruiter_ids) || !value.active_recruiter_ids.every(isString)) {
    return false;
  }
  if (
    !Array.isArray(value.additions) ||
    !value.additions.every(isCandidateDecision) ||
    !Array.isArray(value.candidates) ||
    !value.candidates.every(isCandidateDecision) ||
    !Array.isArray(value.excluded)
  ) {
    return false;
  }
  if (!Array.isArray(value.reason_codes) || !Array.isArray(value.warnings)) return false;
  if (!['team_complete', 'auto_assign_team', 'wait_for_refresh', 'resource_gap', 'team_gap'].includes(String(value.outcome))) {
    return false;
  }
  return [value.current_team_size, value.planned_team_size, value.gap, value.minimum_gap].every(
    (number) => typeof number === 'number' && Number.isInteger(number) && number >= 0,
  );
}

function buildCanonicalTeamWrite(input: {
  context: DispatchContext;
  decision: DispatchDecision;
  jobRequisitionId: string;
  policyVersion: string;
}): {
  decisionId: string;
  recruiterIds: string[];
  input: RecruiterDispatchAssignTeamInput;
} {
  const { context, decision } = input;
  const fail = (reason: string): never => {
    throw new NonRetriableError(`[${AGENT_NAME}] v2 team write gate blocked: ${reason}`);
  };

  if (context.contract_version !== 2 || decision.contract_version !== 2) {
    fail('contract-version');
  }
  if (context.requirement.job_requisition_id !== input.jobRequisitionId) fail('jr-mismatch');
  if (context.context_version !== decision.context_version) fail('context-version-mismatch');
  if (context.rules_status !== 'ready') fail('rules-not-ready');
  if (!context.write_guards.legacy_auto_claim_disabled) fail('legacy-writer-active');
  if (!sameTeamPolicy(context.requirement.team_policy, decision.team_policy)) {
    fail('team-policy-mismatch');
  }
  if (decision.outcome !== 'auto_assign_team') fail('outcome-not-write-ready');
  if (decision.additions.length < 1 || decision.additions.length > 4) {
    fail('assignment-count');
  }

  const contextActiveIds = context.requirement.active_recruiter_claims
    .map((claim) => clean(claim.recruiter_id))
    .filter(Boolean);
  const uniqueActiveIds = [...new Set(contextActiveIds)].sort(compareCodePoint);
  if (uniqueActiveIds.length !== contextActiveIds.length) fail('duplicate-active-claim');
  if (!sameStringArray(decision.active_recruiter_ids, uniqueActiveIds)) {
    fail('active-team-mismatch');
  }

  const additions = decision.additions.map((addition) => {
    const recruiterId = clean(addition.recruiter_id);
    if (!recruiterId) fail('missing-recruiter-id');
    if (addition.disposition !== 'auto' || addition.scheduled_for !== null) {
      fail('non-present-addition');
    }
    if (addition.source_block_reasons.length !== 0) fail('addition-has-block-reasons');
    return { recruiterId, addition };
  });
  const recruiterIds = additions.map(({ recruiterId }) => recruiterId);
  if (new Set(recruiterIds).size !== recruiterIds.length) fail('duplicate-addition');
  if (recruiterIds.some((recruiterId) => uniqueActiveIds.includes(recruiterId))) {
    fail('addition-already-active');
  }

  const contextCandidateCounts = new Map<string, number>();
  for (const candidate of context.candidates) {
    const recruiterId = clean(candidate.recruiter_id);
    contextCandidateCounts.set(recruiterId, (contextCandidateCounts.get(recruiterId) ?? 0) + 1);
  }
  for (const recruiterId of recruiterIds) {
    if (contextCandidateCounts.get(recruiterId) !== 1) fail('candidate-context-not-unique');
    const candidate = context.candidates.find(
      (item) => clean(item.recruiter_id) === recruiterId,
    );
    if (!candidate) fail('candidate-context-missing');
    const currentCandidate = candidate!;
    const eligibility = currentCandidate.eligibility;
    if (
      currentCandidate.job_capability.status !== 'confirmed_match' ||
      !eligibility.has_recruiter_role ||
      !eligibility.is_active ||
      eligibility.permission !== 'allowed' ||
      eligibility.bg_boundary !== 'allowed' ||
      eligibility.availability !== 'available' ||
      eligibility.capacity !== 'available' ||
      eligibility.suspension !== 'clear' ||
      eligibility.manual_lock !== 'clear' ||
      !eligibility.dispatchable ||
      eligibility.block_reasons.length !== 0
    ) {
      fail('candidate-no-longer-write-eligible');
    }
  }

  const projectedSize = uniqueActiveIds.length + recruiterIds.length;
  if (
    projectedSize < context.requirement.team_policy.minimum_size ||
    projectedSize > context.requirement.team_policy.maximum_size ||
    projectedSize > context.requirement.team_policy.target_size
  ) {
    fail('projected-team-size');
  }
  if (
    decision.current_team_size !== uniqueActiveIds.length ||
    decision.planned_team_size !== projectedSize ||
    decision.minimum_gap !== 0 ||
    decision.gap !== context.requirement.team_policy.target_size - projectedSize
  ) {
    fail('decision-team-arithmetic');
  }

  const canonicalAdditions = [...additions].sort((left, right) =>
    compareCodePoint(left.recruiterId, right.recruiterId),
  );
  const canonicalRecruiterIds = canonicalAdditions.map(({ recruiterId }) => recruiterId);
  const decisionId = createTeamAssignmentDecisionId({
    jobRequisitionId: input.jobRequisitionId,
    policyVersion: input.policyVersion,
    contextVersion: context.context_version,
    recruiterIds: canonicalRecruiterIds,
  });
  const policy = context.requirement.team_policy;
  return {
    decisionId,
    recruiterIds: canonicalRecruiterIds,
    input: {
      contract_version: 2,
      decision_id: decisionId,
      expected_context_version: context.context_version,
      dispatch_mode: 'auto',
      policy_version: input.policyVersion,
      team_policy: {
        minimum_size: 2,
        maximum_size: 4,
        target_size: policy.target_size,
      },
      assignments: canonicalAdditions.map(({ recruiterId, addition }) => ({
        recruiter_employee_id: recruiterId,
        available_at: null,
        reason_codes: [...addition.reason_codes],
      })),
    },
  };
}

function getTaskAssignerMode(): TaskAssignerMode {
  const value = process.env.TASK_ASSIGNER_MODE?.trim().toLowerCase();
  return value === 'shadow' || value === 'auto' ? value : 'disabled';
}

function getPolicyVersion(): string {
  const value = process.env.TASK_ASSIGNER_POLICY_VERSION?.trim();
  return value ? value.slice(0, 64) : 'v2';
}

export function createDispatchDecisionId(input: {
  jobRequisitionId: string;
  jdId: string;
  policyVersion: string;
}): string {
  const digest = createHash('sha256')
    .update(
      `v2\u0000${input.policyVersion}\u0000${input.jobRequisitionId}\u0000${input.jdId}`,
      'utf8',
    )
    .digest('hex')
    .slice(0, 32);
  return `dispatch_v2_${digest}`;
}

export function createTeamAssignmentDecisionId(input: {
  jobRequisitionId: string;
  policyVersion: string;
  contextVersion: string;
  recruiterIds: readonly string[];
}): string {
  const recruiterIds = [...new Set(input.recruiterIds.map(clean).filter(Boolean))].sort(
    compareCodePoint,
  );
  const digest = createHash('sha256')
    .update(
      [
        'v2',
        input.policyVersion,
        input.jobRequisitionId,
        input.contextVersion,
        ...recruiterIds,
      ].join('\u0000'),
      'utf8',
    )
    .digest('hex')
    .slice(0, 32);
  return `assign_team_v2_${digest}`;
}

function unwrapJdApprovedEvent(data: unknown): {
  jobRequisitionId?: string;
  jdId?: string;
  traceId?: string | null;
} {
  const raw = isRecord(data) ? data : {};
  const payload = isRecord(raw.payload) ? raw.payload : raw;
  const trace = isRecord(raw.trace) ? raw.trace : {};
  const entityId = stringOrUndefined(raw.entity_id);
  const entityType = stringOrUndefined(raw.entity_type)?.toLowerCase();

  return {
    jobRequisitionId:
      stringOrUndefined(payload.job_requisition_id) ??
      stringOrUndefined(payload.requirement_id) ??
      (entityType === 'job_requisition' ? entityId : undefined) ??
      (entityType == null ? entityId : undefined),
    jdId:
      stringOrUndefined(payload.jd_id) ??
      stringOrUndefined(payload.job_posting_id) ??
      (entityType === 'job_posting' ? entityId : undefined),
    traceId: stringOrUndefined(trace.trace_id),
  };
}

async function callRaas<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RecruiterDispatchApiError) {
      // The handler owns the one allowed stale-context replan. Converting this
      // 409 here would make that deterministic branch unreachable.
      if (error.isStaleContext) throw error;
      if (!error.isRetryable) throw new NonRetriableError(error.message);
    }
    throw error;
  }
}

function logDecision(
  logger: AgentLogger,
  mode: TaskAssignerMode,
  context: DispatchContext,
  decision: DispatchDecision,
  decisionId: string,
  phase: 'initial' | 'after-wait' | 'after-stale' = 'initial',
): void {
  logger.event('dispatch.team-decision', {
    phase,
    mode,
    decision_id: decisionId,
    contract_version: decision.contract_version,
    context_version: context.context_version,
    rules_status: context.rules_status,
    outcome: decision.outcome,
    active_recruiter_ids: decision.active_recruiter_ids,
    addition_recruiter_ids: decision.additions.map((candidate) => candidate.recruiter_id),
    current_team_size: decision.current_team_size,
    planned_team_size: decision.planned_team_size,
    gap: decision.gap,
    minimum_gap: decision.minimum_gap,
    wait_until: decision.wait_until,
    reason_codes: decision.reason_codes,
    warnings: decision.warnings,
    ranked_candidates: decision.candidates.map((candidate) => ({
      recruiter_id: candidate.recruiter_id,
      disposition: candidate.disposition,
      rank: candidate.rank,
      scheduled_for: candidate.scheduled_for,
      reason_codes: candidate.reason_codes,
      source_block_reasons: candidate.source_block_reasons,
      warnings: candidate.warnings,
    })),
  });
}

function finishWithoutWrite(
  logger: AgentLogger,
  mode: TaskAssignerMode,
  decisionId: string,
  decision: DispatchDecision,
  reason: string,
  outcomeOverride?: string,
) {
  const result = {
    ok: true,
    mode,
    outcome: outcomeOverride ?? decision.outcome,
    decision_id: decisionId,
    write_skipped: true,
    reason,
    decision,
    emitted_event: null,
  };
  logger.event('handler.done', summarizeResult(result));
  return result;
}

function summarizeResult(result: {
  ok: boolean;
  mode: TaskAssignerMode;
  outcome: string;
  decision_id: string;
  decision?: DispatchDecision;
}) {
  return {
    ok: result.ok,
    mode: result.mode,
    outcome: result.outcome,
    decision_id: result.decision_id,
    addition_recruiter_ids:
      result.decision?.additions.map((candidate) => candidate.recruiter_id) ?? [],
    gap: result.decision?.gap ?? null,
  };
}

function isTeamPolicy(value: unknown): value is DispatchContext['requirement']['team_policy'] {
  return (
    isRecord(value) &&
    value.minimum_size === 2 &&
    value.maximum_size === 4 &&
    [2, 3, 4].includes(Number(value.target_size))
  );
}

function sameTeamPolicy(
  left: DispatchContext['requirement']['team_policy'],
  right: DispatchContext['requirement']['team_policy'],
): boolean {
  return (
    left.minimum_size === right.minimum_size &&
    left.maximum_size === right.maximum_size &&
    left.target_size === right.target_size
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recordNumber(value: unknown, key: string): number | null {
  return isRecord(value) && typeof value[key] === 'number' ? value[key] : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isCandidateDecision(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.recruiter_id) &&
    Number.isInteger(value.rank) &&
    ['auto', 'scheduled', 'suggestion'].includes(String(value.disposition)) &&
    (value.scheduled_for === null || isString(value.scheduled_for)) &&
    Array.isArray(value.reason_codes) &&
    value.reason_codes.every(isString) &&
    Array.isArray(value.source_block_reasons) &&
    value.source_block_reasons.every(isString) &&
    Array.isArray(value.warnings) &&
    value.warnings.every(isString)
  );
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toValidDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sanitizeStepKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 100);
}
