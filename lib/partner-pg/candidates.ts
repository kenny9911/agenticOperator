// lib/partner-pg/candidates.ts
//
// Direct SQL replacement for RAAS API POST /api/v1/candidates.
//
// Partner's processResumeIngest is a 500+ line orchestration that touches
// many tables and services (resumePipelineService, candidateService,
// auditLogService, outboxService, externalCandidatePoolService, etc.).
// Per 2026-05-20 architecture decision, we replicate the essential
// writes (candidate, optional candidate_expectation, resume, upload runtime)
// and SKIP all partner-side
// state-management side effects (runtime_state, audit_log, outbox event,
// blacklist re-check) — partner reconstructs those by subscribing to
// AO's RESUME_PROCESSED event.
//
// All persistence below is in one transaction:
//   1. UPSERT candidate     — dedup ONLY by a strong mainland mobile
//   2. UPSERT CandidateExpectation when RESUME_DOWNLOADED carries expectation_payload
//   3. UPSERT resume        — exact upload / (bucket_name, object_key) idempotency
//   4. SELECT application   — RAAS owns creation; AO only returns an existing id
//   5. UPDATE resume_upload_runtime to completed
//
// Partner source of truth (reference, DO NOT MODIFY):
//   raas_v4/backend/apps/api/src/modules/candidates/resume-ingest.service.ts
//   raas_v4/backend/prisma/schema.prisma (Candidate / Resume / Application)

import { randomUUID } from 'node:crypto';
import { withTx } from './client';
import { currentLogger } from '@/lib/agent-logger';
import {
  resolveCandidateMobile,
  type CandidateMobileStatus,
} from '@/lib/phone/normalize-e164';
import { canonicalGender, isDroppedGender } from '@/lib/gender/canonical-gender';
import {
  normalizeCandidateExpectationPayload,
  type CandidateExpectationPatch,
} from '@/lib/raas-v1/candidate-expectation';
import { parseRmhrLockTime } from '@/lib/rmhr/lock-time';
import {
  RMHR_MANUAL_IDENTITY_SOURCE,
  type RmhrManualCandidateIdentity,
} from '@/lib/raas-v1/resume-candidate-identity';

// ──────────────────────────────────────────────────────────────────────
// Input mirrors lib/raas-api-client.ts SaveCandidateInput so callers
// (resumeParserAgent) can swap in place.
// ──────────────────────────────────────────────────────────────────────

export type SaveCandidateInput = {
  upload_id: string;
  bucket: string;
  object_key: string;
  filename?: string;
  etag?: string | null;
  size?: number | null;
  employee_id?: string | null;
  /**
   * RMHR 锁持有人工号 — RESUME_DOWNLOADED 的 locked_by_employee_id 透传
   * (raas 2026-05-27 起发送)。非空时是归属权威 (per raas ADR-0041
   * "锁在他人则同步真实归属"): INSERT 直接用它做 candidate.employee_id,
   * dedup 命中时按锁时间防旧写。为空表示没有锁的正证据，不能回落上传者
   * 伪造 Candidate 归属，也不能解释为解锁命令。
   */
  locked_by_employee_id?: string | null;
  /** RMHR lockTime. Beijing wall-clock strings are normalized explicitly. */
  locked_at?: string | number | null;
  /** Event receive time used only when a positive lock omitted locked_at. */
  lock_observed_at?: string | number | null;
  hr_folder?: string | null;
  job_requisition_id?: string | null;
  client_id?: string | null;
  sourcing_channel_id?: string | null;
  /** RAAS RESUME_DOWNLOADED.payload.expectation_payload (partial, non-empty fields only). */
  expectation_payload?: CandidateExpectationPatch | null;
  /**
   * RMHR-accepted operator refill. This is Candidate identity input only;
   * `parsed` remains the untouched RoboHire evidence stored on Resume.
   */
  authoritative_identity?: RmhrManualCandidateIdentity | null;
  /** RoboHire parse-resume output (data field). */
  parsed?: {
    data?: {
      name?: string | null;
      email?: string | null;
      phone?: string | null;
      mobile?: string | null;
      gender?: string | null;
      currentLocation?: string | null;
      currentCompany?: string | null;
      currentTitle?: string | null;
      skills?: string[] | null;
      languages?: string[] | null;
      [key: string]: unknown;
    } | null;
  };
};

