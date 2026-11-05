import type {
  DispatchCandidate,
  DispatchCandidateDecision,
  DispatchContext,
  DispatchDecision,
  DispatchExcludedCandidate,
  DispatchReasonCode,
  DispatchResponsibilityLevel,
  DispatchWarningCode,
} from './types';

export type {
  DispatchCandidate,
  DispatchCandidateDecision,
  DispatchContext,
  DispatchDecision,
  DispatchExcludedCandidate,
} from './types';

type RankedCandidate = {
  recruiterId: string;
  disposition: DispatchCandidateDecision['disposition'];
  scheduledFor: string | null;
  reasonCodes: DispatchReasonCode[];
  sourceBlockReasons: string[];
  warnings: DispatchWarningCode[];
  responsibilityPriority: number;
  skillScore: number;
  preferenceScore: number;
};

/**
 * Deterministically plans one recruiter team from an immutable RAAS v2 snapshot.
 *
 * RAAS resolves standard-taxonomy capability relative to this JR. AO treats only
 * `confirmed_match` as automatic evidence. Skill overlap and personal preference
 * sort already-eligible recruiters and never expand permission or dispatchability.
 */
export function decideRecruiterDispatch(
  context: DispatchContext,
  _now: Date = new Date(),
): DispatchDecision {
  const contextVersion = clean(context.context_version);
  const globalReasons: DispatchReasonCode[] = [];
  const globalWarnings: DispatchWarningCode[] = [];

  if (!contextVersion) {
    globalReasons.push('CONTEXT_VERSION_MISSING');
    globalWarnings.push('CONTEXT_VERSION_REQUIRED');
  }
  if (context.rules_status === 'suggestion_only') {
    globalReasons.push('RULES_SUGGESTION_ONLY');
    globalWarnings.push('RULES_UNAVAILABLE');
  }
  if (!context.write_guards.legacy_auto_claim_disabled) {
    globalReasons.push('LEGACY_AUTO_CLAIM_ACTIVE');
    globalWarnings.push('DUAL_WRITER_RISK');
  }

  const activeCounts = new Map<string, number>();
  for (const claim of context.requirement.active_recruiter_claims) {
    const recruiterId = clean(claim.recruiter_id);
    if (recruiterId) {
      activeCounts.set(recruiterId, (activeCounts.get(recruiterId) ?? 0) + 1);
    }
  }
  const activeRecruiterIds = [...activeCounts.keys()].sort(compareText);
  if ([...activeCounts.values()].some((count) => count > 1)) {
    globalReasons.push('DUPLICATE_ACTIVE_RECRUITER_CLAIM');
    globalWarnings.push('ACTIVE_CLAIM_REVIEW_REQUIRED');
  }

  const teamPolicy = context.requirement.team_policy;
  const currentTeamSize = activeRecruiterIds.length;
  if (currentTeamSize >= teamPolicy.target_size) {
    return buildDecision({
      contextVersion,
      teamPolicy,
      activeRecruiterIds,
      outcome: 'team_complete',
      additions: [],
      candidates: [],
      excluded: [],
      plannedTeamSize: currentTeamSize,
      minimumGap: 0,
      waitUntil: null,
      reasons: ['TEAM_TARGET_MET', ...globalReasons],
      warnings: globalWarnings,
    });
  }

  const recruiterCounts = new Map<string, number>();
  for (const candidate of context.candidates) {
    const recruiterId = clean(candidate.recruiter_id);
    if (recruiterId) {
      recruiterCounts.set(recruiterId, (recruiterCounts.get(recruiterId) ?? 0) + 1);
    }
  }

  const ranked: RankedCandidate[] = [];
  const excluded: DispatchExcludedCandidate[] = [];

  for (const candidate of context.candidates) {
    const recruiterId = clean(candidate.recruiter_id);
    const eligibility = candidate.eligibility;
    const sourceBlockReasons = uniqueClean(eligibility.block_reasons);
    const reasons: DispatchReasonCode[] = [];
    const warnings: DispatchWarningCode[] = [];

    if (!recruiterId) reasons.push('RECRUITER_ID_MISSING');
    if (recruiterId && activeCounts.has(recruiterId)) {
      reasons.push('ACTIVE_RECRUITER_ALREADY_CLAIMED');
    }
    if (recruiterId && (recruiterCounts.get(recruiterId) ?? 0) > 1) {
      reasons.push('DUPLICATE_RECRUITER_CONTEXT');
    }
    if (!eligibility.has_recruiter_role) reasons.push('RECRUITER_ROLE_REQUIRED');
    if (!eligibility.is_active) reasons.push('EMPLOYMENT_NOT_ACTIVE');

    if (eligibility.permission === 'denied') {
      reasons.push('PERMISSION_DENIED');
    } else if (eligibility.permission === 'unknown') {
      reasons.push('PERMISSION_UNKNOWN');
      warnings.push('PERMISSION_REVIEW_REQUIRED');
    }

    if (eligibility.bg_boundary === 'denied') {
      reasons.push('BG_BOUNDARY_DENIED');
    } else if (eligibility.bg_boundary === 'unknown') {
      reasons.push('BG_BOUNDARY_UNKNOWN');
      warnings.push('BG_BOUNDARY_REVIEW_REQUIRED');
    }

    if (eligibility.capacity === 'full') {
      reasons.push('CAPACITY_FULL');
    } else if (eligibility.capacity === 'unknown') {
      reasons.push('CAPACITY_UNKNOWN');
      warnings.push('CAPACITY_REVIEW_REQUIRED');
    } else {
      reasons.push('CAPACITY_AVAILABLE');
    }

    if (eligibility.suspension === 'suspended') {
      reasons.push('DISPATCH_SUSPENDED');
    } else if (eligibility.suspension === 'unknown') {
      reasons.push('SUSPENSION_UNKNOWN');
      warnings.push('SUSPENSION_REVIEW_REQUIRED');
    } else {
      reasons.push('SUSPENSION_CLEAR');
    }

    if (eligibility.manual_lock === 'locked') {
      reasons.push('MANUALLY_LOCKED');
    } else if (eligibility.manual_lock === 'unknown') {
      reasons.push('MANUAL_LOCK_UNKNOWN');
      warnings.push('MANUAL_LOCK_REVIEW_REQUIRED');
    } else {
      reasons.push('MANUAL_LOCK_CLEAR');
    }

    if (candidate.job_capability.status === 'no_match') {
      reasons.push('JOB_CAPABILITY_NO_MATCH');
    } else if (candidate.job_capability.status === 'suggested_match') {
      reasons.push('JOB_CAPABILITY_SUGGESTED_MATCH');
      warnings.push('CAPABILITY_REVIEW_REQUIRED');
    } else if (candidate.job_capability.status === 'unknown') {
      reasons.push('JOB_CAPABILITY_UNKNOWN');
      warnings.push('CAPABILITY_REVIEW_REQUIRED');
    } else {
      reasons.push('JOB_CAPABILITY_CONFIRMED_MATCH');
    }

    let scheduledFor: string | null = null;
    if (eligibility.availability === 'available') {
      reasons.push('AVAILABLE_NOW');
    } else if (eligibility.availability === 'scheduled') {
      const availableAt = toValidDate(eligibility.available_at);
      const safeStart = toValidDate(context.requirement.latest_safe_start_at);
      if (!availableAt) {
        reasons.push('AVAILABLE_AT_UNKNOWN');
        warnings.push('AVAILABILITY_REVIEW_REQUIRED');
      } else if (!safeStart) {
        reasons.push('LATEST_SAFE_START_UNKNOWN');
        warnings.push('AVAILABILITY_REVIEW_REQUIRED');
      } else if (availableAt.getTime() > safeStart.getTime()) {
        reasons.push('SCHEDULE_EXCEEDS_LATEST_SAFE_START');
      } else {
        reasons.push('SCHEDULED_WITHIN_SAFE_START');
        warnings.push('WAKE_AND_REFRESH_BEFORE_ASSIGNMENT');
        // Even a past timestamp is not present availability. The workflow wakes
        // immediately and reloads RAAS rather than trusting a stale leave record.
        scheduledFor = availableAt.toISOString();
      }
    } else if (eligibility.availability === 'unknown') {
      reasons.push('AVAILABILITY_UNKNOWN');
      warnings.push('AVAILABILITY_REVIEW_REQUIRED');
    } else {
      reasons.push('AVAILABILITY_UNAVAILABLE');
    }

    const hardReasons = reasons.filter(isHardExclusionReason);
    if (hardReasons.length > 0) {
      excluded.push({
        recruiter_id: recruiterId || 'unknown',
        reason_codes: unique(hardReasons),
        source_block_reasons: sourceBlockReasons,
        warnings: unique(warnings),
      });
      continue;
    }

    const autoSnapshotReady =
      eligibility.availability === 'available' &&
      eligibility.dispatchable &&
      sourceBlockReasons.length === 0;
    const scheduledRefreshOnly =
      eligibility.availability === 'scheduled' &&
      !eligibility.dispatchable &&
      scheduledFor != null &&
      sourceBlockReasons.length === 1 &&
      sourceBlockReasons[0] === 'availability_scheduled';
    let suggestionOnly = globalReasons.length > 0;
    if (
      eligibility.permission !== 'allowed' ||
      eligibility.bg_boundary !== 'allowed' ||
      eligibility.capacity !== 'available' ||
      eligibility.suspension !== 'clear' ||
      eligibility.manual_lock !== 'clear' ||
      candidate.job_capability.status !== 'confirmed_match' ||
      (!autoSnapshotReady && !scheduledRefreshOnly)
    ) {
      suggestionOnly = true;
    }

    // `dispatchable` is RAAS's deterministic present-tense gate. Scheduled
    // availability is the sole exception because AO may only wait then reload;
    // it still never writes the scheduled snapshot.
    if (!autoSnapshotReady && !scheduledRefreshOnly) {
      reasons.push('RAAS_NOT_DISPATCHABLE');
      warnings.push('RAAS_ELIGIBILITY_REVIEW_REQUIRED');
      suggestionOnly = true;
    }

    const skillScore = normalizedSet(candidate.job_capability.skill_tag_overlap).size;
    reasons.push(skillScore > 0 ? 'SKILL_TAG_MATCH' : 'SKILL_TAG_NO_MATCH');
    const preference = evaluatePreference(candidate.auto_claim_preference);
    reasons.push(preference.reason);
    reasons.push(responsibilityReason(candidate.responsibility.level));

    const disposition: RankedCandidate['disposition'] = suggestionOnly
      ? 'suggestion'
      : scheduledFor
        ? 'scheduled'
        : 'auto';

    ranked.push({
      recruiterId,
      disposition,
      scheduledFor,
      reasonCodes: unique([...reasons, ...globalReasons]),
      sourceBlockReasons,
      warnings: unique([...warnings, ...globalWarnings]),
      responsibilityPriority: normalizedResponsibilityPriority(candidate),
      skillScore,
      preferenceScore: preference.score,
    });
  }

  excluded.sort((left, right) => compareText(left.recruiter_id, right.recruiter_id));
  const automatic = ranked
    .filter((candidate) => candidate.disposition === 'auto')
    .sort(compareRankedCandidates);
  const scheduled = ranked
    .filter((candidate) => candidate.disposition === 'scheduled')
    .sort(compareRankedCandidates);
  const suggestions = ranked
    .filter((candidate) => candidate.disposition === 'suggestion')
    .sort(compareRankedCandidates);
  // Present availability wins over any scheduled preference: reaching the
  // minimum now must never be delayed for a higher-ranked returning recruiter.
  const ordered = [...automatic, ...scheduled, ...suggestions];
  const candidateDecisions = ordered
    .slice(0, teamPolicy.maximum_size)
    .map(toDecisionCandidate);

  const slotsToTarget = Math.max(0, teamPolicy.target_size - currentTeamSize);
  const immediateEligibleSize = currentTeamSize + Math.min(automatic.length, slotsToTarget);
  const minimumGap = Math.max(0, teamPolicy.minimum_size - immediateEligibleSize);

  if (immediateEligibleSize >= teamPolicy.minimum_size) {
    const selectedIds = new Set(
      automatic.slice(0, slotsToTarget).map((candidate) => candidate.recruiterId),
    );
    const additions = candidateDecisions
      .filter((candidate) => selectedIds.has(candidate.recruiter_id))
      .map(withAutoSelectionReason);
    const candidates = candidateDecisions.map((candidate) =>
      selectedIds.has(candidate.recruiter_id)
        ? withAutoSelectionReason(candidate)
        : candidate,
    );
    const plannedTeamSize = currentTeamSize + additions.length;
    const gap = Math.max(0, teamPolicy.target_size - plannedTeamSize);

    return buildDecision({
      contextVersion,
      teamPolicy,
      activeRecruiterIds,
      outcome: additions.length > 0 ? 'auto_assign_team' : 'team_gap',
      additions,
      candidates,
      excluded,
      plannedTeamSize,
      minimumGap: 0,
      waitUntil: null,
      reasons: unique([
        ...(additions.length > 0 ? ['AUTO_CANDIDATE_SELECTED' as const] : []),
        ...(gap > 0 ? ['TEAM_TARGET_GAP' as const] : ['TEAM_TARGET_MET' as const]),
        ...globalReasons,
      ]),
      warnings: unique([
        ...(gap > 0 ? ['TEAM_TARGET_GAP' as const] : []),
        ...globalWarnings,
      ]),
    });
  }

  const waitUntil = earliestTimeMeetingMinimum(scheduled, minimumGap);
  if (waitUntil) {
    const waitCandidates = candidateDecisions.map((candidate) =>
      candidate.disposition === 'scheduled' &&
      candidate.scheduled_for != null &&
      candidate.scheduled_for <= waitUntil
        ? {
            ...candidate,
            reason_codes: unique(['SCHEDULED_CANDIDATE_SELECTED', ...candidate.reason_codes]),
          }
        : candidate,
    );
    return buildDecision({
      contextVersion,
      teamPolicy,
      activeRecruiterIds,
      outcome: 'wait_for_refresh',
      additions: [],
      candidates: waitCandidates,
      excluded,
      plannedTeamSize: currentTeamSize,
      minimumGap,
      waitUntil,
      reasons: unique([
        'TEAM_MINIMUM_NOT_MET',
        'WAITING_FOR_SCHEDULED_RECRUITER',
        ...globalReasons,
      ]),
      warnings: unique(['WAKE_AND_REFRESH_BEFORE_ASSIGNMENT', ...globalWarnings]),
    });
  }

  return buildDecision({
    contextVersion,
    teamPolicy,
    activeRecruiterIds,
    outcome: 'resource_gap',
    additions: [],
    candidates: candidateDecisions,
    excluded,
    plannedTeamSize: currentTeamSize,
    minimumGap,
    waitUntil: null,
    reasons: unique([
      'TEAM_MINIMUM_NOT_MET',
      ...(ordered.length === 0 ? ['NO_ELIGIBLE_CANDIDATE' as const] : []),
      ...globalReasons,
    ]),
    warnings: unique(['TEAM_RESOURCE_GAP', ...globalWarnings]),
  });
}

