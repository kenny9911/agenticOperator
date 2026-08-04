// lib/partner-pg/job-posting.ts
//
// Direct SQL replacement for RAAS API POST /api/v1/jd/sync-generated.
// Mirrors raas_v4/.../jd-sync.service.ts:syncJdGenerated steps 1-3.
// HSM notification + jd_review HitlTask are created by RAAS after it consumes
// the JD_GENERATED event persisted below.
//
// Writes per call, all in one transaction:
//   1. UPDATE job_requisition       — patch 17 matching/enrichment fields (non-null only)
//   2. UPSERT job_posting           — by job_requisition_id, publish_status='pending'
//   3. INSERT event_outbox          — durable JD_GENERATED delivery
//
// Partner source of truth (DO NOT EDIT):
//   raas_v4/backend/apps/api/src/modules/jd/jd-sync.service.ts:21-242

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { withTx } from './client';

// ──────────────────────────────────────────────────────────────────────
// Enum maps — 1:1 port from partner (keep in sync if partner updates)
// ──────────────────────────────────────────────────────────────────────

const EDUCATION_MAP: Record<string, string> = {
  high_school: '高中',
  associate: '大专',
  bachelor: '本科',
  master: '硕士',
  doctor: '博士',
  phd: '博士',
};

const EMPLOYMENT_TYPE_MAP: Record<string, string> = {
  'full-time': '全职',
  full_time: '全职',
  fulltime: '全职',
  'part-time': '兼职',
  part_time: '兼职',
  parttime: '兼职',
  contract: '合同工',
  intern: '实习',
  internship: '实习',
};

const EXPERIENCE_LEVEL_MAP: Record<string, string> = {
  intern: '实习生',
  junior: '初级',
  mid: '中级',
  middle: '中级',
  senior: '高级',
  lead: '资深',
  staff: '资深',
  principal: '专家',
};

function isChineseLikeEnum(s: string): boolean {
  return /[一-鿿]/.test(s);
}

function mapEnum(
  value: string | undefined | null,
  table: Record<string, string>,
): string | null {
  if (value == null || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isChineseLikeEnum(trimmed)) return trimmed;
  return table[trimmed.toLowerCase()] ?? trimmed;
}

// 月薪 sane 上限 — 1 亿元/月。远超任何真实薪资,又安全落在 partner 的
// int4 列 (上限 2,147,483,647) 内。超过此值一律视为上游解析脏数据
// (如 RoboHire 把 "8.2k/8.5k" 拼成 "8.20008.5000" → 8200085000),丢弃为
// null,而不是写进 integer 列触发 22003 溢出 / 静默写脏值。
// 见 2026-06-03 JD 生成失败事故。
export const SALARY_SANE_MAX = 100_000_000;

/** 解析单个薪资 token → 绝对金额。支持 8.2k / 8.5K / 1.5万 / 2w / 8000 / 12,000。 */
export function parseSalaryToken(token: string | null | undefined): number | null {
  if (token == null) return null;
  const cleaned = String(token).replace(/[,，\s]/g, '');
  const m = cleaned.match(/(\d+(?:\.\d+)?)([kK千万wW])?/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  const mult =
    unit === 'k' || unit === 'K' || unit === '千'
      ? 1_000
      : unit === '万' || unit === 'w' || unit === 'W'
        ? 10_000
        : 1;
  return Math.round(n * mult);
}

/**
 * 解析薪资区间文本 → { min, max }。
 * 支持分隔符 - – — ~ ～ / ／ 到 至,以及 k/千/万/w 后缀与小数 (8.2k → 8200)。
 * 单值时 max 为 null;无法解析返回 { null, null }。
 *
 * ⚠️ 旧实现用 `replace(/[kK]/g,'000')` 字面替换 + 删小数点,会把 "8.2k/8.5k"
 * 算成 8200085000 (应为 8200/8500),溢出 partner int4 列。务必走单 token 解析。
 */
export function parseSalaryRange(
  s: string | null | undefined,
): { min: number | null; max: number | null } {
  if (s == null) return { min: null, max: null };
  const tokens = String(s)
    .split(/[-–—~～\/／]|到|至/)
    .map((p) => p.trim())
    .filter(Boolean);
  const nums = tokens
    .map(parseSalaryToken)
    .filter((n): n is number => n != null);
  if (nums.length >= 2) return { min: nums[0], max: nums[1] };
  if (nums.length === 1) return { min: nums[0], max: null };
  return { min: null, max: null };
}

/** 范围校验:非有限 / 负数 / 超 sane 上限 → null,否则原值。 */
export function saneSalary(n: number | null): number | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (n < 0 || n > SALARY_SANE_MAX) return null;
  return n;
}

function toInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value) : null;
  }
  if (typeof value === 'string') {
    const n = parseInt(value.replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function pickField<T = unknown>(
  body: Record<string, unknown>,
  snake: string,
  camel: string,
): T | undefined {
  const v = body[snake] ?? body[camel];
  return v == null ? undefined : (v as T);
}

// ──────────────────────────────────────────────────────────────────────
// Public input — mirrors SyncJdInput from lib/raas-api-client.ts so
// createJdAgent's existing payload composition keeps working unchanged.
// ──────────────────────────────────────────────────────────────────────

type JdGeneratedOutboxTrace = {
  trace_id?: string | null;
  request_id?: string | null;
  workflow_id?: string | null;
  parent_trace_id?: string | null;
  [key: string]: unknown;
};

export type SyncJdInput = {
  job_requisition_id: string;
  client_id: string;
  // RoboHire camelCase (来自 generate-jd data,spread 即可)
  title?: string;
  description?: string;
  qualifications?: string;
  hardRequirements?: string;
  niceToHave?: string;
  interviewRequirements?: string;
  evaluationRules?: string;
  benefits?: string;
  salaryMin?: number | string;
  salaryMax?: number | string;
  salaryCurrency?: string;
  salaryPeriod?: string;
  salaryText?: string;
  headcount?: number | string;
  experienceLevel?: string;
  education?: string;
  employmentType?: string;
  // snake_case (raas 内部)
  posting_title?: string;
  posting_description?: string;
  must_have_skills?: string[];
  nice_to_have_skills?: string[];
  negative_requirement?: string;
  language_requirements?: string;
  expected_level?: string;
  degree_requirement?: string;
  education_requirement?: string;
  work_years?: number;
  interview_mode?: string;
  recruitment_type?: string;
  city?: string[];
  salary_range?: string;
  search_keywords?: string[];
  jd_content?: { title?: string; salaryBenefits?: string };
  /**
   * Durable event written in the same Partner PG transaction as JobPosting.
   * The source event id scopes replay idempotency. A future revision requires
   * an explicitly re-clarified CLARIFICATION_READY event; JD_REJECTED itself
   * never re-enters generation.
   */
  jd_generated_outbox?: {
    source_event_id: string;
    jd_content: string;
    source_action?: string;
    trace?: JdGeneratedOutboxTrace | null;
  };
  // 允许其他字段透传
  [key: string]: unknown;
};

export type SyncJdResult = {
  synced: boolean;
  job_posting_id: string;
  job_requisition_id: string;
  jd_generated_event_id?: string;
  jd_generated_idempotency_key?: string;
  reason?: string;
};

type ExistingJobPostingRow = {
  job_posting_id: string;
  status: string | null;
  publish_status: string | null;
  closed_at: Date | string | null;
};

type ExistingOutboxRow = {
  event_id: string;
  event_name: string;
  source_action: string | null;
  entity_type: string | null;
  entity_id: string | null;
  payload: unknown;
};

const REGENERATABLE_PUBLISH_STATUSES = new Set([
  '',
  'draft',
  'pending',
  'modified',
  'rejected',
]);

// ──────────────────────────────────────────────────────────────────────
// Main entry — replaces RAAS POST /api/v1/jd/sync-generated
// ──────────────────────────────────────────────────────────────────────

export async function syncJdToPartnerPg(input: SyncJdInput): Promise<SyncJdResult> {
  const body = input as Record<string, unknown>;
  const {
    posting_description,
    education_requirement,
    work_years,
    city,
    salary_range,
    interview_mode,
    must_have_skills,
    nice_to_have_skills,
    negative_requirement,
    language_requirements,
    jd_content,
    search_keywords,
  } = input;

  const degree_requirement = mapEnum(
    pickField<string>(body, 'degree_requirement', 'education'),
    EDUCATION_MAP,
  );
  const recruitment_type = mapEnum(
    pickField<string>(body, 'recruitment_type', 'employmentType'),
    EMPLOYMENT_TYPE_MAP,
  );
  const expected_level = mapEnum(
    pickField<string>(body, 'expected_level', 'experienceLevel'),
    EXPERIENCE_LEVEL_MAP,
  );

  const job_requisition_id = input.job_requisition_id;
  const client_id = input.client_id;
  const outboxInput = input.jd_generated_outbox;

  if (!job_requisition_id) {
    throw new Error('[partner-pg/job-posting] missing job_requisition_id');
  }
  if (!client_id) {
    return {
      synced: false,
      job_posting_id: '',
      job_requisition_id,
      reason: 'skipped_no_client_id',
    };
  }
  if (outboxInput) {
    if (!outboxInput.source_event_id?.trim()) {
      throw new Error('[partner-pg/job-posting] missing jd_generated_outbox.source_event_id');
    }
    if (!outboxInput.jd_content?.trim()) {
      throw new Error('[partner-pg/job-posting] missing jd_generated_outbox.jd_content');
    }
  }

  const postingTitleField =
    pickField<string>(body, 'posting_title', 'title') ?? jd_content?.title;
  const postingDescriptionField =
    posting_description ?? pickField<string>(body, 'posting_description', 'description');

  const qualifications = pickField<string>(body, 'qualifications', 'qualifications');
  const hardRequirements = pickField<string>(body, 'hard_requirements', 'hardRequirements');
  const niceToHave = pickField<string>(body, 'nice_to_have', 'niceToHave');
  const interviewRequirements = pickField<string>(
    body,
    'interview_requirements',
    'interviewRequirements',
  );
  const evaluationRules = pickField<string>(body, 'evaluation_rules', 'evaluationRules');
  const benefits = pickField<string>(body, 'benefits', 'benefits');

  const headcountInt = toInt(pickField<string | number>(body, 'headcount', 'headcount'));

  const salaryText = pickField<string>(body, 'salary_text', 'salaryText');
  const salaryCurrency = pickField<string>(body, 'salary_currency', 'salaryCurrency');
  const salaryPeriod = pickField<string>(body, 'salary_period', 'salaryPeriod');
  const salaryMinRaw = pickField<string | number>(body, 'salary_min', 'salaryMin');
  const salaryMaxRaw = pickField<string | number>(body, 'salary_max', 'salaryMax');

  const resolvedTitle = postingTitleField ?? '待定';
  // 薪资文本权威来源 — salaryText 是 RoboHire 原文 ("8.2k/8.5k"),最干净;
  // 写入 salary_range 文本列与解析数值都用它,两边口径一致。
  const resolvedSalaryRangeText =
    salaryText ?? salary_range ?? jd_content?.salaryBenefits ?? null;
  // 数值优先从原文解析。RoboHire 的结构化 salaryMin/Max 已证实会产出脏值
  // (把 "8.2k/8.5k" 拼成 "8.20008.5000" → 82 亿,溢出 partner int4 列),
  // 仅当原文解析不出时才退回结构化字段;两路都过 sane 范围校验兜底。
  const { min: textSalaryMin, max: textSalaryMax } =
    parseSalaryRange(resolvedSalaryRangeText);
  const salaryMin = saneSalary(textSalaryMin ?? toInt(salaryMinRaw));
  const salaryMax = saneSalary(textSalaryMax ?? toInt(salaryMaxRaw));
  const cityFirst = Array.isArray(city) && city.length > 0 ? city[0] : null;

  // Run JobPosting and its durable JD_GENERATED event in one transaction.
  return withTx<SyncJdResult>(async (c) => {
    // Serialize every revision of one JR across Inngest runs/workers. The table
    // has no unique constraint on job_requisition_id, so SELECT → INSERT alone
    // has a TOCTOU window even when function-level concurrency is configured.
    await c.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`job_posting:${job_requisition_id}`],
    );

    const existing = await c.query<ExistingJobPostingRow>(
      `SELECT job_posting_id, status, publish_status, closed_at
         FROM job_posting
        WHERE job_requisition_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE`,
      [job_requisition_id],
    );

    const existingPosting = existing.rows[0];
    if (existingPosting && isProtectedExistingPosting(existingPosting)) {
      return {
        synced: false,
        job_posting_id: existingPosting.job_posting_id,
        job_requisition_id,
        reason: 'skipped_protected_existing_posting',
      };
    }

    const replayIdempotencyKey = outboxInput
      ? jdGeneratedIdempotencyKey(
          job_requisition_id,
          outboxInput.source_event_id.trim(),
        )
      : null;
    if (replayIdempotencyKey && outboxInput) {
      const replay = await findJdGeneratedOutbox(c, replayIdempotencyKey);
      if (replay) {
        if (!existingPosting) {
          throw new Error(
            `[partner-pg/job-posting] JD_GENERATED outbox exists without JobPosting: ${replayIdempotencyKey}`,
          );
        }
        const replayPayload = buildJdGeneratedPayload({
          job_posting_id: existingPosting.job_posting_id,
          job_requisition_id,
          client_id,
          jd_content: outboxInput.jd_content,
        });
        if (
          !sameJdGeneratedOutbox(
            replay,
            {
              job_posting_id: existingPosting.job_posting_id,
              source_action: outboxInput.source_action ?? 'createJD',
            },
            replayPayload,
          )
        ) {
          throw new Error(
            `[partner-pg/job-posting] JD_GENERATED outbox idempotency collision: ${replayIdempotencyKey}`,
          );
        }
        return {
          synced: false,
          job_posting_id: existingPosting.job_posting_id,
          job_requisition_id,
          jd_generated_event_id: replay.event_id,
          jd_generated_idempotency_key: replayIdempotencyKey,
          reason: 'replayed_existing_outbox',
        };
      }
    }

    // Prepare the JobRequisition patch now, but apply it only after the guarded
    // JobPosting write succeeds. That keeps a late terminal-state detection a
    // true no-op for the whole transaction.
    const patchPairs: Array<[string, unknown]> = [];
    // must_have_skills / nice_to_have_skills 在 partner 库是 jsonb 列:必须传 JSON 文本。
    // 直接传 JS 数组会被 pg 转成 Postgres 数组字面量 {…},jsonb 解析报
    // "invalid input syntax for type json"(其余 patch 字段都是 text 列,不受影响)。
    if (must_have_skills != null)
      patchPairs.push(['must_have_skills', JSON.stringify(must_have_skills)]);
    if (nice_to_have_skills != null)
      patchPairs.push(['nice_to_have_skills', JSON.stringify(nice_to_have_skills)]);
    if (negative_requirement != null)
      patchPairs.push(['negative_requirement', negative_requirement]);
    if (language_requirements != null)
      patchPairs.push(['language_requirements', language_requirements]);
    if (expected_level != null) patchPairs.push(['expected_level', expected_level]);
    if (degree_requirement != null) patchPairs.push(['degree_requirement', degree_requirement]);
    if (education_requirement != null)
      patchPairs.push(['education_requirement', education_requirement]);
    if (typeof work_years === 'number') patchPairs.push(['work_years', work_years]);
    if (interview_mode != null) patchPairs.push(['interview_mode', interview_mode]);
    if (recruitment_type != null) patchPairs.push(['recruitment_type', recruitment_type]);
    if (qualifications != null) patchPairs.push(['qualifications', qualifications]);
    if (hardRequirements != null) patchPairs.push(['hard_requirements', hardRequirements]);
    if (niceToHave != null) patchPairs.push(['nice_to_have', niceToHave]);
    if (interviewRequirements != null)
      patchPairs.push(['interview_requirements', interviewRequirements]);
    if (evaluationRules != null) patchPairs.push(['evaluation_rules', evaluationRules]);
    if (benefits != null) patchPairs.push(['benefits', benefits]);
    if (headcountInt != null) patchPairs.push(['headcount', headcountInt]);

    // ── Step 1: guarded upsert job_posting (publish_status='pending') ──
    let job_posting_id: string;
    const sharedCols = [
      'posting_title',
      'posting_description',
      'city',
      'salary_range',
      'salary_currency',
      'salary_period',
      'salary_range_monthly_min',
      'salary_range_monthly_max',
      'degree_requirement',
      'headcount',
      'interview_mode',
      'search_keywords',
      'publish_status',
    ] as const;
    const sharedVals: unknown[] = [
      resolvedTitle,
      postingDescriptionField ?? null,
      cityFirst,
      resolvedSalaryRangeText,
      salaryCurrency ?? null,
      salaryPeriod ?? null,
      salaryMin,
      salaryMax,
      degree_requirement ?? null,
      headcountInt,
      interview_mode ?? null,
      Array.isArray(search_keywords) ? search_keywords.slice(0, 5) : [],
      'pending', // force HSM review
    ];

    if (existingPosting) {
      job_posting_id = existingPosting.job_posting_id;
      const setClause = sharedCols.map((col, i) => `${col} = $${i + 2}`).join(', ');
      const updated = await c.query(
        `UPDATE job_posting
            SET ${setClause}, updated_at = NOW()
          WHERE job_posting_id = $1
            AND closed_at IS NULL
            AND BTRIM(COALESCE(status::text, '')) IN ('', 'draft')
            AND BTRIM(COALESCE(publish_status::text, '')) IN (
              '', 'draft', 'pending', 'modified', 'rejected'
            )`,
        [job_posting_id, ...sharedVals],
      );
      if (updated.rowCount !== 1) {
        const refreshed = await c.query<ExistingJobPostingRow>(
          `SELECT job_posting_id, status, publish_status, closed_at
             FROM job_posting
            WHERE job_posting_id = $1
            LIMIT 1
            FOR UPDATE`,
          [job_posting_id],
        );
        if (refreshed.rows[0] && isProtectedExistingPosting(refreshed.rows[0])) {
          return {
            synced: false,
            job_posting_id,
            job_requisition_id,
            reason: 'skipped_protected_existing_posting',
          };
        }
        throw new Error(
          `[partner-pg/job-posting] guarded JobPosting update affected ${updated.rowCount ?? 0} rows: ${job_posting_id}`,
        );
      }
    } else {
      job_posting_id = randomUUID();
      // INSERT with job_posting_id + job_requisition_id + client_id + status='draft' + shared
      const insertCols = ['job_posting_id', 'job_requisition_id', 'client_id', 'status', ...sharedCols];
      const insertVals = [job_posting_id, job_requisition_id, client_id, 'draft', ...sharedVals];
      const placeholders = insertCols.map((_, i) => `$${i + 1}`).join(', ');
      await c.query(
        `INSERT INTO job_posting (${insertCols.join(', ')}, created_at, updated_at)
         VALUES (${placeholders}, NOW(), NOW())`,
        insertVals,
      );
    }

    // ── Step 2: patch job_requisition matching fields (only set non-null) ──
    if (patchPairs.length > 0) {
      const setClause = patchPairs
        .map(([col], idx) => `${col} = $${idx + 2}`)
        .join(', ');
      const values = patchPairs.map(([, v]) => v);
      await c.query(
        `UPDATE job_requisition SET ${setClause}, updated_at = NOW() WHERE job_requisition_id = $1`,
        [job_requisition_id, ...values],
      );
    }

    // Per RAAS ADR-0021, generation does not advance the requirement spec.
    // It stays draft until CHANNEL_PUBLISHED promotes it to recruiting.

    const outbox = outboxInput
      ? await appendJdGeneratedOutbox(c, {
          job_posting_id,
          job_requisition_id,
          client_id,
          source_event_id: outboxInput.source_event_id.trim(),
          jd_content: outboxInput.jd_content,
          source_action: outboxInput.source_action ?? 'createJD',
          trace: outboxInput.trace ?? null,
        })
      : null;

    return {
      synced: true,
      job_posting_id,
      job_requisition_id,
      ...(outbox
        ? {
            jd_generated_event_id: outbox.event_id,
            jd_generated_idempotency_key: outbox.idempotency_key,
          }
        : {}),
    };
  }, { allowMirrorFallback: false });
}