export type SaveCandidateResult = {
  candidate_id: string;
  resume_id: string;
  candidate_expectation_id: string | null;
  application_id: string | null;
  candidate_created: boolean;
  resume_created: boolean;
  /** Strong mainland 11-digit mobile persisted to both candidate phone columns. */
  mobile_normalized: string | null;
  mobile_review_status: CandidateMobileStatus;
  /** True when upload/object identity reused an already persisted candidate/resume. */
  idempotent_replay: boolean;
  /** Final partner-PG Candidate values for inserts, phone hits, and transport
   * replays. Allmeta uses this snapshot where parser identity must not win. */
  candidate_snapshot: PersistedCandidateSnapshot | null;
  /** Exact lock tuple read from or committed to partner PG. */
  candidate_lock_snapshot: CandidateLockSnapshot | null;
};

export type CandidateLockSnapshot = {
  employee_id: string | null;
  is_locked: boolean;
  lock_start_time: Date | string | null;
};

export type PersistedCandidateSnapshot = {
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
  is_locked: boolean;
  lock_start_time: Date | string | null;
};

/** Historical duplicate rows must be reconciled explicitly, never resolved by
 * silently choosing the oldest candidate. */
export class CandidateMobileConflictError extends Error {
  readonly code = 'CANDIDATE_MOBILE_CONFLICT';
  readonly candidateIds: string[];

  constructor(mobile: string, candidateIds: string[]) {
    const masked = `${mobile.slice(0, 3)}****${mobile.slice(-4)}`;
    super(
      `[partner-pg/candidates] ${masked} maps to multiple candidates: ${candidateIds.join(', ')}`,
    );
    this.name = 'CandidateMobileConflictError';
    this.candidateIds = candidateIds;
  }
}

/** One transport object must never resolve to multiple historical resumes. */
export class CandidateTransportConflictError extends Error {
  readonly code = 'CANDIDATE_TRANSPORT_CONFLICT';
  readonly resumeIds: string[];

  constructor(bucket: string, objectKey: string, resumeIds: string[]) {
    super(
      `[partner-pg/candidates] transport key ${bucket}/${objectKey} maps to multiple resumes: ${resumeIds.join(', ')}`,
    );
    this.name = 'CandidateTransportConflictError';
    this.resumeIds = resumeIds;
  }
}

// ──────────────────────────────────────────────────────────────────────
// 业务默认值 (2026-06-12, partner-pg c5f48e3)
// ──────────────────────────────────────────────────────────────────────

// raas candidate.status 的「求职中」枚举值。新建候选人默认求职中; dedup 命中
// 走 COALESCE 仅填空, 不覆盖招聘手动维护的状态。
const DEFAULT_CANDIDATE_STATUS = 'active';

// raas sourcing_channel 字典「BOSS直聘-AI」。上游 RESUME_DOWNLOADED 未带
// sourcing_channel_id 时的默认来源。
const DEFAULT_SOURCING_CHANNEL_ID = '02001034';

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function nonEmpty(s: unknown): string | null {
  return typeof s === 'string' && s.trim() ? s.trim() : null;
}

function firstLinkedExpectationId(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = nonEmpty(item);
      if (id) return id;
    }
    return null;
  }
  return nonEmpty(value);
}

const EXPECTATION_FIELDS = [
  'expected_position',
  'expected_location',
  'expected_salary_range',
  'outsourcing_acceptance_level',
  'expected_industry',
  'expected_company_size',
  'constraints',
] as const satisfies readonly (keyof CandidateExpectationPatch)[];


/** Coerce unknown → string[]. Filters falsy. */
function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x.trim() : nonEmpty(x as unknown)))
    .filter((x): x is string => !!x);
}

/**
 * Flatten RoboHire skills object → text[] suitable for resume.skills_extracted.
 * Shape from /parse-resume:
 *   { technical: string[], soft: string[], tools: string[],
 *     languages: string[], domain: string[], other: string[] }
 * Plain string[] is also tolerated.
 */
function flattenSkills(v: unknown): string[] {
  if (Array.isArray(v)) return toStringArray(v);
  if (v && typeof v === 'object') {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const bucket of Object.values(v as Record<string, unknown>)) {
      for (const s of toStringArray(bucket)) {
        if (!seen.has(s)) {
          seen.add(s);
          out.push(s);
        }
      }
    }
    return out;
  }
  return [];
}

/**
 * RoboHire certifications may arrive as either string[] (legacy) or
 * an array of objects ({ name, issuer, year }). RAAS `resume.certifications`
 * is a text[]; we coerce to the display name in either case.
 */
function flattenCertifications(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      if (typeof x === 'string') return x.trim();
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        return nonEmpty(o.name) ?? nonEmpty(o.title) ?? nonEmpty(o.certification);
      }
      return null;
    })
    .filter((x): x is string => !!x);
}

