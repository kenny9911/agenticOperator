/**
 * Pure, snapshot-based recruiter team dispatch contracts.
 *
 * These types intentionally mirror RAAS recruiter-dispatch contract v2. AO does
 * not accept a legacy shape or carry names/PII into ranking.
 */

export type DispatchEvidenceState = 'confirmed' | 'unconfirmed' | 'absent';
export type DispatchRulesStatus = 'ready' | 'suggestion_only';
export type DispatchPermission = 'allowed' | 'denied' | 'unknown';
export type DispatchBgBoundary = 'allowed' | 'denied' | 'unknown';
export type DispatchAvailability = 'available' | 'scheduled' | 'unavailable' | 'unknown';
export type DispatchCapacity = 'available' | 'full' | 'unknown';
export type DispatchSuspension = 'clear' | 'suspended' | 'unknown';
export type DispatchManualLock = 'clear' | 'locked' | 'unknown';

export type DispatchResponsibilityLevel =
  | 'department_primary'
  | 'client_primary'
  | 'department_backup'
  | 'client_backup'
  | 'none';

export interface DispatchTeamPolicy {
  readonly minimum_size: 2;
  readonly maximum_size: 4;
  readonly target_size: 2 | 3 | 4;
}

export interface DispatchActiveRecruiterClaim {
  readonly claim_id: string;
  readonly recruiter_id: string;
  readonly claimed_at: string;
}

export interface DispatchCapability {
  readonly capability_id: string;
  readonly taxonomy_level: 'family' | 'group' | 'sequence' | 'role' | string;
  readonly family: string | null;
  readonly group: string | null;
  readonly sequence: string | null;
  readonly standard_job_role_id: string | null;
  readonly scope_key: string;
  readonly skill_tags: readonly string[];
  readonly status: 'suggested' | 'confirmed' | string;
  readonly source_type: string;
}

export interface DispatchCandidate {
  readonly recruiter_id: string;
  readonly responsibility: {
    readonly level: DispatchResponsibilityLevel;
    readonly priority: number;
    readonly responsibility_id: string | null;
  };
  readonly capabilities: readonly DispatchCapability[];
  /**
   * RAAS resolves each declaration at its own taxonomy level relative to this
   * JR. AO consumes this deterministic result and never requires one profile to
   * populate family, group, sequence and role simultaneously.
   */
  readonly job_capability: {
    readonly status: 'confirmed_match' | 'suggested_match' | 'no_match' | 'unknown';
    readonly matched_scope_keys: readonly string[];
    readonly matched_taxonomy_levels: readonly string[];
    /** Soft ranking only; never changes eligibility. */
    readonly skill_tag_overlap: readonly string[];
  };
  /** Soft willingness only; never expands permission or eligibility. */
  readonly auto_claim_preference: DispatchEvidenceState;
  readonly eligibility: {
    readonly has_recruiter_role: boolean;
    readonly is_active: boolean;
    readonly permission: DispatchPermission;
    readonly bg_boundary: DispatchBgBoundary;
    readonly availability: DispatchAvailability;
    readonly available_at: string | null;
    readonly capacity: DispatchCapacity;
    readonly suspension: DispatchSuspension;
    readonly manual_lock: DispatchManualLock;
    readonly dispatchable: boolean;
    readonly block_reasons: readonly string[];
  };
}

export interface DispatchRequirement {
  readonly job_requisition_id: string;
  readonly client_id: string | null;
  readonly client_department_id: string | null;
  readonly csi_department_id: string | null;
  readonly service_bg: string | null;
  readonly bg_id: string | null;
  readonly latest_safe_start_at: string | null;
  readonly required_capability: {
    readonly family: string | null;
    readonly group: string | null;
    readonly sequence: string | null;
    readonly standard_job_role_id: string | null;
    readonly skill_tags: readonly string[];
  };
  readonly team_policy: DispatchTeamPolicy;
  readonly active_recruiter_claims: readonly DispatchActiveRecruiterClaim[];
}

export interface DispatchContext {
  readonly contract_version: 2;
  /** Version read by AO and checked again atomically by RAAS before writing. */
  readonly context_version: string;
  readonly rules_status: DispatchRulesStatus;
  /** Live RAAS proof that no legacy RequirementClaim writer can race this run. */
  readonly write_guards: {
    readonly legacy_auto_claim_disabled: boolean;
  };
  readonly requirement: DispatchRequirement;
  readonly candidates: readonly DispatchCandidate[];
}

