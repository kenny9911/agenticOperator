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
//   1. UPSERT candidate     — dedup by (mobile_normalized, name) when available;
//                              otherwise use input candidate_id
//   2. UPSERT CandidateExpectation when RESUME_DOWNLOADED carries expectation_payload
//   3. UPSERT resume        — dedup by (candidate_id, source_etag)
//   4. SELECT application   — RAAS owns creation; AO only returns an existing id
//   5. UPDATE resume_upload_runtime to completed
//
// Partner source of truth (reference, DO NOT MODIFY):
//   raas_v4/backend/apps/api/src/modules/candidates/resume-ingest.service.ts
//   raas_v4/backend/prisma/schema.prisma (Candidate / Resume / Application)

import { randomUUID } from 'node:crypto';
import { withTx } from './client';
import { dedupKey, toE164 } from '@/lib/phone/normalize-e164';
import {
  normalizeCandidateExpectationPayload,
  type CandidateExpectationPatch,
} from '@/lib/raas-v1/candidate-expectation';

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
   * dedup 命中走 UPDATE 时无条件覆盖既有归属。为空时回落 employee_id
   * (上传者) 走原 COALESCE 仅填空语义。
   */
  locked_by_employee_id?: string | null;
  hr_folder?: string | null;
  job_requisition_id?: string | null;
  client_id?: string | null;
  sourcing_channel_id?: string | null;
  /** RAAS RESUME_DOWNLOADED.payload.expectation_payload (partial, non-empty fields only). */
  expectation_payload?: CandidateExpectationPatch | null;
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
  /** Optional explicit candidate_id (force use this instead of dedup). */
  candidate_id?: string;
  /** 查重(9-15)判出的"老人"candidate_id —— 同一人时强制复用此行(UPDATE 挂新简历到老
   *  Candidate,1:N),优先级仅次于显式 candidate_id、高于 phone/email dedup。null → 走兜底 dedup。 */
  same_as_candidate_id?: string | null;
};

export type SaveCandidateResult = {
  candidate_id: string;
  resume_id: string;
  candidate_expectation_id: string | null;
  application_id: string | null;
  candidate_created: boolean;
  resume_created: boolean;
};

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

/**
 * Dedup key for the stored `mobile_normalized` column. Delegates to the shared
 * phone normalizer (lib/phone/normalize-e164 `dedupKey`), which is byte-identical
 * to this function's former inline logic:
 *   Default (flag off): >=7 digits, all digits kept (legacy behavior — unchanged).
 *   DEDUP_PHONE_PRIMARY=1: require >=11 digits and return the LAST 11, so
 *     country-code / OCR variants collapse to one identity (matching RMHR).
 * ⚠️ The stored value FORMAT is deliberately unchanged: it is co-owned with the
 * live RAAS partner DB and matched via suffix LIKE, so the E.164 upgrade of this
 * column is deferred to a coordinated migration (see 2026-07-21 old-repo design §3).
 * Enabling DEDUP_PHONE_PRIMARY still changes the stored key and needs a backfill.
 */
