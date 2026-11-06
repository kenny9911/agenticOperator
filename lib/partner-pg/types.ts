// lib/partner-pg/types.ts
//
// TypeScript shapes mirroring partner's Prisma models. We don't import
// partner's @prisma/client — we hand-mirror just the fields AO agents read.
//
// Source of truth: raas_v4/backend/prisma/schema.prisma
// Last synced: 2026-05-20 (schema rev = current)

// ──────────────────────────────────────────────────────────────────────
// JobRequisitionSpecification (HRO contract metadata layer)
// ──────────────────────────────────────────────────────────────────────

export type JobRequisitionSpecification = {
  job_requisition_specification_id: string;
  hro_service_contract_id: string | null;
  client_id: string | null;
  start_date: Date | string | null;
  deadline: Date | string | null;
  create_time: Date | string | null;
  create_by: string | null;
  sd_org_name: string | null;
  hsm_employee_id: string | null;
  recruiter_employee_id: string | null;
  assigned_hsm_name: string | null;
  assigned_recruiter_name: string | null;
  priority: string | null;
  is_exclusive: boolean | null;
  number_of_competitors: number | null;
  status: string | null;
  completion_time: Date | string | null;
  updated_at: Date | string;
};

// ──────────────────────────────────────────────────────────────────────
// JobRequisition (canonical recruitment requirement)
// ──────────────────────────────────────────────────────────────────────

export type JobRequisition = {
  job_requisition_id: string;
  job_requisition_specification_id: string | null;
  csi_department_id: string | null;
  client_department_id: string | null;
  client_id: string | null;
  standard_job_role_id: string | null;
  evaluation_model_id: string | null;
  client_job_id: string | null;
  client_job_temp_id: string | null;
  client_job_title: string | null;
  client_job_type: string | null;
  job_responsibility: string | null;
  job_requirement: string | null;
  job_type: string | null;
  recruitment_type: string | null;
  work_years: number | null;
  gender: string | null;
  age_range: string | null;
  degree_requirement: string | null;
  education_requirement: string | null;
  city: string | null;
  city_id: string | null;
  work_address: unknown;
  salary_range: string | null;
  must_have_skills: string[] | null;
  nice_to_have_skills: string[] | null;
  language_requirements: string | null;
  negative_requirement: string | null;
  qualifications: string | null;
  hard_requirements: string | null;
  nice_to_have: string | null;
  interview_requirements: string | null;
  evaluation_rules: string | null;
  benefits: string | null;
  headcount: number | null;
  competitor_application_count: number;
  hc_status: string | null;
  fill_difficulty: string | null;
  urgency_level: string | null;
  open_date: Date | string | null;
  required_arrival_date: Date | string | null;
  work_schedule_type: string | null;
  require_foreigner: boolean | null;
  clarify_questions: unknown;
  recruitment_strategies: string | null;
  interview_mode: string | null;
  interview_process: string | null;
  first_interviewer_name: string | null;
  final_interviewer_name: string | null;
  first_interview_format: string | null;
  final_interview_format: string | null;
  expected_level: string | null;
  client_contact_name: string | null;
  demand_type: string | null;
  client_published_at: Date | string | null;
  client_updated_at: Date | string | null;
  oa_department: string | null;
  service_bg: string | null;
  business_pm_name: string | null;
  interviewer_names_text: string | null;
  // 2026-05-19 added — sd_org_name moved into JobRequisition (was only in spec)
  // 但实际 schema 用 first_level_department / oa_department / sd_org_name 中的
  // sd_org_name 仍在 spec 表上,这里照搬 spec 字段透传(JOIN 后 SELECT row_to_json)
  first_level_department?: string | null;
  sd_org_name?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

// ──────────────────────────────────────────────────────────────────────
// 复合返回 — getRequirementDetail 返回 r + specification
// ──────────────────────────────────────────────────────────────────────

export type RequirementDetail = JobRequisition & {
  /** JOIN 出来的整段 specification(row_to_json),允许 null(spec 关系丢失时). */
  specification: JobRequisitionSpecification | null;
};

// ──────────────────────────────────────────────────────────────────────
// Candidate / Resume / Application (Task 8 用到)
// ──────────────────────────────────────────────────────────────────────

export type CandidateRow = {
  candidate_id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  current_location: string | null;
  current_company: string | null;
  current_title: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type ResumeRow = {
  resume_id: string;
  candidate_id: string;
  source_etag: string | null;
  source_bucket: string | null;
  source_object_key: string | null;
  source_filename: string | null;
  parsed_data: Record<string, unknown> | null;
  parsed_at: Date | string | null;
  created_at: Date | string;
};

export type ApplicationRow = {
  application_id: string;
  candidate_id: string;
  job_requisition_id: string | null;
  sourcing_channel_id: string | null;
  pipeline_stage: string | null;
  created_at: Date | string;
};

// ──────────────────────────────────────────────────────────────────────
// CandidateMatchResult (Task 9 用到)
// ──────────────────────────────────────────────────────────────────────

export type CandidateMatchResultRow = {
  candidate_match_result_id: string;
  candidate_id: string;
  job_requisition_id: string;
  job_posting_id: string | null;
  matching_score: number | null;
  match_data: Record<string, unknown> | null;
  source: string | null; // 'need_interview' | 'no_interview' | 'failed'
  created_at: Date | string;
};