export type DispatchReasonCode =
  | 'TEAM_TARGET_MET'
  | 'TEAM_TARGET_GAP'
  | 'TEAM_MINIMUM_NOT_MET'
  | 'WAITING_FOR_SCHEDULED_RECRUITER'
  | 'ACTIVE_RECRUITER_ALREADY_CLAIMED'
  | 'AUTO_CANDIDATE_SELECTED'
  | 'SCHEDULED_CANDIDATE_SELECTED'
  | 'NO_ELIGIBLE_CANDIDATE'
  | 'RULES_SUGGESTION_ONLY'
  | 'LEGACY_AUTO_CLAIM_ACTIVE'
  | 'CONTEXT_VERSION_MISSING'
  | 'RECRUITER_ID_MISSING'
  | 'DUPLICATE_RECRUITER_CONTEXT'
  | 'DUPLICATE_ACTIVE_RECRUITER_CLAIM'
  | 'RECRUITER_ROLE_REQUIRED'
  | 'EMPLOYMENT_NOT_ACTIVE'
  | 'PERMISSION_DENIED'
  | 'PERMISSION_UNKNOWN'
  | 'BG_BOUNDARY_DENIED'
  | 'BG_BOUNDARY_UNKNOWN'
  | 'AVAILABLE_NOW'
  | 'SCHEDULED_WITHIN_SAFE_START'
  | 'SCHEDULE_EXCEEDS_LATEST_SAFE_START'
  | 'AVAILABILITY_UNAVAILABLE'
  | 'AVAILABILITY_UNKNOWN'
  | 'AVAILABLE_AT_UNKNOWN'
  | 'LATEST_SAFE_START_UNKNOWN'
  | 'CAPACITY_AVAILABLE'
  | 'CAPACITY_FULL'
  | 'CAPACITY_UNKNOWN'
  | 'SUSPENSION_CLEAR'
  | 'DISPATCH_SUSPENDED'
  | 'SUSPENSION_UNKNOWN'
  | 'MANUAL_LOCK_CLEAR'
  | 'MANUALLY_LOCKED'
  | 'MANUAL_LOCK_UNKNOWN'
  | 'RAAS_NOT_DISPATCHABLE'
  | 'JOB_CAPABILITY_CONFIRMED_MATCH'
  | 'JOB_CAPABILITY_SUGGESTED_MATCH'
  | 'JOB_CAPABILITY_NO_MATCH'
  | 'JOB_CAPABILITY_UNKNOWN'
  | 'SKILL_TAG_MATCH'
  | 'SKILL_TAG_NO_MATCH'
  | 'AUTO_CLAIM_PREFERENCE_CONFIRMED'
  | 'AUTO_CLAIM_PREFERENCE_UNCONFIRMED'
  | 'AUTO_CLAIM_PREFERENCE_ABSENT'
  | 'DEPARTMENT_PRIMARY'
  | 'CLIENT_PRIMARY'
  | 'DEPARTMENT_BACKUP'
  | 'CLIENT_BACKUP'
  | 'NO_CONFIGURED_RESPONSIBILITY';

export type DispatchWarningCode =
  | 'RULES_UNAVAILABLE'
  | 'DUAL_WRITER_RISK'
  | 'CONTEXT_VERSION_REQUIRED'
  | 'PERMISSION_REVIEW_REQUIRED'
  | 'BG_BOUNDARY_REVIEW_REQUIRED'
  | 'AVAILABILITY_REVIEW_REQUIRED'
  | 'CAPACITY_REVIEW_REQUIRED'
  | 'SUSPENSION_REVIEW_REQUIRED'
  | 'MANUAL_LOCK_REVIEW_REQUIRED'
  | 'CAPABILITY_REVIEW_REQUIRED'
  | 'ACTIVE_CLAIM_REVIEW_REQUIRED'
  | 'RAAS_ELIGIBILITY_REVIEW_REQUIRED'
  | 'TEAM_RESOURCE_GAP'
  | 'TEAM_TARGET_GAP'
  | 'WAKE_AND_REFRESH_BEFORE_ASSIGNMENT';

export type DispatchCandidateDisposition = 'auto' | 'scheduled' | 'suggestion';

export interface DispatchCandidateDecision {
  readonly recruiter_id: string;
  readonly rank: number;
  readonly disposition: DispatchCandidateDisposition;
  readonly scheduled_for: string | null;
  readonly reason_codes: readonly DispatchReasonCode[];
  readonly source_block_reasons: readonly string[];
  readonly warnings: readonly DispatchWarningCode[];
}

export interface DispatchExcludedCandidate {
  readonly recruiter_id: string;
  readonly reason_codes: readonly DispatchReasonCode[];
  readonly source_block_reasons: readonly string[];
  readonly warnings: readonly DispatchWarningCode[];
}

export type DispatchOutcome =
  | 'team_complete'
  | 'auto_assign_team'
  | 'wait_for_refresh'
  | 'resource_gap'
  | 'team_gap';

export interface DispatchDecision {
  readonly contract_version: 2;
  readonly context_version: string;
  readonly outcome: DispatchOutcome;
  readonly team_policy: DispatchTeamPolicy;
  readonly active_recruiter_ids: readonly string[];
  /** New recruiters planned for one atomic `/assign-team` write. */
  readonly additions: readonly DispatchCandidateDecision[];
  /** Bounded ranked audit view; additions are also present here. */
  readonly candidates: readonly DispatchCandidateDecision[];
  readonly excluded: readonly DispatchExcludedCandidate[];
  readonly current_team_size: number;
  readonly planned_team_size: number;
  /** Remaining seats to the target after applying `additions`. */
  readonly gap: number;
  /** Missing immediately eligible seats before the minimum can be reached. */
  readonly minimum_gap: number;
  /** Scheduled availability is advisory; the handler must reload after waking. */
  readonly wait_until: string | null;
  readonly reason_codes: readonly DispatchReasonCode[];
  readonly warnings: readonly DispatchWarningCode[];
}
