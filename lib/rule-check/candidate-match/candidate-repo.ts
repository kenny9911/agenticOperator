// Candidate record sourcing for the identity agent: a mapper from the RESUME_PROCESSED
// event shape, plus a repo port (injectable) for fetching existing candidates to
// compare against. The partner-pg implementation prefilters cheaply (same email /
// name / mobile); the heavy fuzzy judgment then runs only over that small candidate set.

import { query, isPartnerPgConfigured } from '@/lib/partner-pg/client';
import { normalizePhone } from './field-normalize';
import type { CandidateRecord } from './types';

/** Map the RESUME_PROCESSED event into a CandidateRecord. The real producer
 *  (resume-parser-agent) emits the nested candidate/resume objects EMPTY and puts the
 *  parsed RoboHire output under parsed.data (flat: name/phone/email + education[]
 *  {school,degree,major,endDate}). So we read parsed.data first, then fall back to the
 *  legacy nested shape. Defensive: every field optional; empty event → 'unknown'. */
export function candidateFromResumeProcessed(ev: Record<string, any>): CandidateRecord {
  const p = (ev?.parsed?.data ?? {}) as Record<string, any>;
  const c = (ev?.candidate ?? {}) as Record<string, any>;
  const eduP = ((p.education ?? [])[0] ?? {}) as Record<string, any>;
  const eduN = ((ev?.resume?.education_history ?? [])[0] ?? {}) as Record<string, any>;
  return {
    candidate_id: ev?.candidate_id ?? ev?.upload_id ?? 'unknown',
    name: p.name ?? c.name ?? null,
    phone: p.phone ?? c.mobile ?? null,
    email: p.email ?? c.email ?? null,
    gender: p.gender ?? c.gender ?? null,
    school: eduP.school ?? eduN.institution ?? eduN.school ?? null,
    major: eduP.major ?? eduN.field ?? eduN.major ?? null,
    degree: eduP.degree ?? eduN.degree ?? c.highest_acquired_degree ?? null,
    graduationYear: eduP.endDate ?? eduN.graduationYear ?? eduN.endDate ?? null,
  };
}

export interface CandidateRepo {
  /** Existing candidates that share an identity signal with `rec` (excluding self). */
  findComparisonCandidates(rec: CandidateRecord): Promise<CandidateRecord[]>;
}

/** Partner-Postgres backed repo. Prefilters on email / name / normalized mobile so the
 *  fuzzy engine only runs over plausible duplicates. Best-effort: returns [] when
 *  partner-pg is unconfigured or the query fails (the agent is dark-launched). */
export const partnerPgCandidateRepo: CandidateRepo = {
  async findComparisonCandidates(rec) {
    if (!isPartnerPgConfigured()) return [];
    const phone = normalizePhone(rec.phone);
    const conds: string[] = [];
    const params: unknown[] = [];
    if (rec.email) {
      params.push(rec.email);
      conds.push(`lower(email) = lower($${params.length})`);
    }
    if (rec.name) {
      params.push(rec.name);
      // Case + space insensitive, mirroring normalizeName, so fuzzy-name variants
      // (zhang san / Zhang San, 张 三 / 张三) still enter the pool. The prefilter must
      // be a SUPERSET of what the fuzzy engine can match (over-stripping spaces is OK).
      conds.push(`lower(replace(name,' ','')) = lower(replace($${params.length},' ',''))`);
    }
    if (phone) {
      params.push(`%${phone}`);
      conds.push(`regexp_replace(coalesce(mobile,''), '\\D', '', 'g') LIKE $${params.length}`);
    }
    if (conds.length === 0) return [];
    params.push(rec.candidate_id);
    const selfParam = `$${params.length}`;
    try {
      // raas_v4 candidate 是扁平列(graduation_school / highest_acquired_degree),
      // 没有 education_history JSONB —— SELECT 它会「column does not exist」报错。
      const res = await query<Record<string, any>>(
        `SELECT candidate_id, name, mobile, email, gender, graduation_school, highest_acquired_degree
           FROM candidate
          WHERE (${conds.join(' OR ')}) AND candidate_id <> ${selfParam}
          LIMIT 25`,
        params,
      );
      return res.rows.map((r) => ({
        candidate_id: String(r.candidate_id),
        name: r.name ?? null,
        phone: r.mobile ?? null,
        email: r.email ?? null,
        gender: r.gender ?? null,
        // school/degree 直取扁平列;major/graduationYear 库里没存 → null(IDENTITY-3 六字段
        // 因缺字段保守不误命中,IDENTITY-1 手机号 / IDENTITY-2 姓名+邮箱 正常工作)。
        school: r.graduation_school ?? null,
        major: null,
        degree: r.highest_acquired_degree ?? null,
        graduationYear: null,
      }));
    } catch (e) {
      // best-effort:查不到就空池让 agent soft-fail。但**不能再静默吞掉 schema/语法错** ——
      // 之前 SELECT education_history 报错被这里吞掉,导致去重几个月恒空池而无人察觉。
      console.warn(`[candidate-repo] findComparisonCandidates 查询失败(对比池置空):${(e as Error).message}`);
      return [];
    }
  },
};
