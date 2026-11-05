// lib/partner-pg/requirements.ts
//
// Direct SQL replacement for RAAS API GET /api/v1/requirements/:id.
// Replaces lib/raas-api-client.ts::getRequirementDetail.
//
// Used by:
//   - createJdAgent (F4 prompt input)
//   - ruleCheckAgent (rule fields: must_have_skills, degree_requirement, ...)
//   - matchResumeAgent (JR context for match-resume call)
//
// Partner source of truth (DO NOT MODIFY):
//   raas_v4/backend/apps/api/src/modules/requirements/requirements-main.hono.ts:417
//   raas_v4/backend/apps/api/src/modules/requirements/requirement.service.ts

import { query } from './client';
import { deriveCompanyDescriptor } from '@/lib/robohire/jd-prompt-blocks';
import type {
  JobRequisition,
  JobRequisitionSpecification,
  RequirementDetail,
} from './types';

/**
 * 办公城市多选 → 城市名数组（保序，首项 = 主城市）。
 *
 * RAAS 的 `job_requisition.city_ids` 是有序城市 **UUID** 数组（权威多值，2026-06-19 加），
 * `city` / `city_id` 只存首项当兼容主城市。AO 此前只读 `city`，所以多城市需求生成出来的
 * JD 永远只有一个城市（根因之一）。
 *
 * 这里在**读时**把 UUID 解析成城市名，不物化到任何列 —— RAAS 的城市字典支持改名
 * (`city_dict.city_name`) 与合并 (`merged_into`)，物化的名字会 stale，读时派生则下一次
 * 读就是新名。
 *
 * 🔴 红线：city UUID 绝不进 prompt / JD 正文 / ontology payload。内 JOIN 天然丢弃解析
 * 不到的 id —— 宁可少一个城市，也不能把一串 UUID 写进候选人可见的 JD。
 *
 * 三个都踩得到的实现细节：
 *   - `WITH ORDINALITY` 保序：首项必须仍是主城市，与 RAAS 的 city/city_id 口径对齐。
 *   - 按 **text** 比较（`cd.city_id::text = t.cid`）而不是 `t.cid::uuid`：数组里若混进
 *     非 UUID 字符串，cast 会让整条需求查询抛错（= JD 生成全挂），text 比较只是不命中。
 *   - `jsonb_typeof` 守卫：`city_ids` 是可空 JSONB，存量行是 NULL、脏行可能不是数组。
 *   - 不过滤 `is_active` / `merged_into`：合并只置标记不删行，显示旧名与 RAAS 的
 *     jd-export 行为一致；过滤掉反而会让城市凭空消失。
 */
const CITY_NAMES_SQL = `
      COALESCE((
        SELECT json_agg(cd.city_name ORDER BY t.ord)
        FROM jsonb_array_elements_text(
               CASE WHEN jsonb_typeof(r.city_ids) = 'array'
                    THEN r.city_ids
                    ELSE '[]'::jsonb END
             ) WITH ORDINALITY AS t(cid, ord)
        JOIN city_dict cd ON cd.city_id::text = t.cid
      ), '[]'::json) AS city_names`;

/** pg 会把 json_agg 结果解析成数组；防御非数组 / 空值，并丢掉空串。 */
function toCityNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/**
 * GET job_requisition + LEFT JOIN job_requisition_specification by ID.
 *
 * Returns null if not found — caller should treat as NonRetriable
 * (JR doesn't exist in partner DB, retrying won't help).
 *
 * Postgres returns the spec row as a JSON object via `row_to_json(s.*)`,
 * which `pg` driver auto-parses into a JS object (since pg ≥ 8 with jsonb).
 */
export async function getRequirementDetail(
  jobRequisitionId: string,
): Promise<RequirementDetail | null> {
  const sql = `
    SELECT
      row_to_json(r.*) AS requirement_json,
      row_to_json(s.*) AS specification_json,${CITY_NAMES_SQL}
    FROM job_requisition r
    LEFT JOIN job_requisition_specification s
      ON s.job_requisition_specification_id = r.job_requisition_specification_id
    WHERE r.job_requisition_id = $1
    LIMIT 1
  `;
  const result = await query<{
    requirement_json: JobRequisition;
    specification_json: JobRequisitionSpecification | null;
    city_names: unknown;
  }>(sql, [jobRequisitionId]);

  const row = result.rows[0];
  if (!row) return null;

  const requirement = row.requirement_json;
  const specification = row.specification_json;

  return {
    ...requirement,
    // 覆盖 row_to_json 里的原始 city_ids 派生结果：city_names 是解析后的城市名，
    // 不是 UUID。放在 spread 之后，避免被 requirement 上的同名键（不存在，但防御）覆盖。
    city_names: toCityNames(row.city_names),
    specification,
  };
}

export type RequirementDetailByJobPosting = RequirementDetail & {
  job_posting_id: string;
};

/**
 * Resolve an explicit Job_Posting anchor to its parent Job_Requisition and
 * hydrate the same requirement shape consumed by ruleCheckAgent.
 */
