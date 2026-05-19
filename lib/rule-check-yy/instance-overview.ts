/**
 * Pure-data helpers for projecting candidate / job instances into the
 * "main fields" cards used by `/rule-check` batch preview + `/rule-check/batches/[batchId]`.
 *
 * Server-side safe (no JSX, returns `{label, value: string}[]`). UI atoms
 * render the values via their own definition-list components. RunsPreview's
 * legacy in-file picker (`collectMainFields`) renders JSX inline and is
 * kept separate; this module is the canonical data picker for any new code.
 */

import type { Instance } from "./types";

export interface MainFieldDatum {
  label: string;
  value: string;
}

export function pickCandidateInstance(instances: Instance[]): Instance | null {
  return (
    instances.find((i) => i.objectType === "Candidate") ??
    instances.find((i) => i.objectType === "Resume") ??
    null
  );
}

export function pickJobInstance(instances: Instance[]): Instance | null {
  return instances.find((i) => i.objectType === "Job_Requisition") ?? null;
}

export function collectCandidateFields(data: Record<string, unknown>): MainFieldDatum[] {
  const out: MainFieldDatum[] = [];
  const pickStr = (key: string): string | null => {
    const v = data[key];
    return typeof v === "string" && v.trim().length > 0 ? v : null;
  };
  const pickNum = (key: string): number | null => {
    const v = data[key];
    return typeof v === "number" ? v : null;
  };

  const name = pickStr("name") ?? pickStr("candidate_name");
  if (name) out.push({ label: "姓名", value: name });
  const candId = pickStr("candidate_id") ?? pickStr("id");
  if (candId) out.push({ label: "candidate_id", value: candId });
  const email = pickStr("email");
  if (email) out.push({ label: "email", value: email });
  const phone = pickStr("phone") ?? pickStr("phone_number");
  if (phone) out.push({ label: "phone", value: phone });

  const dob = pickStr("date_of_birth") ?? pickStr("birthday");
  if (dob) out.push({ label: "出生", value: dob });
  const gender = pickStr("gender");
  if (gender) out.push({ label: "性别", value: gender });
  const age = pickNum("age");
  if (age !== null) out.push({ label: "年龄", value: String(age) });

  // 居住地 (current city / residence) — surfaced early since often used for filters.
  const city = pickStr("current_city") ?? pickStr("location") ?? pickStr("city") ?? pickStr("residence");
  if (city) out.push({ label: "居住地", value: city });

  const edu = data["highest_education"];
  if (edu && typeof edu === "object" && !Array.isArray(edu)) {
    const e = edu as Record<string, unknown>;
    const school = typeof e.school === "string" ? e.school : null;
    const degree = typeof e.degree === "string" ? e.degree : null;
    const major = typeof e.major === "string" ? e.major : null;
    const summary = [school, degree, major].filter(Boolean).join(" · ");
    if (summary) out.push({ label: "学历", value: summary });
  }

  // 工作年限 — prefer explicit field, else compute from work_experience date diffs.
  const explicitYears = pickNum("total_years_experience");
  let years: number | null = explicitYears;
  if (years === null) {
    const we = data["work_experience"];
    if (Array.isArray(we)) {
      years = computeYearsOfExperience(we);
    }
  }
  if (years !== null) out.push({ label: "工作年限", value: `${years} 年` });

  const we = data["work_experience"];
  if (Array.isArray(we) && we.length > 0) {
    const first = we[0] as Record<string, unknown>;
    const company = typeof first.company === "string" ? first.company : null;
    const title = typeof first.title === "string" ? first.title : null;
    const start = typeof first.start_date === "string" ? first.start_date : null;
    const end = typeof first.end_date === "string" ? first.end_date : null;
    // 当前在职 — when latest entry has no end_date (or "present"), surface inline.
    const isCurrent =
      end === null ||
      end === undefined ||
      (typeof end === "string" && /^(present|至今|now)$/i.test(end.trim()));
    if (isCurrent && company) {
      out.push({ label: "当前在职", value: `${company}${title ? " · " + title : ""}` });
    }
    const summary = [
      company,
      title,
      start && end && !isCurrent ? `${start} — ${end}` : start && isCurrent ? `${start} — 至今` : start ?? end,
    ]
      .filter(Boolean)
      .join(" · ");
    if (summary) out.push({ label: "最近经历", value: summary });
  }

  // 求职意向
  const intent = pickStr("job_intent") ?? pickStr("desired_position") ?? pickStr("target_position");
  if (intent) out.push({ label: "求职意向", value: intent });

  // 期望薪资
  const expectedSalary = pickStr("expected_salary_range") ?? pickStr("expected_salary");
  if (expectedSalary) out.push({ label: "期望薪资", value: expectedSalary });

  const skills = data["skill_tags"];
  if (Array.isArray(skills) && skills.length > 0) {
    const head = skills
      .filter((s): s is string => typeof s === "string")
      .slice(0, 8)
      .join(" · ");
    const more = skills.length > 8 ? ` (+${skills.length - 8} more)` : "";
    if (head) out.push({ label: "技能", value: head + more });
  }

  return out;
}