function isProtectedExistingPosting(row: ExistingJobPostingRow): boolean {
  if (row.closed_at != null) return true;
  const status = String(row.status ?? '').trim().toLowerCase();
  if (status && status !== 'draft') return true;
  return !REGENERATABLE_PUBLISH_STATUSES.has(
    String(row.publish_status ?? '').trim().toLowerCase(),
  );
}

function jdGeneratedIdempotencyKey(
  jobRequisitionId: string,
  sourceEventId: string,
): string {
  return `JD_GENERATED:createJD:${jobRequisitionId}:${sourceEventId}`;
}

function buildJdGeneratedPayload(input: {
  job_posting_id: string;
  job_requisition_id: string;
  client_id: string;
  jd_content: string;
}): Record<string, unknown> {
  return {
    job_posting_id: input.job_posting_id,
    job_requisition_id: input.job_requisition_id,
    client_id: input.client_id,
    jd_content: input.jd_content,
  };
}

async function findJdGeneratedOutbox(
  c: PoolClient,
  idempotencyKey: string,
): Promise<ExistingOutboxRow | null> {
  const result = await c.query<ExistingOutboxRow>(
    `SELECT event_id, event_name, source_action, entity_type, entity_id, payload
       FROM event_outbox
      WHERE idempotency_key = $1
      LIMIT 1`,
    [idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function appendJdGeneratedOutbox(
  c: PoolClient,
  input: {
    job_posting_id: string;
    job_requisition_id: string;
    client_id: string;
    source_event_id: string;
    jd_content: string;
    source_action: string;
    trace: JdGeneratedOutboxTrace | null;
  },
): Promise<{ event_id: string; idempotency_key: string }> {
  const eventId = randomUUID();
  const idempotencyKey = jdGeneratedIdempotencyKey(
    input.job_requisition_id,
    input.source_event_id,
  );
  const trace = input.trace ?? null;
  const payload = buildJdGeneratedPayload(input);

  const inserted = await c.query<{ event_id: string }>(
    `INSERT INTO event_outbox (
       id, event_id, event_name, source_action, topic,
       trace_id, request_id, workflow_id, parent_trace_id,
       entity_type, entity_id, trace_payload, idempotency_key, payload,
       status, retry_count, next_retry_at, created_at, updated_at
     ) VALUES (
       $1, $1, 'JD_GENERATED', $2, 'raas.events',
       $3, $4, $5, $6,
       'Job_Posting', $7, $8::jsonb, $9, $10::jsonb,
       'pending', 0, NOW(), NOW(), NOW()
     )
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING event_id`,
    [
      eventId,
      input.source_action,
      trace?.trace_id ?? null,
      trace?.request_id ?? null,
      trace?.workflow_id ?? null,
      trace?.parent_trace_id ?? null,
      input.job_posting_id,
      JSON.stringify(trace),
      idempotencyKey,
      JSON.stringify(payload),
    ],
  );

  if (inserted.rows[0]?.event_id) {
    return { event_id: inserted.rows[0].event_id, idempotency_key: idempotencyKey };
  }

  const existing = await findJdGeneratedOutbox(c, idempotencyKey);
  if (!existing || !sameJdGeneratedOutbox(existing, input, payload)) {
    throw new Error(
      `[partner-pg/job-posting] JD_GENERATED outbox idempotency collision: ${idempotencyKey}`,
    );
  }
  return { event_id: existing.event_id, idempotency_key: idempotencyKey };
}

function sameJdGeneratedOutbox(
  existing: ExistingOutboxRow,
  input: {
    job_posting_id: string;
    source_action: string;
  },
  expectedPayload: Record<string, unknown>,
): boolean {
  const actualPayload =
    typeof existing.payload === 'string'
      ? safeParseJson(existing.payload)
      : existing.payload;
  return (
    existing.event_name === 'JD_GENERATED' &&
    existing.source_action === input.source_action &&
    existing.entity_type === 'Job_Posting' &&
    existing.entity_id === input.job_posting_id &&
    isRecord(actualPayload) &&
    Object.entries(expectedPayload).every(([key, value]) => actualPayload[key] === value)
  );
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