function buildDecision(input: {
  contextVersion: string;
  teamPolicy: DispatchContext['requirement']['team_policy'];
  activeRecruiterIds: readonly string[];
  outcome: DispatchDecision['outcome'];
  additions: readonly DispatchCandidateDecision[];
  candidates: readonly DispatchCandidateDecision[];
  excluded: readonly DispatchExcludedCandidate[];
  plannedTeamSize: number;
  minimumGap: number;
  waitUntil: string | null;
  reasons: readonly DispatchReasonCode[];
  warnings: readonly DispatchWarningCode[];
}): DispatchDecision {
  return {
    contract_version: 2,
    context_version: input.contextVersion,
    outcome: input.outcome,
    team_policy: input.teamPolicy,
    active_recruiter_ids: input.activeRecruiterIds,
    additions: input.additions,
    candidates: input.candidates,
    excluded: input.excluded,
    current_team_size: input.activeRecruiterIds.length,
    planned_team_size: input.plannedTeamSize,
    gap: Math.max(0, input.teamPolicy.target_size - input.plannedTeamSize),
    minimum_gap: input.minimumGap,
    wait_until: input.waitUntil,
    reason_codes: unique(input.reasons),
    warnings: unique(input.warnings),
  };
}

function evaluatePreference(state: DispatchCandidate['auto_claim_preference']): {
  score: number;
  reason: DispatchReasonCode;
} {
  if (state === 'confirmed') {
    return { score: 2, reason: 'AUTO_CLAIM_PREFERENCE_CONFIRMED' };
  }
  if (state === 'unconfirmed') {
    return { score: 1, reason: 'AUTO_CLAIM_PREFERENCE_UNCONFIRMED' };
  }
  return { score: 0, reason: 'AUTO_CLAIM_PREFERENCE_ABSENT' };
}