/**
 * Languages: same dual-shape handling — sometimes string[] of language names,
 * sometimes [{ name, proficiency }, …]. resume.languages is text[].
 */
function flattenLanguages(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => {
      if (typeof x === 'string') return x.trim();
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        return nonEmpty(o.name) ?? nonEmpty(o.language);
      }
      return null;
    })
    .filter((x): x is string => !!x);
}

/**
 * Find the most recent experience entry (no end date OR latest endDate) so we
 * can patch candidate.current_company / current_title even when the parse
 * payload doesn't surface them at top level.
 */
function pickLatestExperience(
  exp: unknown,
): { company: string | null; title: string | null } {
  if (!Array.isArray(exp) || exp.length === 0) return { company: null, title: null };
  const items = exp.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  const open = items.find((it) => {
    const end = nonEmpty(it.endDate);
    return !end || /present|至今|current|now/i.test(end);
  });
  const winner = open ?? items
    .slice()
    .sort((a, b) => String(b.endDate ?? '').localeCompare(String(a.endDate ?? '')))[0];
  if (!winner) return { company: null, title: null };
  return {
    company: nonEmpty(winner.company),
    title: nonEmpty(winner.role) ?? nonEmpty(winner.title) ?? nonEmpty(winner.position),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Main entry
// ──────────────────────────────────────────────────────────────────────

export async function saveCandidateToPartnerPg(
  input: SaveCandidateInput,
): Promise<SaveCandidateResult> {
  if (!input.upload_id) throw new Error('[partner-pg/candidates] missing upload_id');
  if (!input.bucket) throw new Error('[partner-pg/candidates] missing bucket');
  if (!input.object_key) throw new Error('[partner-pg/candidates] missing object_key');

  // RAAS publishes sourcing_channel_id on RESUME_DOWNLOADED — upstream value
  // wins when present. 2026-06-12 业务决策 (c5f48e3): 上游缺失时默认回填
  // BOSS直聘-AI (02001034), 不再让 NULL 落库 (取代旧的"不回填以暴露断链"策略
  // —— AO 管道的简历实际来源即 BOSS直聘 AI 投递)。
  const sourcingChannelId =
    nonEmpty(input.sourcing_channel_id) ?? DEFAULT_SOURCING_CHANNEL_ID;
  const uploadedBy = nonEmpty(input.employee_id);
  // Candidate 的三个 RMHR 锁字段是一个原子事实。只有持锁人非空才是锁定正证据；
  // 上传者属于 resume.uploaded_by 的文件级语义，不能拿来填 Candidate.employee_id。
  // locked_at 优先；RMHR 旧响应缺时间时用事件 received_at，最后才以本次处理时刻
  // 为新 Candidate 建立非空锁时间。dedup UPDATE 对有效时间做防旧写。
  const lockedBy = nonEmpty(input.locked_by_employee_id);
  const hasIncomingLock = lockedBy !== null;
  const incomingLockStartTime = hasIncomingLock
    ? parseRmhrLockTime(input.locked_at) ?? parseRmhrLockTime(input.lock_observed_at)
    : null;
  const newCandidateLockStartTime = hasIncomingLock
    ? incomingLockStartTime ?? new Date()
    : null;

  const parsed = input.parsed?.data ?? {};
  const authoritativeIdentity =
    input.authoritative_identity?.source === RMHR_MANUAL_IDENTITY_SOURCE
      ? input.authoritative_identity
      : null;
  const authoritativeName = nonEmpty(authoritativeIdentity?.name);
  const authoritativePhone = nonEmpty(authoritativeIdentity?.phone);
  const name = authoritativeName ?? nonEmpty(parsed.name) ?? '未命名候选人';
  // Candidate identity accepts exactly one strong mainland mobile. All aliases
  // are resolved together so Postgres / Allmeta cannot silently choose different
  // fields. Unusable raw values stay in resume.raw_parse_result only.
  const mobileResolution = authoritativePhone
    ? resolveCandidateMobile(authoritativePhone)
    : resolveCandidateMobile([
        parsed.mobile,
        parsed.phone,
        (parsed as Record<string, unknown>).phoneNumber,
      ]);
  const mobile = mobileResolution.mobile;
  const mobile_normalized = mobileResolution.mobile;
  const needsMobileReview = mobileResolution.status !== 'valid';
  const email = nonEmpty(parsed.email);
  // Partner constrains the column to 'male' | 'female' | NULL
  // (candidate_gender_canonical_check). The parser reports whatever the résumé
  // says — '男', '⼥', '♂', '性别：邱杰' — and one unmapped string would abort the
  // whole ingest transaction, losing Candidate + Resume over a cosmetic field.
  // Unmappable values become NULL; the raw string survives in raw_parse_result.
  const genderRaw = parsed.gender;
  const gender = canonicalGender(genderRaw);
  if (isDroppedGender(genderRaw)) {
    // Value-free log — a junk gender is sometimes a misplaced name ('性别：邱杰').
    // upload_id is enough to pull the literal from resume.raw_parse_result and
    // decide whether the token table in lib/gender/canonical-gender.ts needs it.
    currentLogger()?.event('partner_pg.gender_dropped', {
      upload_id: input.upload_id,
      raw_length: String(genderRaw).length,
    });
  }

  // Structured-column derivations from the RoboHire parse-resume output.
  // These map 1:1 to partner Postgres `resume.*` columns so RAAS readers
  // (which read the structured columns, NOT raw_parse_result) actually see
  // the parse output.
  const parsedAny = parsed as Record<string, unknown>;
  const rawText = nonEmpty(parsedAny.rawText) ?? nonEmpty(parsedAny.raw_text);
  const summaryText = nonEmpty(parsedAny.summary);
  const skillsExtracted = flattenSkills(parsedAny.skills);
  const certificationsList = flattenCertifications(parsedAny.certifications);
  const languagesList = flattenLanguages(parsedAny.languages);
  const workHistory = Array.isArray(parsedAny.experience) ? parsedAny.experience : [];
  const educationHistory = Array.isArray(parsedAny.education) ? parsedAny.education : [];
  const projectHistory = Array.isArray(parsedAny.projects) ? parsedAny.projects : [];
  const awardsJson = Array.isArray(parsedAny.awards) ? parsedAny.awards : [];
  const skillsDetailJson = parsedAny.skills && typeof parsedAny.skills === 'object' ? parsedAny.skills : null;
  const certificationsDetailJson = Array.isArray(parsedAny.certifications) ? parsedAny.certifications : [];
  const languagesDetailJson = Array.isArray(parsedAny.languages) ? parsedAny.languages : [];
  const latestExp = pickLatestExperience(parsedAny.experience);
  const currentCompany = nonEmpty(parsedAny.currentCompany) ?? latestExp.company;
  const currentTitle = nonEmpty(parsedAny.currentTitle) ?? latestExp.title;
  const currentLocation = nonEmpty(parsedAny.currentLocation) ?? nonEmpty(parsedAny.address);
  const expectationPatch = normalizeCandidateExpectationPayload(input.expectation_payload);

  return withTx<SaveCandidateResult>(async (c) => {
    // Processing idempotency is deliberately separate from identity dedup:
    // serialize one upload first, then reuse its already-written target. A pending
    // or absent runtime row falls back to the stable transport key. Neither route
    // grants permission to alter Candidate identity fields from replayed parse data.
    await c.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`upload:${input.upload_id}`],
    );
    const runtimeTarget = await c.query<{
      candidate_id: string | null;
      resume_id: string | null;
      status: string | null;
    }>(
      `SELECT candidate_id, resume_id, status
         FROM resume_upload_runtime
        WHERE upload_id = $1
        FOR UPDATE`,
      [input.upload_id],
    );
    const runtime = runtimeTarget.rows[0] ?? null;
    let idempotentCandidateId = nonEmpty(runtime?.candidate_id);
    let idempotentResumeId = nonEmpty(runtime?.resume_id);

    if (runtime?.status === 'completed' && (!idempotentCandidateId || !idempotentResumeId)) {
      throw new Error(
        `[partner-pg/candidates] completed upload ${input.upload_id} has incomplete candidate/resume anchors`,
      );
    }

    if (!runtime || runtime.status !== 'completed') {
      await c.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`transport:${JSON.stringify([input.bucket, input.object_key])}`],
      );
      const transported = await c.query<{ resume_id: string; candidate_id: string }>(
        `SELECT resume_id, candidate_id
           FROM resume
          WHERE bucket_name = $1 AND object_key = $2
          ORDER BY created_at ASC
          LIMIT 2
          FOR UPDATE`,
        [input.bucket, input.object_key],
      );
      if (transported.rows.length > 1) {
        throw new CandidateTransportConflictError(
          input.bucket,
          input.object_key,
          transported.rows.map((row) => row.resume_id),
        );
      }
      const transportTarget = transported.rows[0] ?? null;
      if (
        transportTarget &&
        idempotentCandidateId &&
        idempotentCandidateId !== transportTarget.candidate_id
      ) {
        throw new Error(
          `[partner-pg/candidates] upload ${input.upload_id} candidate anchor conflicts with its transport resume`,
        );
      }
      if (
        transportTarget &&
        idempotentResumeId &&
        idempotentResumeId !== transportTarget.resume_id
      ) {
        throw new Error(
          `[partner-pg/candidates] upload ${input.upload_id} resume anchor conflicts with its transport key`,
        );
      }
      if (!transportTarget && (idempotentCandidateId || idempotentResumeId)) {
        throw new Error(
          `[partner-pg/candidates] unfinished upload ${input.upload_id} carries unproven candidate/resume anchors`,
        );
      }
      idempotentCandidateId ??= transportTarget?.candidate_id ?? null;
      idempotentResumeId ??= transportTarget?.resume_id ?? null;
    }

    // ── Step 1: UPSERT candidate ──
    // Identity contract:
    //   - one strong mainland mobile is the ONLY dedup signal;
    //   - missing/invalid/placeholder/ambiguous phone always creates a new row.
    // Email, name and Candidate Identity Agent judgments are never candidate keys.
    let candidate_id: string | null = idempotentCandidateId;
    let candidate_created = false;
    const idempotentReplay = candidate_id !== null;
    let savedMobileResolution = mobileResolution;
    let candidateSnapshot: PersistedCandidateSnapshot | null = null;
    let candidateLockSnapshot: CandidateLockSnapshot | null = null;

    if (candidate_id) {
      const target = await c.query<PersistedCandidateSnapshot>(
        `SELECT name, mobile, mobile_normalized, email, gender, birth_date,
                current_location, highest_acquired_degree, work_years,
                employee_id, is_locked,
                lock_start_time AT TIME ZONE 'UTC' AS lock_start_time
           FROM candidate
          WHERE candidate_id = $1
          FOR UPDATE`,
        [candidate_id],
      );
      if (target.rows.length !== 1) {
        throw new Error(
          `[partner-pg/candidates] idempotency target candidate ${candidate_id} does not exist`,
        );
      }
      savedMobileResolution = resolveCandidateMobile([
        target.rows[0].mobile,
        target.rows[0].mobile_normalized,
      ]);
      // A transport/upload replay must not rewrite Candidate, but it still
      // returns the exact persisted row so an Allmeta mirror can be repaired
      // safely when the event is delivered again.
      candidateSnapshot = target.rows[0];
      candidateLockSnapshot = {
        employee_id: candidateSnapshot.employee_id,
        is_locked: candidateSnapshot.is_locked,
        lock_start_time: candidateSnapshot.lock_start_time,
      };
    }

    if (!idempotentReplay && mobile_normalized) {
      // Serialize AO writers for the same phone inside the transaction. This
      // closes the local SELECT→INSERT race; a partner-wide UNIQUE index is still
      // required before multiple independent RAAS writers can share the invariant.
      await c.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [mobile_normalized],
      );
      const existing = await c.query<{ candidate_id: string }>(
        `SELECT candidate_id FROM candidate
          WHERE mobile_normalized = $1
          ORDER BY created_at ASC LIMIT 2`,
        [mobile_normalized],
      );
      if (existing.rows.length > 1) {
        throw new CandidateMobileConflictError(
          mobile_normalized,
          existing.rows.map((row) => row.candidate_id),
        );
      }
      candidate_id = existing.rows[0]?.candidate_id ?? null;
    }

    if (!candidate_id) {
      candidate_id = randomUUID();
      candidate_created = true;
      await c.query(
        `INSERT INTO candidate (
            candidate_id, name, mobile, mobile_normalized, email, gender,
            current_location, current_company, current_title,
            skills, languages,
            sourcing_channel_id, employee_id, data_source, status,
            needs_mobile_review, is_locked, lock_start_time,
            created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9,
            $10::text[], $11::text[],
            $12, $13, $14, $15,
            $16, $17, ($18::timestamptz AT TIME ZONE 'UTC'),
            NOW(), NOW()
          )`,
        [
          candidate_id,
          name,
          mobile,
          mobile_normalized,
          email,
          gender,
          currentLocation,
          currentCompany,
          currentTitle,
          skillsExtracted,
          languagesList,
          sourcingChannelId,
          lockedBy,
          'agentic_operator',
          DEFAULT_CANDIDATE_STATUS,
          needsMobileReview,
          hasIncomingLock,
          newCandidateLockStartTime,
        ],
      );
      candidateLockSnapshot = {
        employee_id: lockedBy,
        is_locked: hasIncomingLock,
        lock_start_time: newCandidateLockStartTime,
      };
      candidateSnapshot = {
        name,
        mobile,
        mobile_normalized,
        email,
        gender,
        birth_date: null,
        current_location: currentLocation,
        highest_acquired_degree: null,
        work_years: null,
        employee_id: lockedBy,
        is_locked: hasIncomingLock,
        lock_start_time: newCandidateLockStartTime,
      };
    } else if (!idempotentReplay) {
      // This branch is reachable only through a valid canonical-phone hit. Write
      // both phone columns directly so historical formatting drift cannot survive.
      // Phone-only dedup must not let a parser variation overwrite an established
      // real name. Only fill an empty / placeholder name automatically.
      //
      // $13 标记"事件带 RMHR 锁持有人"，$15 是规范化的锁时间。三字段共用同一
      // freshness gate，避免旧锁覆盖较新的现役锁；无持锁人只代表无正证据，保持
      // Candidate 既有锁三元组。status 仍只填空，不覆盖招聘手工状态。
      const incomingNameForUpdate = name === '未命名候选人' ? null : name;
      const updated = await c.query<PersistedCandidateSnapshot>(
        `UPDATE candidate SET
            mobile = $2,
            mobile_normalized = $3,
            needs_mobile_review = false,
            email = COALESCE($4, email),
            current_location = COALESCE($5, current_location),
            current_company = COALESCE($6, current_company),
            current_title = COALESCE($7, current_title),
            skills = CASE WHEN COALESCE(array_length(skills, 1), 0) = 0
                          THEN $8::text[] ELSE skills END,
            languages = CASE WHEN COALESCE(array_length(languages, 1), 0) = 0
                             THEN $9::text[] ELSE languages END,
            sourcing_channel_id = COALESCE(sourcing_channel_id, $10),
            employee_id = CASE
              WHEN $13::boolean AND (
                (($15::timestamptz AT TIME ZONE 'UTC') IS NOT NULL AND (
                  lock_start_time IS NULL OR
                  lock_start_time <= ($15::timestamptz AT TIME ZONE 'UTC')
                )) OR
                ($15::timestamptz IS NULL AND is_locked IS DISTINCT FROM true)
              ) THEN $11
              ELSE employee_id
            END,
            is_locked = CASE
              WHEN $13::boolean AND (
                (($15::timestamptz AT TIME ZONE 'UTC') IS NOT NULL AND (
                  lock_start_time IS NULL OR
                  lock_start_time <= ($15::timestamptz AT TIME ZONE 'UTC')
                )) OR
                ($15::timestamptz IS NULL AND is_locked IS DISTINCT FROM true)
              ) THEN true
              ELSE is_locked
            END,
            lock_start_time = CASE
              WHEN $13::boolean AND (
                (($15::timestamptz AT TIME ZONE 'UTC') IS NOT NULL AND (
                  lock_start_time IS NULL OR
                  lock_start_time <= ($15::timestamptz AT TIME ZONE 'UTC')
                )) OR
                ($15::timestamptz IS NULL AND is_locked IS DISTINCT FROM true)
              ) THEN COALESCE(
                ($15::timestamptz AT TIME ZONE 'UTC'),
                NOW()
              )
              ELSE lock_start_time
            END,
            data_source = COALESCE(data_source, 'agentic_operator'),
            name = CASE WHEN name = '未命名候选人' OR name IS NULL
                        THEN COALESCE($12, name) ELSE name END,
            status = COALESCE(status, $14),
            updated_at = NOW()
         WHERE candidate_id = $1
         RETURNING name, mobile, mobile_normalized, email, gender, birth_date,
                   current_location, highest_acquired_degree, work_years,
                   employee_id, is_locked,
                   lock_start_time AT TIME ZONE 'UTC' AS lock_start_time`,
        [
          candidate_id,
          mobile,
          mobile_normalized,
          email,
          currentLocation,
          currentCompany,
          currentTitle,
          skillsExtracted,
          languagesList,
          sourcingChannelId,
          lockedBy,
          incomingNameForUpdate,
          hasIncomingLock,
          DEFAULT_CANDIDATE_STATUS,
          incomingLockStartTime,
        ],
      );
      if (updated.rows.length !== 1) {
        throw new Error(
          `[partner-pg/candidates] canonical-phone target ${candidate_id} disappeared before update`,
        );
      }
      candidateSnapshot = updated.rows[0];
      candidateLockSnapshot = {
        employee_id: candidateSnapshot.employee_id,
        is_locked: candidateSnapshot.is_locked,
        lock_start_time: candidateSnapshot.lock_start_time,
      };
    }

    // ── Step 2: UPSERT candidate_expectation from RAAS upload payload ──
    //
    // Mirrors CandidateService.upsertCandidateExpectation:
    //   - project onto the seven public fields;
    //   - reuse the first linked id when one exists;
    //   - otherwise mint an id, insert, and link candidate.candidate_expectation_id.
    //
    // SELECT ... FOR UPDATE serializes two concurrent uploads for the same
    // candidate so they cannot create two "first" expectation rows.
    let candidate_expectation_id: string | null = null;
    if (expectationPatch && !idempotentReplay) {
      const linked = await c.query<{ candidate_expectation_id: unknown }>(
        `SELECT candidate_expectation_id
           FROM candidate
          WHERE candidate_id = $1
          FOR UPDATE`,
        [candidate_id],
      );
      const existingExpectationId = firstLinkedExpectationId(
        linked.rows[0]?.candidate_expectation_id,
      );
      candidate_expectation_id = existingExpectationId ?? randomUUID();

      const entries = EXPECTATION_FIELDS.flatMap((field) =>
        expectationPatch[field] === undefined
          ? []
          : [[field, expectationPatch[field]] as const],
      );
      const columns = entries.map(([field]) => field);
      const valuePlaceholders = entries.map(
        ([field], index) => `$${index + 3}${field === 'constraints' ? '::text[]' : ''}`,
      );
      const updateAssignments = entries.map(
        ([field]) => `${field} = EXCLUDED.${field}`,
      );

      await c.query(
        `INSERT INTO candidate_expectation (
            candidate_expectation_id, candidate_id, ${columns.join(', ')},
            created_at, updated_at
          ) VALUES (
            $1, $2, ${valuePlaceholders.join(', ')},
            NOW(), NOW()
          )
          ON CONFLICT (candidate_expectation_id) DO UPDATE SET
            candidate_id = EXCLUDED.candidate_id,
            ${updateAssignments.join(',\n            ')},
            updated_at = NOW()`,
        [
          candidate_expectation_id,
          candidate_id,
          ...entries.map(([, value]) => value),
        ],
      );

      if (!existingExpectationId) {
        await c.query(
          `UPDATE candidate SET
              candidate_expectation_id = ARRAY[$2]::text[],
              updated_at = NOW()
           WHERE candidate_id = $1`,
          [candidate_id, candidate_expectation_id],
        );
      }
    }

    // ── Step 3: insert once or refresh the exact idempotency-target resume ──
    let resume_id: string;
    let resume_created = false;
    if (idempotentResumeId) {
      resume_id = idempotentResumeId;
      const refreshed = await c.query<{ resume_id: string }>(
        `UPDATE resume SET
            raw_parse_result      = $2::jsonb,
            parsed_content        = $3,
            summary               = $4,
            skills_extracted      = $5::text[],
            languages             = $6::text[],
            certifications        = $7::text[],
            work_history          = $8::jsonb,
            education_history     = $9::jsonb,
            project_history       = $10::jsonb,
            awards                = $11::jsonb,
            skills_detail         = $12::jsonb,
            certifications_detail = $13::jsonb,
            languages_detail      = $14::jsonb,
            uploaded_by           = COALESCE(uploaded_by, $15),
            parse_status          = 'completed',
            parse_error           = NULL,
            updated_at            = NOW()
         WHERE resume_id = $1
           AND candidate_id = $16
           AND bucket_name = $17
           AND object_key = $18
         RETURNING resume_id`,
        [
          resume_id,
          JSON.stringify(input.parsed?.data ?? null),
          rawText,
          summaryText,
          skillsExtracted,
          languagesList,
          certificationsList,
          JSON.stringify(workHistory),
          JSON.stringify(educationHistory),
          JSON.stringify(projectHistory),
          JSON.stringify(awardsJson),
          JSON.stringify(skillsDetailJson),
          JSON.stringify(certificationsDetailJson),
          JSON.stringify(languagesDetailJson),
          uploadedBy,
          candidate_id,
          input.bucket,
          input.object_key,
        ],
      );
      if (refreshed.rows.length !== 1) {
        throw new Error(
          `[partner-pg/candidates] idempotency resume ${resume_id} no longer matches candidate/transport anchors`,
        );
      }
    } else {
      resume_id = randomUUID();
      resume_created = true;
      await c.query(
        `INSERT INTO resume (
            resume_id, candidate_id,
            file_name, file_size,
            bucket_name, object_key,
            raw_parse_result, parsed_content, summary,
            skills_extracted, languages, certifications,
            work_history, education_history, project_history,
            awards, skills_detail, certifications_detail, languages_detail,
            uploaded_by, parse_status,
            uploaded_at, created_at, updated_at
          ) VALUES (
            $1, $2,
            $3, $4,
            $5, $6,
            $7::jsonb, $8, $9,
            $10::text[], $11::text[], $12::text[],
            $13::jsonb, $14::jsonb, $15::jsonb,
            $16::jsonb, $17::jsonb, $18::jsonb, $19::jsonb,
            $20, 'completed',
            NOW(), NOW(), NOW()
          )`,
        [
          resume_id,
          candidate_id,
          nonEmpty(input.filename),
          typeof input.size === 'number' ? input.size : null,
          input.bucket,
          input.object_key,
          JSON.stringify(input.parsed?.data ?? null),
          rawText,
          summaryText,
          skillsExtracted,
          languagesList,
          certificationsList,
          JSON.stringify(workHistory),
          JSON.stringify(educationHistory),
          JSON.stringify(projectHistory),
          JSON.stringify(awardsJson),
          JSON.stringify(skillsDetailJson),
          JSON.stringify(certificationsDetailJson),
          JSON.stringify(languagesDetailJson),
          uploadedBy,
        ],
      );
    }

    // A replay may refresh only its proven Resume/runtime rows; it must not write
    // any Candidate column (including relationship pointers).
    if (!idempotentReplay) {
      await c.query(
        `UPDATE candidate SET latest_resume_id = $2, updated_at = NOW() WHERE candidate_id = $1`,
        [candidate_id, resume_id],
      );
    }

    // ── Step 4: look up existing application (RAAS owns creation) ──
    // 2026-05-21: AO no longer creates Application rows — RAAS does that on
    // its own side, and our INSERT was producing duplicates in the RAAS UI.
    // We still SELECT here so downstream events (RESUME_PROCESSED) can
    // carry a real application_id when RAAS already created the row by
    // the time we run. If they haven't yet, we emit application_id=null
    // and RAAS back-fills when its own Application creation lands.
    let application_id: string | null = null;
    if (input.job_requisition_id) {
      const existing = await c.query<{ application_id: string }>(
        `SELECT application_id FROM application
          WHERE candidate_id = $1 AND job_requisition_id = $2
          LIMIT 1`,
        [candidate_id, input.job_requisition_id],
      );
      application_id = existing.rows[0]?.application_id ?? null;
    }

    // ── Step 5: advance resume_upload_runtime ──
    // This is partner's state-machine table that RAAS UI / processors watch
    // to know "upload_id X is parsed". RAAS pre-inserts the row with
    // status='pending', external_lock_state='locked' when the upload arrives,
    // then waits for AO to set status='completed' + back-fill candidate_id
    // and resume_id. Without this step every candidate we write is invisible
    // to RAAS.
    //
    // application_id is intentionally NOT touched here — RAAS owns Application
    // creation (2026-05-21) and will back-fill that FK column itself when its
    // own Application row lands. Writing it from AO would race the RAAS path
    // and risk clobbering a non-null value with null.
    //
    // Idempotent — if RAAS hasn't inserted a row for this upload_id (e.g. AO
    // is run against a fresh DB or the upload came through a non-RAAS path),
    // the UPDATE simply hits 0 rows and we move on; no INSERT here because
    // partner owns the row's mandatory fields (filename, file_path, etc.).
    await c.query(
      `UPDATE resume_upload_runtime SET
          status         = 'completed',
          candidate_id   = $1,
          resume_id      = $2,
          error_message  = NULL,
          updated_at     = NOW()
       WHERE upload_id = $3`,
      [candidate_id, resume_id, input.upload_id],
    );

    return {
      candidate_id,
      resume_id,
      candidate_expectation_id,
      application_id,
      candidate_created,
      resume_created,
      mobile_normalized: savedMobileResolution.mobile,
      mobile_review_status: savedMobileResolution.status,
      idempotent_replay: idempotentReplay,
      candidate_snapshot: candidateSnapshot,
      candidate_lock_snapshot: candidateLockSnapshot,
    };
  });
}

/**
 * Mark a resume_upload_runtime row as failed so partner / RAAS UI sees the
 * upload as terminal-error instead of stuck in 'pending'. Non-transactional,
 * called from the agent's catch path. No-op if the row doesn't exist or a prior
 * successful attempt already completed it with durable anchors.
 */
export async function markResumeUploadFailed(
  uploadId: string,
  errorMessage: string,
): Promise<void> {
  if (!uploadId) return;
  const { query } = await import('./client');
  await query(
    `UPDATE resume_upload_runtime SET
        status        = 'failed',
        error_message = $2,
        updated_at    = NOW()
     WHERE upload_id = $1
       AND status IS DISTINCT FROM 'completed'`,
    [uploadId, errorMessage.slice(0, 1000)],
  );
}