export async function getRequirementDetailByJobPostingId(
  jobPostingId: string,
): Promise<RequirementDetailByJobPosting | null> {
  const sql = `
    SELECT
      p.job_posting_id,
      row_to_json(r.*) AS requirement_json,
      row_to_json(s.*) AS specification_json,${CITY_NAMES_SQL}
    FROM job_posting p
    JOIN job_requisition r
      ON r.job_requisition_id = p.job_requisition_id
    LEFT JOIN job_requisition_specification s
      ON s.job_requisition_specification_id = r.job_requisition_specification_id
    WHERE p.job_posting_id = $1
    LIMIT 1
  `;
  const result = await query<{
    job_posting_id: string;
    requirement_json: JobRequisition;
    specification_json: JobRequisitionSpecification | null;
    city_names: unknown;
  }>(sql, [jobPostingId]);
  const row = result.rows[0];
  if (!row) return null;

  // 两个入口返回同一个 RequirementDetail 形状 —— 这里不一并解析 city_names,
  // 类型上就会说谎（声明有、运行时没有）。
  return {
    ...row.requirement_json,
    city_names: toCityNames(row.city_names),
    specification: row.specification_json,
    job_posting_id: row.job_posting_id,
  };
}

// ──────────────────────────────────────────────────────────────────────
// client — 公司上下文(createJD 入参优化, design 2026-07-21 §2)
// ──────────────────────────────────────────────────────────────────────

/**
 * Best-effort client context for JD generation. The real `client_name` is kept
 * for the deterministic 4-2 compliance scrub only — it is NOT sent to Gohire;
 * `company_descriptor` (anonymized) is the safe-to-send label.
 */
export type ClientContext = {
  client_id: string;
  /** Real name — for compliance scrub only, never carried into the Gohire request. */
  client_name: string | null;
  /** Anonymized descriptor safe to send + to substitute for the real name. */
  company_descriptor: string;
  industry: string | null;
  technical_stack_preference: string | null;
  welfare_policy: string | null;
};

type ClientRow = {
  client_name?: string | null;
  industry_category?: string | null;
  technical_stack_preference?: string | null;
  welfare_policy?: string | null;
};

function clean(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function buildClientContext(id: string, row: ClientRow): ClientContext {
  const industry = clean(row.industry_category);
  return {
    client_id: id,
    client_name: clean(row.client_name),
    company_descriptor: deriveCompanyDescriptor(industry),
    industry,
    technical_stack_preference: clean(row.technical_stack_preference),
    welfare_policy: clean(row.welfare_policy),
  };
}

/**
 * Fetch company context for a JD. Defensive by design: the enrichment columns
 * (`industry_category` / `technical_stack_preference` / `welfare_policy`) may not
 * exist in every partner DB, so the rich query is best-effort and we fall back to
 * the `client_name`-only column that is always present; on total failure we return
 * null and createJD degrades to exactly today's behavior. Never throws.
 *
 * NOTE: this reads only — it does NOT change `getRequirementDetail` (the critical
 * path), so a missing column can never break requisition loading.
 */
export async function getClientContext(
  clientId: string | null | undefined,
): Promise<ClientContext | null> {
  const id = typeof clientId === 'string' ? clientId.trim() : '';
  if (!id) return null;

  // 1) Rich query first (best-effort — enrichment columns may be absent).
  try {
    const r = await query<ClientRow>(
      `SELECT client_name, industry_category, technical_stack_preference, welfare_policy
         FROM client WHERE client_id = $1 LIMIT 1`,
      [id],
    );
    if (r.rows[0]) return buildClientContext(id, r.rows[0]);
  } catch {
    // column/table shape differs — fall through to the always-present name column.
  }

  // 2) Fallback: the `client_name` column we know exists (source of truth today).
  try {
    const r = await query<{ client_name: string | null }>(
      `SELECT client_name FROM client WHERE client_id = $1 LIMIT 1`,
      [id],
    );
    if (r.rows[0]) return buildClientContext(id, { client_name: r.rows[0].client_name });
  } catch {
    // partner-pg unreachable — degrade to no context.
  }

  return null;
}

// ──────────────────────────────────────────────────────────────────────
// requirement_clarification_record — HSM 录入的需求澄清内容
// ──────────────────────────────────────────────────────────────────────

/** 一条已录入的需求澄清记录(partner 表 requirement_clarification_record)。 */
export type RequirementClarificationRecord = {
  clarified_at: Date | string | null;
  content: string;
  clarifier_name: string | null;
  client_clarifier_name: string | null;
  clarification_type: string | null;
};

/**
 * 取某需求已录入的全部澄清记录,按澄清时间正序。
 * 澄清是 JD 生成的增强信息(非关键路径),调用方应容错处理(失败回退空数组)。
 */
export async function getClarificationRecords(
  jobRequisitionId: string,
): Promise<RequirementClarificationRecord[]> {
  const sql = `
    SELECT clarified_at, content, clarifier_name, client_clarifier_name, clarification_type
    FROM requirement_clarification_record
    WHERE job_requisition_id = $1
    ORDER BY clarified_at ASC
  `;
  const result = await query<RequirementClarificationRecord>(sql, [jobRequisitionId]);
  return result.rows.filter((r) => typeof r.content === 'string' && r.content.trim().length > 0);
}
