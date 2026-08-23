// Write Job_Posting instance to Neo4j via allmeta ontology API.
//
// Canonical schema (neo4j_data/objects_v0_1_015.json):
//   job_posting_id (pk), job_requisition_id (List<String>, FK→Job_Requisition),
//   sourcing_channel_id (List<String>, FK→Sourcing_Channel),
//   recruiter_employee_id (String, FK→Employee),
//   title, responsibility, requirement,
//   key_words (List<String>), type, recruitment_type,
//   work_years (Integer), age_range, degree_requirement, education_requirement,
//   city (List<String>), work_address (List<String>), salary_range,
//   publish_time (Timestamp), publish_status

import {
  safeWriteInstance,
  compact,
  nonEmptyString,
  asStringArray,
  asNumberOrNull,
  type WriteResult,
} from './_helpers';

export type WriteJobPostingInput = {
  job_posting_id: string;
  job_requisition_id: string;
  client_id?: string | null;
  recruiter_employee_id?: string | null;
  /** RoboHire generate-jd output `data` object. */
  roboHireData: Record<string, unknown>;
  /** Optional requirement detail (partner-pg getRequirementDetail result) for fallback fields. */
  requirement?: Record<string, unknown> | null;
  /** Override publish_status (default 'pending'). */
  publish_status?: string;
};

export async function writeJobPostingInstance(
  input: WriteJobPostingInput,
): Promise<WriteResult> {
  const jd = input.roboHireData;
  const req = input.requirement ?? {};

  const title = nonEmptyString(jd.title) ?? nonEmptyString(req.client_job_title) ?? '未命名岗位';
  const responsibility =
    nonEmptyString(jd.qualifications) ?? nonEmptyString(req.job_responsibility) ?? '';
  const requirementText =
    nonEmptyString(jd.hardRequirements) ?? nonEmptyString(req.job_requirement) ?? '';
  const keyWords = asStringArray(jd.searchKeywords);
  const type = nonEmptyString(jd.employmentType) ?? nonEmptyString(req.client_job_type) ?? '';
  const recruitmentType =
    nonEmptyString(req.recruitment_type) ?? nonEmptyString(jd.employmentType) ?? '';
  const workYears = asNumberOrNull(req.work_years);
  const ageRange = nonEmptyString(req.age_range) ?? '';
  const degreeRequirement =
    nonEmptyString(req.degree_requirement) ?? nonEmptyString(jd.education) ?? '';
  const educationRequirement = nonEmptyString(req.education_requirement) ?? '';
  // ontology `Job_Posting.city` 本来就是 List<String>(见文件头 canonical schema),
  // 但此前取的是兼容主城市标量 `req.city`,所以恒为 1 元素。改取读时解析出的
  // `city_names`(保序,首项 = 主城市;见 lib/partner-pg/requirements.ts CITY_NAMES_SQL),
  // 多城市需求从此在本体侧也是真多城市。
  // 🔴 这里只接受城市**名** —— `city_ids` 的 UUID 绝不进 ontology / Allmeta payload。
  const cityList = asStringArray(req.city_names).length > 0
    ? asStringArray(req.city_names)
    : asStringArray(req.city).length > 0
      ? asStringArray(req.city)
      : asStringArray(jd.location);
  const workAddress = asStringArray(req.work_address);
  const salaryRange = nonEmptyString(jd.salaryText) ?? nonEmptyString(req.salary_range) ?? '';

  const payload = compact({
    job_posting_id: input.job_posting_id,
    job_requisition_id: [input.job_requisition_id],
    sourcing_channel_id: [],
    recruiter_employee_id: nonEmptyString(input.recruiter_employee_id),
    title,
    responsibility,
    requirement: requirementText,
    key_words: keyWords,
    type,
    recruitment_type: recruitmentType,
    work_years: workYears,
    age_range: ageRange,
    degree_requirement: degreeRequirement,
    education_requirement: educationRequirement,
    city: cityList,
    work_address: workAddress,
    salary_range: salaryRange,
    publish_time: new Date().toISOString(),
    publish_status: input.publish_status ?? 'pending',
  });

  return safeWriteInstance('Job_Posting', payload);
}
