// Write Candidate instance to Neo4j via allmeta ontology API.
//
// Canonical schema (neo4j_data/objects_v0_1_015.json). Allmeta 严格校验:
// 多/错字段 → 整条 reject。所以严格 only canonical 字段:
//   candidate_id, employee_id, is_locked, lock_start_time, referrer_employee_id,
//   id_number, name, nationality, gender, birth_date, phone, email, address,
//   highest_acquired_degree, unified_enrollment, work_years (Float),
//   flight_risk_level, max_salary_limit, status, state, blacklist_status,
//   marital_status, conflict_of_interest_declaration, conflict_clearance_deadline,
//   gap_reason, previous_level, expected_degree, expected_graduation_date,
//   github, ethnicity, native_place

import {
  safeWriteInstance,
  compact,
  nonEmptyString,
  asNumberOrNull,
  asIsoDateOrNull,
  type WriteResult,
} from './_helpers';

export type WriteCandidateInput = {
  candidate_id: string;
  employee_id?: string | null;
  /** RoboHire parse-resume `data` object (or partner pre-parsed JSON). */
  parsed: Record<string, unknown>;
  // Candidate-lock mirror (2026-06-08, P4). Written ONLY when provided — existing
  // callers pass none, so compact() drops them and behavior is unchanged. When the
  // lock owner differs from the uploader, pass employee_id = the lock OWNER (工号).
  // ⚠️ Activation is partner-gated: confirm AO may write is_locked/lock_start_time
  // (currently '留 hsm 端填', see ao-to-allmeta.ts) and that Allmeta upserts rather
  // than replaces the instance, before wiring a caller to pass these.
  is_locked?: boolean | null;
  lock_start_time?: string | Date | null;
  blacklist_status?: string | null;
};

export type WriteCandidateResult = WriteResult & {
  /** True when name fell back to the '未命名候选人' placeholder (parser missed). */
  nameWasPlaceholder?: boolean;
  /** What the parser actually provided (for diagnostics). */
  parsedNameRaw?: string | null;
};

export async function writeCandidateInstance(
  input: WriteCandidateInput,
): Promise<WriteCandidateResult> {
  const p = input.parsed;
  const parsedName = nonEmptyString(p.name);
  const phone =
    nonEmptyString(p.phone) ??
    nonEmptyString(p.mobile) ??
    nonEmptyString((p as Record<string, unknown>).phoneNumber);
  const address =
    nonEmptyString(p.address) ??
    nonEmptyString(p.currentLocation) ??
    nonEmptyString(p.location);
  const workYears = asNumberOrNull(p.workYears ?? p.experienceYears ?? p.work_years);
  const payload = compact({
    candidate_id: input.candidate_id,
    employee_id: nonEmptyString(input.employee_id),
    name: parsedName ?? '未命名候选人',
    phone,
    email: nonEmptyString(p.email),
    gender: nonEmptyString(p.gender),
    birth_date: asIsoDateOrNull(p.birthDate ?? p.birth_date),
    address,
    highest_acquired_degree:
      nonEmptyString(p.highestDegree) ??
      nonEmptyString(
        p.education &&
          Array.isArray(p.education) &&
          (p.education[0] as Record<string, unknown>)?.degree,
      ),
    work_years: workYears,
    // Lock-mirror fields — included only when the caller provides them (P4).
    ...(input.is_locked !== undefined ? { is_locked: input.is_locked ?? undefined } : {}),
    ...(input.lock_start_time !== undefined
      ? { lock_start_time: asIsoDateOrNull(input.lock_start_time) }
      : {}),
    ...(input.blacklist_status !== undefined
      ? { blacklist_status: nonEmptyString(input.blacklist_status) }
      : {}),
  });

  const result = await safeWriteInstance('Candidate', payload);
  return {
    ...result,
    nameWasPlaceholder: !parsedName,
    parsedNameRaw: typeof p.name === 'string' ? p.name : null,
  };
}