function responsibilityReason(level: DispatchResponsibilityLevel): DispatchReasonCode {
  switch (level) {
    case 'department_primary':
      return 'DEPARTMENT_PRIMARY';
    case 'client_primary':
      return 'CLIENT_PRIMARY';
    case 'department_backup':
      return 'DEPARTMENT_BACKUP';
    case 'client_backup':
      return 'CLIENT_BACKUP';
    default:
      return 'NO_CONFIGURED_RESPONSIBILITY';
  }
}

function normalizedResponsibilityPriority(candidate: DispatchCandidate): number {
  if (Number.isFinite(candidate.responsibility.priority)) {
    return candidate.responsibility.priority;
  }
  return {
    department_primary: 400,
    client_primary: 300,
    department_backup: 200,
    client_backup: 100,
    none: 0,
  }[candidate.responsibility.level];
}

function earliestTimeMeetingMinimum(
  scheduled: readonly RankedCandidate[],
  missingSeats: number,
): string | null {
  if (missingSeats <= 0) return null;
  const byReturn = scheduled
    .filter((candidate): candidate is RankedCandidate & { scheduledFor: string } =>
      Boolean(candidate.scheduledFor),
    )
    .sort((left, right) =>
      compareText(left.scheduledFor, right.scheduledFor) ||
      compareRankedCandidates(left, right),
    );
  return byReturn.length >= missingSeats ? byReturn[missingSeats - 1].scheduledFor : null;
}

