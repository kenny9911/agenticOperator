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
import { resolveCandidateMobile } from '@/lib/phone/normalize-e164';

export type WriteCandidateInput = {
  candidate_id: string;
  employee_id?: string | null;
  /** RoboHire parse-resume `data` object (or partner pre-parsed JSON). */
  parsed: Record<string, unknown>;
  /** Canonical phone returned by partner-pg save; null means no strong mobile. */
  normalized_phone?: string | null;
  /** Final values returned by a partner-PG phone-hit UPDATE. When present they
   * override RoboHire fields, preventing the graph identity from diverging
   * from the authoritative Candidate row. */
  persisted_candidate?: {
    name: string;
    mobile: string | null;
    mobile_normalized: string | null;
    email: string | null;
    gender: string | null;
    birth_date: Date | string | null;
    current_location: string | null;
    highest_acquired_degree: string | null;
    work_years: number | null;
    employee_id: string | null;
  } | null;
  // Candidate-lock mirror. resumeParserAgent passes the exact tuple returned by
  // Partner PG so the graph cannot independently reinterpret an RMHR event.
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
  const stored = input.persisted_candidate;
  const p: Record<string, unknown> = stored
    ? {
        name: stored.name,
        phone: stored.mobile_normalized ?? stored.mobile,
        email: stored.email,
        gender: stored.gender,
        birth_date: stored.birth_date,
        currentLocation: stored.current_location,
        highestDegree: stored.highest_acquired_degree,
        workYears: stored.work_years,
      }
    : input.parsed;
  const parsedName = nonEmptyString(p.name);
  const phone = resolveCandidateMobile(
    input.normalized_phone !== undefined
      ? input.normalized_phone
      : [p.phone, p.mobile, (p as Record<string, unknown>).phoneNumber],
  ).mobile;
  const address =
    nonEmptyString(p.address) ??
    nonEmptyString(p.currentLocation) ??
    nonEmptyString(p.location);
  const workYears = asNumberOrNull(p.workYears ?? p.experienceYears ?? p.work_years);
  const payload = compact({
    candidate_id: input.candidate_id,
    employee_id: nonEmptyString(stored?.employee_id ?? input.employee_id),
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
    // Lock-mirror fields are included when the caller supplies the Partner PG snapshot.
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
    parsedNameRaw: typeof input.parsed.name === 'string' ? input.parsed.name : null,
  };
}
