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
      row_to_json(s.*) AS specification_json
    FROM job_requisition r
    LEFT JOIN job_requisition_specification s
      ON s.job_requisition_specification_id = r.job_requisition_specification_id
    WHERE r.job_requisition_id = $1
    LIMIT 1
  `;
  const result = await query<{
    requirement_json: JobRequisition;
    specification_json: JobRequisitionSpecification | null;
  }>(sql, [jobRequisitionId]);

  const row = result.rows[0];
  if (!row) return null;

  const requirement = row.requirement_json;
  const specification = row.specification_json;

  return {
    ...requirement,
    specification,
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
