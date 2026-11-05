import { describe, expect, it } from 'vitest';
import { decideRecruiterDispatch } from './decision';
import type { DispatchCandidate, DispatchContext } from './types';

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
        standard_job_role_id: 'ROLE-WEB-FRONTEND',
        scope_key: 'role:ROLE-WEB-FRONTEND',
        skill_tags: ['Vue'],
        status: 'confirmed',
        source_type: 'manual',
      },
    ],
    job_capability: {
      status: 'confirmed_match',
      matched_scope_keys: ['role:ROLE-WEB-FRONTEND'],
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

function context(
  candidates: readonly DispatchCandidate[],
  overrides: Partial<DispatchContext> = {},
): DispatchContext {
  return {
    contract_version: 2,
    context_version: 'Context-V2',
    rules_status: 'ready',
    write_guards: { legacy_auto_claim_disabled: true },
    requirement: {
      job_requisition_id: 'JR-1',
      client_id: 'CLIENT-TENCENT',
      client_department_id: 'DEPT-WXG',
      csi_department_id: 'CSI-TENCENT',
      service_bg: 'BG-ASG',
      bg_id: 'BG-ASG',
      latest_safe_start_at: '2026-08-04T09:00:00.000Z',
      required_capability: {
        family: 'FAMILY-DEV',
        group: 'GROUP-FRONTEND',
        sequence: 'SEQUENCE-WEB',
        standard_job_role_id: 'ROLE-WEB-FRONTEND',
        skill_tags: ['Vue'],
      },
      team_policy: {
        minimum_size: 2,
        maximum_size: 4,
        target_size: 2,
      },
      active_recruiter_claims: [],
    },
    candidates,
    ...overrides,
  };
}

describe('decideRecruiterDispatch v2 team planning', () => {
  it('一次规划达到目标的 additions 数组，并按 RAAS responsibility priority 稳定排序', () => {
    const clientPrimary = candidate('Recruiter-B', {
      responsibility: {
        level: 'client_primary',
        priority: 300,
        responsibility_id: 'RESP-B',
      },
    });
    const departmentPrimary = candidate('Recruiter-A');

    const decision = decideRecruiterDispatch(
      context([clientPrimary, departmentPrimary]),
      new Date('2026-08-02T09:00:00.000Z'),
    );

    expect(decision).toMatchObject({
      contract_version: 2,
      context_version: 'Context-V2',
      outcome: 'auto_assign_team',
      current_team_size: 0,
      planned_team_size: 2,
      gap: 0,
      minimum_gap: 0,
      wait_until: null,
    });
    expect(decision.additions.map((item) => item.recruiter_id)).toEqual([
      'Recruiter-A',
      'Recruiter-B',
    ]);
    expect(decision.additions[0]).toMatchObject({ disposition: 'auto', rank: 1 });
    expect(decision.additions[0].reason_codes).toEqual(
      expect.arrayContaining([
        'AUTO_CANDIDATE_SELECTED',
        'DEPARTMENT_PRIMARY',
        'JOB_CAPABILITY_CONFIRMED_MATCH',
      ]),
    );
  });

  it('已有 active claim 计入团队且不再短路，继续补足 target', () => {
    const base = context([]);
    const decision = decideRecruiterDispatch(
      context([candidate('Recruiter-A'), candidate('Recruiter-B')], {
        requirement: {
          ...base.requirement,
          active_recruiter_claims: [
            {
              claim_id: 'CLAIM-EXISTING',
              recruiter_id: 'Recruiter-Existing',
              claimed_at: '2026-08-01T00:00:00.000Z',
            },
          ],
          team_policy: { minimum_size: 2, maximum_size: 4, target_size: 3 },
        },
      }),
    );

    expect(decision.outcome).toBe('auto_assign_team');
    expect(decision.active_recruiter_ids).toEqual(['Recruiter-Existing']);
    expect(decision.additions.map((item) => item.recruiter_id)).toEqual([
      'Recruiter-A',
      'Recruiter-B',
    ]);
    expect(decision).toMatchObject({
      current_team_size: 1,
      planned_team_size: 3,
      gap: 0,
    });
  });

  it('已有 active claims 满足 target 时零写', () => {
    const base = context([]);
    const decision = decideRecruiterDispatch(
      context([candidate('Recruiter-C')], {
        requirement: {
          ...base.requirement,
          active_recruiter_claims: [
            {
              claim_id: 'CLAIM-A',
              recruiter_id: 'Recruiter-A',
              claimed_at: '2026-08-01T00:00:00.000Z',
            },
            {
              claim_id: 'CLAIM-B',
              recruiter_id: 'Recruiter-B',
              claimed_at: '2026-08-01T00:00:00.000Z',
            },
          ],
        },
      }),
    );

    expect(decision).toMatchObject({
      outcome: 'team_complete',
      additions: [],
      current_team_size: 2,
      planned_team_size: 2,
      gap: 0,
    });
  });

  it('零 active claim 且只有一名可自动派单招聘时，整批零写并返回 resource_gap', () => {
    const decision = decideRecruiterDispatch(context([candidate('Recruiter-Only')]));

    expect(decision).toMatchObject({
      outcome: 'resource_gap',
      additions: [],
      current_team_size: 0,
      planned_team_size: 0,
      gap: 2,
      minimum_gap: 1,
      wait_until: null,
    });
    expect(decision.reason_codes).toContain('TEAM_MINIMUM_NOT_MET');
    expect(decision.warnings).toContain('TEAM_RESOURCE_GAP');
  });

  it('达到 minimum 但未达到 target 时可批量写，并显式保留 target gap', () => {
    const base = context([]);
    const decision = decideRecruiterDispatch(
      context([candidate('Recruiter-B')], {
        requirement: {
          ...base.requirement,
          active_recruiter_claims: [
            {
              claim_id: 'CLAIM-A',
              recruiter_id: 'Recruiter-A',
              claimed_at: '2026-08-01T00:00:00.000Z',
            },
          ],
          team_policy: { minimum_size: 2, maximum_size: 4, target_size: 4 },
        },
      }),
    );

    expect(decision).toMatchObject({
      outcome: 'auto_assign_team',
      current_team_size: 1,
      planned_team_size: 2,
      gap: 2,
      minimum_gap: 0,
    });
    expect(decision.additions.map((item) => item.recruiter_id)).toEqual(['Recruiter-B']);
    expect(decision.reason_codes).toContain('TEAM_TARGET_GAP');
    expect(decision.warnings).toContain('TEAM_TARGET_GAP');
  });

  it('scheduled 只在即时团队不足 minimum 时产生 wait_for_refresh，且 additions 始终为空', () => {
    const scheduledFor = '2026-08-03T01:00:00.000Z';
    const returningPrimary = candidate('Recruiter-Returning', {
      eligibility: {
        ...candidate('base').eligibility,
        availability: 'scheduled',
        available_at: scheduledFor,
        dispatchable: false,
        block_reasons: ['availability_scheduled'],
      },
    });
    const available = candidate('Recruiter-Available', {
      responsibility: {
        level: 'client_backup',
        priority: 100,
        responsibility_id: 'RESP-AVAILABLE',
      },
    });

    const waiting = decideRecruiterDispatch(
      context([available, returningPrimary]),
      new Date('2026-08-02T01:00:00.000Z'),
    );
    expect(waiting).toMatchObject({
      outcome: 'wait_for_refresh',
      additions: [],
      planned_team_size: 0,
      minimum_gap: 1,
      wait_until: scheduledFor,
    });

    const enoughNow = decideRecruiterDispatch(
      context([available, candidate('Recruiter-Second'), returningPrimary]),
      new Date('2026-08-02T01:00:00.000Z'),
    );
    expect(enoughNow.outcome).toBe('auto_assign_team');
    expect(enoughNow.wait_until).toBeNull();
    expect(enoughNow.additions.map((item) => item.recruiter_id)).toEqual([
      'Recruiter-Second',
      'Recruiter-Available',
    ]);
  });

  it('RAAS 规范分类 no_match 是硬排除，即使 skill overlap 命中也不能入队', () => {
    const wrongStandardRole = candidate('Recruiter-Wrong-Role', {
      job_capability: {
        status: 'no_match',
        matched_scope_keys: [],
        matched_taxonomy_levels: [],
        skill_tag_overlap: ['Vue'],
      },
    });

    const decision = decideRecruiterDispatch(
      context([wrongStandardRole, candidate('Recruiter-A'), candidate('Recruiter-B')]),
    );

    expect(decision.additions.map((item) => item.recruiter_id)).toEqual([
      'Recruiter-A',
      'Recruiter-B',
    ]);
    expect(decision.excluded).toContainEqual(
      expect.objectContaining({
        recruiter_id: 'Recruiter-Wrong-Role',
        reason_codes: expect.arrayContaining(['JOB_CAPABILITY_NO_MATCH']),
      }),
    );
  });

  it('skill_tag_overlap 只软排序：零 overlap 仍可自动入队，命中者排在前面', () => {
    const noSkillMatch = candidate('Recruiter-A-No-Skill', {
      job_capability: {
        status: 'confirmed_match',
        matched_scope_keys: ['role:ROLE-WEB-FRONTEND'],
        matched_taxonomy_levels: ['role'],
        skill_tag_overlap: [],
      },
    });
    const skillMatch = candidate('Recruiter-Z-Skill');

    const decision = decideRecruiterDispatch(context([noSkillMatch, skillMatch]));

    expect(decision.additions.map((item) => item.recruiter_id)).toEqual([
      'Recruiter-Z-Skill',
      'Recruiter-A-No-Skill',
    ]);
    expect(decision.additions[1].reason_codes).toContain('SKILL_TAG_NO_MATCH');
    expect(decision.excluded.map((item) => item.recruiter_id)).not.toContain(
      'Recruiter-A-No-Skill',
    );
  });

  it('个人 auto-claim 偏好只排序且不扩权', () => {
    const preferred = candidate('Recruiter-Z-Preferred', {
      auto_claim_preference: 'confirmed',
    });
    const neutral = candidate('Recruiter-A-Neutral');
    const outOfScope = candidate('Recruiter-Out-Of-Scope', {
      auto_claim_preference: 'confirmed',
      eligibility: {
        ...candidate('base').eligibility,
        permission: 'denied',
        dispatchable: false,
        block_reasons: ['permission_denied'],
      },
    });

    const decision = decideRecruiterDispatch(context([neutral, outOfScope, preferred]));

    expect(decision.additions.map((item) => item.recruiter_id)).toEqual([
      'Recruiter-Z-Preferred',
      'Recruiter-A-Neutral',
    ]);
    expect(decision.additions[0].reason_codes).toContain(
      'AUTO_CLAIM_PREFERENCE_CONFIRMED',
    );
    expect(decision.excluded).toContainEqual(
      expect.objectContaining({ recruiter_id: 'Recruiter-Out-Of-Scope' }),
    );
  });

  it('只接受冻结的 block_reasons 语义：auto 必须为空，scheduled 必须仅含 availability_scheduled', () => {
    const futureBlocked = candidate('Recruiter-Future-Blocked', {
      eligibility: {
        ...candidate('base').eligibility,
        dispatchable: true,
        block_reasons: ['FUTURE_GUARD_UNKNOWN_TO_AO'],
      },
    });
    const scheduledWithExtraBlock = candidate('Recruiter-Scheduled-Blocked', {
      eligibility: {
        ...candidate('base').eligibility,
        availability: 'scheduled',
        available_at: '2026-08-03T01:00:00.000Z',
        dispatchable: false,
        block_reasons: ['availability_scheduled', 'FUTURE_GUARD_UNKNOWN_TO_AO'],
      },
    });

    const decision = decideRecruiterDispatch(
      context([
        candidate('Recruiter-Only-Ready'),
        futureBlocked,
        scheduledWithExtraBlock,
      ]),
      new Date('2026-08-02T01:00:00.000Z'),
    );

    expect(decision.outcome).toBe('resource_gap');
    expect(decision.additions).toEqual([]);
    expect(decision.wait_until).toBeNull();
    expect(decision.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recruiter_id: 'Recruiter-Future-Blocked',
          disposition: 'suggestion',
          source_block_reasons: ['FUTURE_GUARD_UNKNOWN_TO_AO'],
        }),
        expect.objectContaining({
          recruiter_id: 'Recruiter-Scheduled-Blocked',
          disposition: 'suggestion',
        }),
      ]),
    );
  });

  it('不足 minimum 时等待第 minimum_gap 位 scheduled 返回时间', () => {
    const first = candidate('Recruiter-Scheduled-First', {
      eligibility: {
        ...candidate('base').eligibility,
        availability: 'scheduled',
        available_at: '2026-08-03T01:00:00.000Z',
        dispatchable: false,
        block_reasons: ['availability_scheduled'],
      },
    });
    const second = candidate('Recruiter-Scheduled-Second', {
      eligibility: {
        ...candidate('base').eligibility,
        availability: 'scheduled',
        available_at: '2026-08-03T03:00:00.000Z',
        dispatchable: false,
        block_reasons: ['availability_scheduled'],
      },
    });

    const decision = decideRecruiterDispatch(
      context([second, first]),
      new Date('2026-08-02T01:00:00.000Z'),
    );

    expect(decision).toMatchObject({
      outcome: 'wait_for_refresh',
      minimum_gap: 2,
      wait_until: '2026-08-03T03:00:00.000Z',
      additions: [],
    });
  });

  it('任一 unknown eligibility、suggested capability、规则 suggestion_only 或旧 writer 均禁止自动写', () => {
    const permissionUnknown = candidate('Recruiter-Permission-Unknown', {
      eligibility: {
        ...candidate('base').eligibility,
        permission: 'unknown',
        dispatchable: false,
        block_reasons: ['permission_unknown'],
      },
    });
    const capabilitySuggested = candidate('Recruiter-Capability-Suggested', {
      job_capability: {
        status: 'suggested_match',
        matched_scope_keys: ['family:FAMILY-DEV'],
        matched_taxonomy_levels: ['family'],
        skill_tag_overlap: ['Vue'],
      },
      // job_capability alone must keep this suggestion-only; operational
      // eligibility cannot promote suggested taxonomy evidence.
      eligibility: candidate('base').eligibility,
    });
    const decision = decideRecruiterDispatch(
      context([permissionUnknown, capabilitySuggested], {
        rules_status: 'suggestion_only',
        write_guards: { legacy_auto_claim_disabled: false },
      }),
    );

    expect(decision.outcome).toBe('resource_gap');
    expect(decision.additions).toEqual([]);
    expect(decision.reason_codes).toEqual(
      expect.arrayContaining([
        'TEAM_MINIMUM_NOT_MET',
        'RULES_SUGGESTION_ONLY',
        'LEGACY_AUTO_CLAIM_ACTIVE',
      ]),
    );
    expect(decision.candidates).toEqual(
      expect.arrayContaining([expect.objectContaining({ disposition: 'suggestion' })]),
    );
  });

  it('active recruiter 不会被重复加入，同 recruiter 的重复 active claims 使新增 fail closed', () => {
    const base = context([]);
    const decision = decideRecruiterDispatch(
      context(
        [candidate('Recruiter-A'), candidate('Recruiter-B'), candidate('Recruiter-C')],
        {
          requirement: {
            ...base.requirement,
            active_recruiter_claims: [
              {
                claim_id: 'CLAIM-A-1',
                recruiter_id: 'Recruiter-A',
                claimed_at: '2026-08-01T00:00:00.000Z',
              },
              {
                claim_id: 'CLAIM-A-2',
                recruiter_id: 'Recruiter-A',
                claimed_at: '2026-08-01T01:00:00.000Z',
              },
            ],
            team_policy: { minimum_size: 2, maximum_size: 4, target_size: 3 },
          },
        },
      ),
    );

    expect(decision.outcome).toBe('resource_gap');
    expect(decision.additions).toEqual([]);
    expect(decision.reason_codes).toContain('DUPLICATE_ACTIVE_RECRUITER_CLAIM');
    expect(decision.excluded).toContainEqual(
      expect.objectContaining({
        recruiter_id: 'Recruiter-A',
        reason_codes: expect.arrayContaining(['ACTIVE_RECRUITER_ALREADY_CLAIMED']),
      }),
    );
  });
});