function normalizeMobile(s: string | null | undefined): string | null {
  return dedupKey(s, { phonePrimary: process.env.DEDUP_PHONE_PRIMARY === '1' });
}

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
  // 2026-06-11 (c200efd) — RMHR 锁持有人是候选人归属权威 (锁权威覆盖)。被他人
  // 锁定时 raas 仍发 RESUME_DOWNLOADED 并透传 locked_by_*, 候选人应归锁持有人而
  // 非上传者。lockedBy 非空 → employee_id 写锁持有人且 UPDATE 无条件覆盖; 为空
  // → 沿用上传者 + COALESCE 仅填空 (公共池) 的历史语义。resume.uploaded_by 不受
  // 影响 — 那是"谁上传了文件", 始终记上传者。
  // ⚠️ 运维红线: 勿从 Inngest dashboard 直接 replay 旧 RESUME_DOWNLOADED — 陈旧
  // locked_by 会无条件覆盖较新归属 (这里不做 locked_at 新旧比较, 跨系统时区口径
  // 不可靠)。
  const lockedBy = nonEmpty(input.locked_by_employee_id);
  const ownerEmployeeId = lockedBy ?? uploadedBy;

  const parsed = input.parsed?.data ?? {};
  const name = nonEmpty(parsed.name) ?? '未命名候选人';
  // 手机号(2026-07-21 决策):存进 `mobile` 列的是 E.164 规范形(号码有效时),无效号
  // 退回原始串(绝不丢号)。去重键 `mobile_normalized` 仍从【原始号】计算,逐字节不变
  // —— 保证共享库去重零回归(见 lib/phone/normalize-e164 dedupKey 的逐字节复刻)。
  const rawMobile = nonEmpty(parsed.mobile) ?? nonEmpty(parsed.phone);
  const mobile_normalized = normalizeMobile(rawMobile);
  const mobile = toE164(rawMobile) ?? rawMobile;
  const email = nonEmpty(parsed.email);

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
    // ── Step 1: UPSERT candidate ──
    // Dedup strategy:
    //   - If input.candidate_id explicit → use that (force)
    //   - Else if mobile_normalized present → look up by (mobile_normalized, name)
    //   - Else if email present → look up by email
    //   - Else → create new
    // dedup 档序:① 显式 candidate_id ② 查重(9-15)判出的 same_as_candidate_id ③ 手机号 ④ 邮箱+名字 ⑤ 建新。
    // 查重前移后 same_as_candidate_id 是权威归属源;phone/email 仅在查重未命中时兜底。
    let candidate_id = input.candidate_id ?? input.same_as_candidate_id ?? null;
    let candidate_created = false;

    if (!candidate_id && mobile_normalized) {
      // DEDUP_PHONE_PRIMARY=1 → phone is the sole identity key (drop `AND name`),
      // matching RMHR's phone-only dedup so its returned lock owner maps 1:1 onto
      // one AO candidate row. Flag off → legacy (mobile + exact name). The
      // email+name fallback tier below is left UNTOUCHED (it closed the
      // 2026-05-26 placeholder/test-email merge bug).
      const phonePrimary = process.env.DEDUP_PHONE_PRIMARY === '1';
      const existing = await c.query<{ candidate_id: string }>(
        phonePrimary
          ? `SELECT candidate_id FROM candidate
              WHERE mobile_normalized = $1
              ORDER BY created_at ASC LIMIT 1`
          : `SELECT candidate_id FROM candidate
              WHERE mobile_normalized = $1 AND name = $2
              ORDER BY created_at ASC LIMIT 1`,
        phonePrimary ? [mobile_normalized] : [mobile_normalized, name],
      );
      candidate_id = existing.rows[0]?.candidate_id ?? null;
    }
    // 2026-05-26 — email-dedup 加 name 联合约束.
    // 原来"仅 email 匹配"在测试场景会把不同人合并: RAAS 测试用同一个测试邮箱
    // (zyjjust@gmail.com) 上传 4 份不同候选人 PDF, 都被 dedup 到陈昊那行,
    // 后续 RoboHire 正解的姓名(周婧雯/林佳琪/陈思颖)走 UPDATE 分支后被丢弃,
    // 陈昊那行 name='性别' 永远 stuck. 生产场景同人换简历不会改姓名,
    // 同时要求 name 匹配才合并是安全的.
    if (!candidate_id && email && name && name !== '未命名候选人') {
      const existing = await c.query<{ candidate_id: string }>(
        `SELECT candidate_id FROM candidate
          WHERE email = $1 AND name = $2 LIMIT 1`,
        [email, name],
      );
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
            created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9,
            $10::text[], $11::text[],
            $12, $13, $14, $15,
            NOW(), NOW()
          )`,
        [
          candidate_id,
          name,
          mobile,
          mobile_normalized,
          email,
          nonEmpty(parsed.gender),
          currentLocation,
          currentCompany,
          currentTitle,
          skillsExtracted,
          languagesList,
          sourcingChannelId,
          ownerEmployeeId,
          'agentic_operator',
          DEFAULT_CANDIDATE_STATUS,
        ],
      );
    } else {
      // dedup 命中 — 同一候选人换简历, patch 联系信息 + skills + 当前公司/职位 + name.
      // name 字段也跟着 RoboHire `parsed.name` 走 — 老 row 卡在错值时, 同人重传
      // 让新 RoboHire 输出能覆盖. RoboHire 返空(置 '未命名候选人' 占位)则不
      // 覆盖, 用 COALESCE 保留原值. 不在 AO 这层做姓名校验/过滤 — 上游 RoboHire
      // 是 source of truth, RoboHire 输出不对要上游修.
      //
      // employee_id (归属): $13 标记"事件带 RMHR 锁持有人"。带锁 → 无条件覆盖为
      // $11 (= 锁持有人, 锁权威校正归属); 不带锁 → 原 COALESCE 仅填空语义
      // ($11 = 上传者)。status: COALESCE 仅填空, 不覆盖招聘手动维护的状态。
      const incomingNameForUpdate = name === '未命名候选人' ? null : name;
      await c.query(
        `UPDATE candidate SET
            mobile = COALESCE($2, mobile),
            mobile_normalized = COALESCE($3, mobile_normalized),
            email = COALESCE($4, email),
            current_location = COALESCE($5, current_location),
            current_company = COALESCE($6, current_company),
            current_title = COALESCE($7, current_title),
            skills = CASE WHEN COALESCE(array_length(skills, 1), 0) = 0
                          THEN $8::text[] ELSE skills END,
            languages = CASE WHEN COALESCE(array_length(languages, 1), 0) = 0
                             THEN $9::text[] ELSE languages END,
            sourcing_channel_id = COALESCE(sourcing_channel_id, $10),
            employee_id = CASE WHEN $13::boolean THEN $11
                               ELSE COALESCE(employee_id, $11) END,
            data_source = COALESCE(data_source, 'agentic_operator'),
            name = COALESCE($12, name),
            status = COALESCE(status, $14),
            updated_at = NOW()
         WHERE candidate_id = $1`,
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
          ownerEmployeeId,
          incomingNameForUpdate,
          lockedBy !== null,
          DEFAULT_CANDIDATE_STATUS,
        ],
      );
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
    if (expectationPatch) {
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

    // ── Step 3: UPSERT resume by (candidate_id, etag) ──
    let resume_id: string;
    let resume_created = false;
    const sourceEtag = nonEmpty(input.etag);

    if (sourceEtag) {
      const existing = await c.query<{ resume_id: string }>(
        `SELECT r.resume_id
           FROM resume r
          WHERE r.candidate_id = $1
            AND r.object_key = $2
          LIMIT 1`,
        [candidate_id, input.object_key],
      );
      if (existing.rows[0]) {
        resume_id = existing.rows[0].resume_id;
        // Refresh parsed_data + parse_status + every RAAS-structured column
        await c.query(
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
           WHERE resume_id = $1`,
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
          ],
        );
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

    // Update candidate.latest_resume_id to point at this resume
    await c.query(
      `UPDATE candidate SET latest_resume_id = $2, updated_at = NOW() WHERE candidate_id = $1`,
      [candidate_id, resume_id],
    );

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
    };
  });
}

/**
 * Mark a resume_upload_runtime row as failed so partner / RAAS UI sees the
 * upload as terminal-error instead of stuck in 'pending'. Non-transactional,
 * called from the agent's catch path. No-op if the row doesn't exist.
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
     WHERE upload_id = $1`,
    [uploadId, errorMessage.slice(0, 1000)],
  );
}