/**
 * Parses a date string into year + month. Accepts `YYYY-MM`, `YYYY/MM`,
 * `YYYY-MM-DD`, `YYYY/MM/DD`. Returns null for unparseable input or strings
 * marked as "present" / "至今" / "now".
 */
export function parseYearMonth(input: unknown): { year: number; month: number } | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (/^(present|至今|now)$/i.test(trimmed)) return null;
  const m = /^(\d{4})[-/](\d{1,2})/.exec(trimmed);
  if (!m) return null;
  const year = parseInt(m[1]!, 10);
  const month = parseInt(m[2]!, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  if (month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * Sums total work-experience duration across all entries (in years, 1 decimal).
 * Missing `end_date` (or "present") falls back to current year-month.
 * Returns null if no parseable entries.
 */
export function computeYearsOfExperience(workExp: unknown[]): number | null {
  if (!Array.isArray(workExp) || workExp.length === 0) return null;
  const now = new Date();
  const nowYM = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  let totalMonths = 0;
  for (const entry of workExp) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const start = parseYearMonth(e.start_date);
    if (!start) continue;
    const end = parseYearMonth(e.end_date) ?? nowYM;
    const months = (end.year - start.year) * 12 + (end.month - start.month);
    if (months > 0) totalMonths += months;
  }
  if (totalMonths === 0) return null;
  return Math.round((totalMonths / 12) * 10) / 10;
}

export function collectJobFields(data: Record<string, unknown>): MainFieldDatum[] {
  const out: MainFieldDatum[] = [];
  const pickStr = (key: string): string | null => {
    const v = data[key];
    return typeof v === "string" && v.trim().length > 0 ? v : null;
  };
  const pickNum = (key: string): number | null => {
    const v = data[key];
    return typeof v === "number" ? v : null;
  };
  const pickArr = (key: string): string[] | null => {
    const v = data[key];
    if (!Array.isArray(v)) return null;
    const strs = v.filter((s): s is string => typeof s === "string");
    return strs.length > 0 ? strs : null;
  };

  const title = pickStr("title") ?? pickStr("job_title");
  if (title) out.push({ label: "标题", value: title });
  const jobId = pickStr("job_requisition_id") ?? pickStr("id");
  if (jobId) out.push({ label: "job_id", value: jobId });
  const client = pickStr("client") ?? pickStr("client_name");
  if (client) out.push({ label: "client", value: client });
  const dept = pickStr("department");
  if (dept) out.push({ label: "部门", value: dept });

  // 类别 — priority chain across common naming conventions.
  const category =
    pickStr("category") ??
    pickStr("job_category") ??
    pickStr("function") ??
    pickStr("job_family") ??
    pickStr("level");
  if (category) out.push({ label: "类别", value: category });

  // 工作地点
  const location = pickStr("location") ?? pickStr("work_location") ?? pickStr("city");
  if (location) out.push({ label: "工作地点", value: location });

  // 雇佣类型
  const employment = pickStr("employment_type") ?? pickStr("employment");
  if (employment) out.push({ label: "雇佣类型", value: employment });

  // 业务线
  const bu = pickStr("business_unit") ?? pickStr("bu");
  if (bu) out.push({ label: "业务线", value: bu });

  // 招聘人数
  const headcount = pickNum("headcount") ?? pickNum("openings");
  if (headcount !== null) out.push({ label: "招聘人数", value: `${headcount} 个` });

  const required = pickArr("required_skills");
  if (required) {
    const head = required.slice(0, 8).join(" · ");
    const more = required.length > 8 ? ` (+${required.length - 8} more)` : "";
    out.push({ label: "必需技能", value: head + more });
  }
  const preferred = pickArr("preferred_skills");
  if (preferred) {
    const head = preferred.slice(0, 6).join(" · ");
    const more = preferred.length > 6 ? ` (+${preferred.length - 6} more)` : "";
    out.push({ label: "优先技能", value: head + more });
  }

  const minYears = pickNum("min_years_experience");
  if (minYears !== null) out.push({ label: "最低经验", value: `${minYears} 年` });
  const edu = pickStr("education");
  if (edu) out.push({ label: "学历要求", value: edu });
  const ageMax = pickNum("age_max");
  if (ageMax !== null) out.push({ label: "年龄上限", value: String(ageMax) });
  const lang = pickStr("language_requirement");
  if (lang) out.push({ label: "语言要求", value: lang });
  const gender = pickStr("gender_requirement");
  if (gender) out.push({ label: "性别要求", value: gender });

  return out;
}
