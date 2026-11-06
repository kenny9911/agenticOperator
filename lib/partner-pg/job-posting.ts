// lib/partner-pg/job-posting.ts
//
// Direct SQL replacement for RAAS API POST /api/v1/jd/sync-generated.
// Mirrors raas_v4/.../jd-sync.service.ts:syncJdGenerated steps 1-3.
// Steps 4-5 (HSM notification + jd_review HitlTask) EXPLICITLY SKIPPED —
// per 2026-05-20 architecture decision, partner subscribes to AO's
// JD_GENERATED event to perform those side effects.
//
// Three writes per call, all in one transaction:
//   1. UPDATE job_requisition       — patch 17 matching/enrichment fields (non-null only)
//   2. UPSERT job_posting           — by job_requisition_id, publish_status='pending'
//   3. UPDATE spec.status           — draft → pending_publish (compare-and-set)
//
// Partner source of truth (DO NOT EDIT):
//   raas_v4/backend/apps/api/src/modules/jd/jd-sync.service.ts:21-242

import { randomUUID } from 'node:crypto';
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
  // 允许其他字段透传
  [key: string]: unknown;
};

export type SyncJdResult = {
  synced: boolean;
  job_posting_id: string;
  job_requisition_id: string;
  reason?: string;
};

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

  // Run all 3 writes in one transaction
  return withTx<SyncJdResult>(async (c) => {
    // ── Step 1: patch job_requisition matching fields (only set non-null) ──
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

    if (patchPairs.length > 0) {
      // Build dynamic SET clause: col1 = $2, col2 = $3, ...
      const setClause = patchPairs
        .map(([col], idx) => `${col} = $${idx + 2}`)
        .join(', ');
      const values = patchPairs.map(([, v]) => v);
      // updated_at handled by DB trigger / Prisma @updatedAt; we touch it explicitly.
      await c.query(
        `UPDATE job_requisition SET ${setClause}, updated_at = NOW() WHERE job_requisition_id = $1`,
        [job_requisition_id, ...values],
      );
    }

    // ── Step 2: upsert job_posting (publish_status='pending' for HSM review) ──
    const existing = await c.query<{ job_posting_id: string }>(
      `SELECT job_posting_id FROM job_posting
        WHERE job_requisition_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [job_requisition_id],
    );

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

    if (existing.rows.length > 0) {
      job_posting_id = existing.rows[0]!.job_posting_id;
      const setClause = sharedCols.map((col, i) => `${col} = $${i + 2}`).join(', ');
      await c.query(
        `UPDATE job_posting SET ${setClause}, updated_at = NOW() WHERE job_posting_id = $1`,
        [job_posting_id, ...sharedVals],
      );
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

    // ── Step 3: advance spec.status draft → pending_publish (compare-and-set) ──
    const jrRow = await c.query<{ job_requisition_specification_id: string | null }>(
      `SELECT job_requisition_specification_id FROM job_requisition
        WHERE job_requisition_id = $1
        LIMIT 1`,
      [job_requisition_id],
    );
    const specId = jrRow.rows[0]?.job_requisition_specification_id ?? null;
    if (specId) {
      await c.query(
        `UPDATE job_requisition_specification
            SET status = 'pending_publish', updated_at = NOW()
          WHERE job_requisition_specification_id = $1
            AND status = 'draft'`,
        [specId],
      );
    }

    return {
      synced: true,
      job_posting_id,
      job_requisition_id,
    };
  });
}