function isHardExclusionReason(reason: DispatchReasonCode): boolean {
  return [
    'RECRUITER_ID_MISSING',
    'ACTIVE_RECRUITER_ALREADY_CLAIMED',
    'DUPLICATE_RECRUITER_CONTEXT',
    'RECRUITER_ROLE_REQUIRED',
    'EMPLOYMENT_NOT_ACTIVE',
    'PERMISSION_DENIED',
    'BG_BOUNDARY_DENIED',
    'CAPACITY_FULL',
    'DISPATCH_SUSPENDED',
    'MANUALLY_LOCKED',
    'JOB_CAPABILITY_NO_MATCH',
    'SCHEDULE_EXCEEDS_LATEST_SAFE_START',
    'AVAILABILITY_UNAVAILABLE',
  ].includes(reason);
}

function compareRankedCandidates(left: RankedCandidate, right: RankedCandidate): number {
  return (
    right.responsibilityPriority - left.responsibilityPriority ||
    right.skillScore - left.skillScore ||
    right.preferenceScore - left.preferenceScore ||
    compareText(left.recruiterId, right.recruiterId)
  );
}

function toDecisionCandidate(
  candidate: RankedCandidate,
  index: number,
): DispatchCandidateDecision {
  return {
    recruiter_id: candidate.recruiterId,
    rank: index + 1,
    disposition: candidate.disposition,
    scheduled_for: candidate.scheduledFor,
    reason_codes: candidate.reasonCodes,
    source_block_reasons: candidate.sourceBlockReasons,
    warnings: candidate.warnings,
  };
}

function withAutoSelectionReason(
  candidate: DispatchCandidateDecision,
): DispatchCandidateDecision {
  return {
    ...candidate,
    reason_codes: unique(['AUTO_CANDIDATE_SELECTED', ...candidate.reason_codes]),
  };
}

function normalizedSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => clean(value).toLowerCase()).filter(Boolean));
}

function uniqueClean(values: readonly string[]): string[] {
  return unique(values.map(clean).filter(Boolean));
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toValidDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
