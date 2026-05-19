#!/usr/bin/env node
/**
 * Simple Rule Check seed script — populates a self-contained, fully-schema-compliant
 * test data set into the configured domain (default RAAS-v1).
 *
 * Coverage:
 *   - Primary entities driving the 5 MVP rules:
 *       Candidate / Resume / Candidate_Expectation / Job_Requisition / Application
 *     Every field declared on the schema is populated (no sparse instances).
 *
 *   - Supporting entities that are FK targets, so all FK fields resolve to
 *     real MVP-namespaced records (no dangling references):
 *       Sourcing_Channel, Evaluation_Model, CSI_Department, Standard_Job_Role,
 *       HRO_Service_Contract, Client, Client_Department,
 *       Job_Requisition_Specification, Employee
 *
 *   - Writes are issued in dependency order so every FK target exists before
 *     the referrer is upserted.
 *
 * Usage:
 *   npm run simple-rule-check:seed:check    # schema verification only
 *   npm run simple-rule-check:seed          # full seed + verify
 *
 * Env:
 *   ONTOLOGY_API_BASE   (default http://localhost:3500)
 *   ONTOLOGY_API_TOKEN  (required)
 */

import { getJson, postJson } from "../lib/ontology-gen/client";
import { OntologyNotFoundError, OntologyRequestError } from "../lib/ontology-gen/errors";

interface Args {
  checkOnly: boolean;
  domain: string;
  apiBase: string;
  apiToken: string;
  timeoutMs: number;
}

const REQUIRED_LABELS = [
  // Primary (simple-rule-check reads these)
  "Candidate",
  "Candidate_Expectation",
  "Resume",
  "Job_Requisition",
  "Application",
  // Supporting (FK targets)
  "Sourcing_Channel",
  "Evaluation_Model",
  "CSI_Department",
  "Standard_Job_Role",
  "HRO_Service_Contract",
  "Client",
  "Client_Department",
  "Job_Requisition_Specification",
  "Employee",
] as const;

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const checkOnly = argv.includes("--check-only");
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const domain = get("--domain") ?? "RAAS-v1";
  const apiBase = get("--api-base") ?? process.env["ONTOLOGY_API_BASE"] ?? "http://localhost:3500";
  const apiToken = get("--api-token") ?? process.env["ONTOLOGY_API_TOKEN"] ?? "";
  const timeoutMs = parseInt(get("--timeout-ms") ?? "15000", 10);
  if (!apiToken) {
    process.stderr.write("ERROR: ONTOLOGY_API_TOKEN not set (and --api-token not provided)\n");
    process.exit(2);
  }
  return { checkOnly, domain, apiBase, apiToken, timeoutMs };
}

async function main(): Promise<void> {
  const args = parseArgs();
  process.stdout.write(
    `\n[simple-rule-check-seed] domain=${args.domain} apiBase=${args.apiBase}\n` +
      `[simple-rule-check-seed] mode=${args.checkOnly ? "check-only" : "seed"}\n\n`,
  );

  // ── Step 1: schema check.
  for (const label of REQUIRED_LABELS) {
    const path = `/api/v1/ontology/objects/${encodeURIComponent(label)}?domain=${encodeURIComponent(args.domain)}`;
    try {
      const obj = await getJson({
        apiBase: args.apiBase,
        apiToken: args.apiToken,
        path,
        timeoutMs: args.timeoutMs,
      });
      const fieldCount = extractFieldCount(obj);
      const pk = extractPk(obj);
      process.stdout.write(`  ✓ ${label.padEnd(32)} pk=${pk}  (${fieldCount} fields)\n`);
    } catch (err) {
      if (err instanceof OntologyNotFoundError) {
        process.stderr.write(
          `\n✗ Schema "${label}" NOT FOUND in domain ${args.domain}.\n` +
            `  Define it in the ontology repo first.\n`,
        );
        process.exit(3);
      }
      process.stderr.write(
        `\n✗ Schema check for "${label}" failed: ${(err as Error).message}\n`,
      );
      process.exit(4);
    }
  }
  process.stdout.write(`\n[simple-rule-check-seed] all required schemas present.\n\n`);

  if (args.checkOnly) {
    process.stdout.write(`[simple-rule-check-seed] --check-only: exiting after schema verification.\n`);
    process.exit(0);
  }

  // ── Step 2: build + upsert seed in dependency order.
  // Layer 0 — no FKs to anything we're creating.
  await upsertBatch("Sourcing_Channel",         buildSourcingChannels(),   "sourcing_channel_id", args);
  await upsertBatch("Evaluation_Model",         buildEvaluationModels(),   "evaluation_model_id", args);

  // Layer 1 — depend only on Layer 0 (or external-placeholder FKs).
  await upsertBatch("Client",                   buildClients(),            "client_id", args);
  await upsertBatch("HRO_Service_Contract",     buildHroServiceContracts(),"hro_service_contract_id", args);
  await upsertBatch("CSI_Department",           buildCsiDepartments(),     "csi_department_id", args);

  // Layer 2.
  await upsertBatch("Standard_Job_Role",        buildStandardJobRoles(),   "standard_job_role_id", args);
  await upsertBatch("Client_Department",        buildClientDepartments(),  "client_department_id", args);
  await upsertBatch("Employee",                 buildEmployees(),          "employee_id", args);
  await upsertBatch("Job_Requisition_Specification", buildJobRequisitionSpecifications(), "job_requisition_specification_id", args);

  // Layer 3 — primary entities that the simple-rule-check actually reads.
  await upsertBatch("Job_Requisition",          buildJobs(),               "job_requisition_id", args);
  await upsertBatch("Candidate",                buildCandidates(),         "candidate_id", args);
  await upsertBatch("Candidate_Expectation",    buildCandidateExpectations(), "candidate_expectation_id", args);
  await upsertBatch("Resume",                   buildResumes(),            "resume_id", args);
  await upsertBatch("Application",              buildApplications(),       "application_id", args);

  // ── Step 3: verification probe.
  process.stdout.write(`\n[simple-rule-check-seed] verifying writes…\n`);
  const verifications: Array<{ label: string; pk: string }> = [
    ...buildSourcingChannels().map((r) => ({ label: "Sourcing_Channel", pk: r.sourcing_channel_id })),
    ...buildEvaluationModels().map((r) => ({ label: "Evaluation_Model", pk: r.evaluation_model_id })),
    ...buildClients().map((r) => ({ label: "Client", pk: r.client_id })),
    ...buildHroServiceContracts().map((r) => ({ label: "HRO_Service_Contract", pk: r.hro_service_contract_id })),
    ...buildCsiDepartments().map((r) => ({ label: "CSI_Department", pk: r.csi_department_id })),
    ...buildStandardJobRoles().map((r) => ({ label: "Standard_Job_Role", pk: r.standard_job_role_id })),
    ...buildClientDepartments().map((r) => ({ label: "Client_Department", pk: r.client_department_id })),
    ...buildEmployees().map((r) => ({ label: "Employee", pk: r.employee_id })),
    ...buildJobRequisitionSpecifications().map((r) => ({ label: "Job_Requisition_Specification", pk: r.job_requisition_specification_id })),
    ...buildJobs().map((r) => ({ label: "Job_Requisition", pk: r.job_requisition_id })),
    ...buildCandidates().map((r) => ({ label: "Candidate", pk: r.candidate_id })),
    ...buildCandidateExpectations().map((r) => ({ label: "Candidate_Expectation", pk: r.candidate_expectation_id })),
    ...buildResumes().map((r) => ({ label: "Resume", pk: r.resume_id })),
    ...buildApplications().map((r) => ({ label: "Application", pk: r.application_id })),
  ];
  for (const v of verifications) {
    const path = `/api/v1/ontology/instances/${encodeURIComponent(v.label)}/${encodeURIComponent(v.pk)}?domain=${encodeURIComponent(args.domain)}`;
    try {
      await getJson({
        apiBase: args.apiBase,
        apiToken: args.apiToken,
        path,
        timeoutMs: args.timeoutMs,
      });
      process.stdout.write(`  ✓ ${v.label}/${v.pk}\n`);
    } catch (err) {
      process.stderr.write(`  ✗ ${v.label}/${v.pk}: ${(err as Error).message}\n`);
      process.exit(5);
    }
  }

  process.stdout.write(`\n[simple-rule-check-seed] done. ${verifications.length} instances confirmed.\n`);
}

// ─── upsert helper ───

async function upsertBatch(
  label: string,
  items: Record<string, unknown>[],
  pkField: string,
  args: Args,
): Promise<void> {
  process.stdout.write(`[seed] ${label}: writing ${items.length} item(s)…\n`);
  for (const item of items) {
    const body = { domainId: args.domain, ...item };
    const pkValue = String(item[pkField] ?? "");
    const domainQs = `?domain=${encodeURIComponent(args.domain)}`;
    try {
      await postJson({
        apiBase: args.apiBase,
        apiToken: args.apiToken,
        path: `/api/v1/ontology/instances/${encodeURIComponent(label)}${domainQs}`,
        body,
        timeoutMs: args.timeoutMs,
      });
      process.stdout.write(`       ✓ created/upserted ${label}/${pkValue}\n`);
    } catch (err) {
      if (err instanceof OntologyRequestError) {
        try {
          await postJson({
            apiBase: args.apiBase,
            apiToken: args.apiToken,
            path: `/api/v1/ontology/instances/${encodeURIComponent(label)}/${encodeURIComponent(pkValue)}${domainQs}`,
            body,
            method: "PUT",
            timeoutMs: args.timeoutMs,
          });
          process.stdout.write(`       ✓ updated ${label}/${pkValue} (PUT)\n`);
          continue;
        } catch (err2) {
          process.stderr.write(`       ✗ ${label}/${pkValue}: ${(err2 as Error).message}\n`);
          throw err2;
        }
      }
      process.stderr.write(`       ✗ ${label}/${pkValue}: ${(err as Error).message}\n`);
      throw err;
    }
  }
}

// ─── shared MVP-namespaced IDs (all in one place for FK consistency) ───

const ID = {
  // Supporting entities
  SOURCING_CHANNEL: "SC-MVP-001",
  EVAL_MODEL_BACKEND: "EM-MVP-BACKEND-001",
  CLIENT_TENCENT: "CL-MVP-TENCENT",
  CLIENT_BYTE: "CL-MVP-BYTE",
  HRO_PROVIDER_PLACEHOLDER: "HRP-MVP-001", // ID only; HRO_Service_Provider DataObject not seeded
  HRO_CONTRACT_TENCENT: "HSC-MVP-TENCENT-001",
  HRO_CONTRACT_BYTE: "HSC-MVP-BYTE-001",
  CSI_DEPT: "CSI-MVP-001",
  STD_ROLE_BACKEND: "SJR-MVP-BACKEND-001",
  CLIENT_DEPT_WXG: "CD-MVP-WXG",
  CLIENT_DEPT_AML: "CD-MVP-AML",
  EMP_RECRUITER: "EMP-MVP-RECRUITER-001",
  EMP_HSM: "EMP-MVP-HSM-001",
  JR_SPEC_TENCENT: "JRS-MVP-TENCENT-001",
  JR_SPEC_BYTE: "JRS-MVP-BYTE-001",
  // Primary entities
  JOB_TENCENT: "JR-MVP-TENCENT-001",
  JOB_BYTE: "JR-MVP-BYTE-001",
  CANDIDATES: [
    "C-MVP-001", "C-MVP-002", "C-MVP-003", "C-MVP-004", "C-MVP-005",
    "C-MVP-006", "C-MVP-007", "C-MVP-008", "C-MVP-009", "C-MVP-010",
  ] as const,
};

// ─── builders: supporting entities ───

function buildSourcingChannels(): Array<Record<string, unknown> & { sourcing_channel_id: string }> {
  return [
    {
      sourcing_channel_id: ID.SOURCING_CHANNEL,
      channel_name: "MVP 测试招聘渠道",
    },
  ];
}

function buildEvaluationModels(): Array<Record<string, unknown> & { evaluation_model_id: string }> {
  return [
    {
      evaluation_model_id: ID.EVAL_MODEL_BACKEND,
      model_name: "Backend Engineer Senior — MVP",
      target_role_type: "backend_engineer",
      must_have_skill_dimensions: ["Java", "Spring Boot", "MySQL"],
      nice_to_have_skill_dimensions: ["Kafka", "Redis"],
      culture_fit_dimensions: ["ownership", "communication"],
      growth_potential_indicators: ["promotion_velocity", "scope_increase"],
      stability_factors: ["avg_tenure_per_role"],
      motivation_assessment: ["technical_depth", "team_impact"],
      risk_evaluation_factors: ["frequent_short_tenure", "salary_jump"],
      resume_integrity_profile: "高完整度（教育、工作经历、技能、项目均完整）",
      suggested_level_and_salary: "P6 / 30000-60000 月薪",
      behavioral_indicators: "主动推进、能写设计文档、参与跨组协作",
      experience_match_criteria: "≥5 年后端开发经验，核心技术栈匹配",
      education_criteria: "本科及以上，计算机相关专业",
      scoring_rubric: "must-have 命中权重 60%，nice-to-have 20%，文化 10%，稳定性 10%",
      dimension_weights: "{must:0.6, nice:0.2, culture:0.1, stability:0.1}",
      scoring_scale: "0-100",
      pass_threshold: "75",
      final_recommendation_logic: "总分≥75 推荐；60-75 待人工复核；<60 不推荐",
      is_active: true,
      created_time: isoNow(),
      updated_time: isoNow(),
    },
  ];
}

function buildClients(): Array<Record<string, unknown> & { client_id: string }> {
  return [
    {
      client_id: ID.CLIENT_TENCENT,
      client_name: "腾讯",
      address: "深圳市南山区科技园",
      industry_category: "互联网",
      submission_materials: ["简历", "工作证明", "学历证明"],
      entry_day_rules: ["周一入场", "入场前3工作日完成审核"],
      technical_stack_preference: "Java / Spring Boot / Go",
      job_grade_rate_id: ["JGR-MVP-TENCENT-P6"],
      welfare_policy: "标准互联网企业福利包",
      total_competitors: 3,
      compliance_policy: "符合国家劳动法及行业合规要求",
      resume_template: "腾讯标准推荐模板 v2026",
    },
    {
      client_id: ID.CLIENT_BYTE,
      client_name: "字节",
      address: "北京市海淀区",
      industry_category: "互联网",
      submission_materials: ["简历", "学历证明"],
      entry_day_rules: ["每日滚动入场"],
      technical_stack_preference: "Go / Kubernetes / Kafka",
      job_grade_rate_id: ["JGR-MVP-BYTE-2-2"],
      welfare_policy: "标准互联网企业福利包",
      total_competitors: 5,
      compliance_policy: "符合国家劳动法及行业合规要求",
      resume_template: "字节标准推荐模板 v2026",
    },
  ];
}

function buildHroServiceContracts(): Array<Record<string, unknown> & { hro_service_contract_id: string }> {
  return [
    {
      hro_service_contract_id: ID.HRO_CONTRACT_TENCENT,
      contract_full_name: "MVP 腾讯外包服务总协议（演示用）",
      contract_short_name: "MVP-腾讯-2026",
      effective_date: "2026-01-01",
      expiry_date: "2027-12-31",
      month_standard_days: 21,
      day_standard_hours: 8,
      settlement_mode: "month",
      settlement_cycle: "monthly",
      client_id: ID.CLIENT_TENCENT,
      hro_service_provider_id: ID.HRO_PROVIDER_PLACEHOLDER,
      overtime_rhythm: "961",
      overtime_payment_rule: "工作日 1.5x，周末 2x",
      bonus_rules: "无年终奖",
      authorized_job_categories: ["后端工程师", "前端工程师", "测试工程师"],
    },
    {
      hro_service_contract_id: ID.HRO_CONTRACT_BYTE,
      contract_full_name: "MVP 字节外包服务总协议（演示用）",
      contract_short_name: "MVP-字节-2026",
      effective_date: "2026-01-01",
      expiry_date: "2027-12-31",
      month_standard_days: 21,
      day_standard_hours: 8,
      settlement_mode: "month",
      settlement_cycle: "monthly",
      client_id: ID.CLIENT_BYTE,
      hro_service_provider_id: ID.HRO_PROVIDER_PLACEHOLDER,
      overtime_rhythm: "1075",
      overtime_payment_rule: "工作日 1.5x",
      bonus_rules: "项目奖金",
      authorized_job_categories: ["后端工程师", "算法工程师"],
    },
  ];
}

function buildCsiDepartments(): Array<Record<string, unknown> & { csi_department_id: string }> {
  return [
    {
      csi_department_id: ID.CSI_DEPT,
      hro_service_provider_id: ID.HRO_PROVIDER_PLACEHOLDER,
      dept_name: "MVP 招聘交付一部",
      description: "MVP 演示用招聘交付部门",
      head_name: "MVP 部门负责人",
      head_contact: "mvp-head@example.com",
      specific_hiring_rules: "遵循通用招聘流程",
      red_line_policy: "执行公司通用红线政策",
      superior_department_id: "",
    },
  ];
}

function buildStandardJobRoles(): Array<Record<string, unknown> & { standard_job_role_id: string }> {
  return [
    {
      standard_job_role_id: ID.STD_ROLE_BACKEND,
      family: "Engineering",
      group: "Software",
      sequence: "Backend",
      name: "Senior Backend Engineer",
      level_scope: "P5-P7",
      description: "负责后端系统设计、开发、维护",
      leveling_matrix: "P5: 3-5年; P6: 5-8年; P7: 8+年",
      evaluation_model_id: ID.EVAL_MODEL_BACKEND,
      base_salary_band_ref: "BAND-Senior-Backend",
    },
  ];
}

function buildClientDepartments(): Array<Record<string, unknown> & { client_department_id: string }> {
  return [
    {
      client_department_id: ID.CLIENT_DEPT_WXG,
      client_id: ID.CLIENT_TENCENT,
      dept_name: "WXG 微信事业群",
      description: "腾讯微信事业群（演示用部门）",
      head_name: "WXG 部门负责人",
      head_contact: "wxg-head@example.com",
      specific_hiring_rules: "WXG 部门特定招聘规则（演示用）",
      red_line_policy: "WXG 红线政策（演示用）",
    },
    {
      client_department_id: ID.CLIENT_DEPT_AML,
      client_id: ID.CLIENT_BYTE,
      dept_name: "AML 算法机器学习",
      description: "字节 AML 部门（演示用）",
      head_name: "AML 部门负责人",
      head_contact: "aml-head@example.com",
      specific_hiring_rules: "AML 部门特定招聘规则（演示用）",
      red_line_policy: "AML 红线政策（演示用）",
    },
  ];
}

function buildEmployees(): Array<Record<string, unknown> & { employee_id: string }> {
  return [
    {
      employee_id: ID.EMP_RECRUITER,
      csi_department_id: ID.CSI_DEPT,
      name: "MVP 招聘专员",
      roles: ["recruiter"],
      phone: "13800000001",
      email: "recruiter-mvp@example.com",
      job_title: "高级招聘专员",
      is_active: true,
      shift_time: "09:30-18:30",
      supervisor_employee_id: ID.EMP_HSM,
    },
    {
      employee_id: ID.EMP_HSM,
      csi_department_id: ID.CSI_DEPT,
      name: "MVP HSM 交付负责人",
      roles: ["hsm", "delivery_lead"],
      phone: "13800000002",
      email: "hsm-mvp@example.com",
      job_title: "HSM 交付负责人",
      is_active: true,
      shift_time: "09:30-18:30",
      supervisor_employee_id: "",
    },
  ];
}

function buildJobRequisitionSpecifications(): Array<Record<string, unknown> & { job_requisition_specification_id: string }> {
  return [
    {
      job_requisition_specification_id: ID.JR_SPEC_TENCENT,
      hro_service_contract_id: ID.HRO_CONTRACT_TENCENT,
      client_id: ID.CLIENT_TENCENT,
      start_date: "2026-04-01",
      deadline: "2026-08-31",
      create_time: isoNow(),
      create_by: ID.EMP_HSM,
      sd_org_name: "腾讯 MVP 演示组",
      hsm_employee_id: ID.EMP_HSM,
      recruiter_employee_id: ID.EMP_RECRUITER,
      priority: "high",
      is_exclusive: false,
      number_of_competitors: 3,
      status: "open",
      completion_time: "",
    },
    {
      job_requisition_specification_id: ID.JR_SPEC_BYTE,
      hro_service_contract_id: ID.HRO_CONTRACT_BYTE,
      client_id: ID.CLIENT_BYTE,
      start_date: "2026-04-01",
      deadline: "2026-08-31",
      create_time: isoNow(),
      create_by: ID.EMP_HSM,
      sd_org_name: "字节 MVP 演示组",
      hsm_employee_id: ID.EMP_HSM,
      recruiter_employee_id: ID.EMP_RECRUITER,
      priority: "medium",
      is_exclusive: false,
      number_of_competitors: 5,
      status: "open",
      completion_time: "",
    },
  ];
}

// ─── builders: primary entities (all fields filled per schema) ───

interface JobRow extends Record<string, unknown> {
  job_requisition_id: string;
}

function buildJobs(): JobRow[] {
  return [
    {
      job_requisition_id: ID.JOB_TENCENT,
      job_requisition_specification_id: ID.JR_SPEC_TENCENT,
      csi_department_id: ID.CSI_DEPT,
      client_department_id: ID.CLIENT_DEPT_WXG,
      standard_job_role_id: ID.STD_ROLE_BACKEND,
      evaluation_model_id: ID.EVAL_MODEL_BACKEND,
      client_job_id: "TENCENT-WXG-BE-001",
      client_job_temp_id: "TENCENT-WXG-BE-TMP-001",
      client_job_title: "高级后端工程师",
      client_job_type: "技术研发",
      job_responsibility:
        "负责微信支付核心后端服务的设计与开发，包括高并发交易系统、风控引擎对接，参与重大架构升级与性能优化。",
      job_requirement:
        "5+ 年 Java/Spring Boot 后端开发经验；熟悉 MySQL、Redis、Kafka；有大型分布式系统设计经验优先。",
      job_type: "技术研发",
      recruitment_type: "社招",
      work_years: 5,
      gender: "不限",
      age_range: "25-40",
      degree_requirement: "本科",
      education_requirement: "统招本科及以上",
      city: "深圳",
      work_address: ["深圳市南山区科技园南区"],
      salary_range: "30000-80000",
      must_have_skills: ["Java", "Spring Boot", "MySQL"],
      nice_to_have_skills: ["Kafka", "Redis", "微服务"],
      language_requirements: "",
      negative_requirement: "拒绝有竞业纠纷在岗候选人",
      headcount: 2,
      hc_status: "open",
      fill_difficulty: "medium",
      urgency_level: "high",
      open_date: dateOnly(daysAgoIso(30)),
      required_arrival_date: dateOnly(daysAgoIso(-30)),
      work_schedule_type: "961",
      require_foreigner: false,
      clarify_questions: ["是否接受加班", "是否有大型电商或社交业务经验"],
      recruitment_strategies: "猎头 + 内部推荐 + 招聘网站",
      interview_mode: "remote",
      interview_process: "HR 初筛 → 技术 1 面 → 技术 2 面 → HM 终面 → Offer",
      expected_level: "P6",
    },
    {
      job_requisition_id: ID.JOB_BYTE,
      job_requisition_specification_id: ID.JR_SPEC_BYTE,
      csi_department_id: ID.CSI_DEPT,
      client_department_id: ID.CLIENT_DEPT_AML,
      standard_job_role_id: ID.STD_ROLE_BACKEND,
      evaluation_model_id: ID.EVAL_MODEL_BACKEND,
      client_job_id: "BYTE-AML-BE-001",
      client_job_temp_id: "BYTE-AML-BE-TMP-001",
      client_job_title: "高级后端工程师",
      client_job_type: "技术研发",
      job_responsibility:
        "负责字节 AML 算法机器学习平台后端服务的开发，参与训练任务调度与模型部署链路建设。",
      job_requirement:
        "5+ 年 Go/Kubernetes 经验；熟悉分布式存储与消息中间件；ML 平台经验优先。",
      job_type: "技术研发",
      recruitment_type: "社招",
      work_years: 5,
      gender: "不限",
      age_range: "25-40",
      degree_requirement: "本科",
      education_requirement: "统招本科及以上",
      city: "北京",
      work_address: ["北京市海淀区中关村软件园"],
      salary_range: "30000-75000",
      must_have_skills: ["Go", "Kubernetes", "Kafka"],
      nice_to_have_skills: ["gRPC", "Pulsar"],
      language_requirements: "",
      negative_requirement: "无",
      headcount: 3,
      hc_status: "open",
      fill_difficulty: "high",
      urgency_level: "medium",
      open_date: dateOnly(daysAgoIso(20)),
      required_arrival_date: dateOnly(daysAgoIso(-45)),
      work_schedule_type: "1075",
      require_foreigner: false,
      clarify_questions: ["是否有 ML 平台经验"],
      recruitment_strategies: "猎头 + 招聘网站",
      interview_mode: "onsite",
      interview_process: "HR 初筛 → 技术 1 面 → 技术 2 面 → HM 终面 → Offer",
      expected_level: "P6",
    },
  ];
}

interface CandidateRow extends Record<string, unknown> {
  candidate_id: string;
}

function buildCandidates(): CandidateRow[] {
  // Common defaults; per-candidate overrides applied below.
  const base = (overrides: Partial<CandidateRow>): CandidateRow => ({
    candidate_id: "",
    employee_id: ID.EMP_RECRUITER,
    is_locked: false,
    lock_start_time: "",
    referrer_employee_id: "",
    id_number: "—",
    name: "—",
    nationality: "中国",
    gender: "男",
    birth_date: "1990-01-01",
    mobile: "13800000000",
    email: "candidate@example.com",
    current_location: "深圳",
    highest_acquired_degree: "本科",
    unified_enrollment: true,
    experience_years: 6,
    flight_risk_level: "low",
    max_salary_limit: 80000,
    status: "active",
    state: "available",
    blacklist_status: false,
    marital_fertility_status: "未婚",
    conflict_interest_declaration: "无亲属在腾讯任职。",
    conflict_clearance_deadline: "",
    gap_reason: "",
    previous_level: "",
    expected_degree: "",
    expected_graduation_date: "",
    ...overrides,
  });

  return [
    base({ candidate_id: "C-MVP-001", name: "薪资缺失候选人", gender: "男",   birth_date: "1990-03-15", experience_years: 6, max_salary_limit: 70000 }),
    base({ candidate_id: "C-MVP-002", name: "薪资正常候选人", gender: "女",   birth_date: "1992-07-20", experience_years: 6, max_salary_limit: 70000 }),
    base({ candidate_id: "C-MVP-003", name: "高风险回流候选人",     gender: "男", birth_date: "1989-01-10", experience_years: 8, max_salary_limit: 60000 }),
    base({ candidate_id: "C-MVP-004", name: "中软国际正常离职候选人", gender: "男", birth_date: "1988-05-22", experience_years: 9, max_salary_limit: 60000 }),
    base({ candidate_id: "C-MVP-005", name: "华腾EHS离职候选人",     gender: "男", birth_date: "1991-08-08", experience_years: 6, max_salary_limit: 60000 }),
    base({ candidate_id: "C-MVP-006", name: "无外包经历候选人",       gender: "女", birth_date: "1993-12-30", experience_years: 5, max_salary_limit: 60000 }),
    base({ candidate_id: "C-MVP-007", name: "华为短期离职候选人",     gender: "男", birth_date: "1990-06-01", experience_years: 7, max_salary_limit: 60000 }),
    base({ candidate_id: "C-MVP-008", name: "华为长期离职候选人",     gender: "男", birth_date: "1989-02-14", experience_years: 8, max_salary_limit: 60000 }),
    base({ candidate_id: "C-MVP-009", name: "近期已被淘汰候选人",     gender: "男", birth_date: "1991-11-11", experience_years: 6, max_salary_limit: 60000 }),
    base({ candidate_id: "C-MVP-010", name: "早期已被淘汰候选人",     gender: "女", birth_date: "1992-09-09", experience_years: 7, max_salary_limit: 60000 }),
  ];
}

interface CandidateExpectationRow extends Record<string, unknown> {
  candidate_expectation_id: string;
}

function buildCandidateExpectations(): CandidateExpectationRow[] {
  const base = (id: string, candidateId: string, salaryRange: string): CandidateExpectationRow => ({
    candidate_expectation_id: id,
    candidate_id: candidateId,
    expected_position: "高级后端工程师",
    expected_location: "深圳",
    expected_salary_range: salaryRange,
    outsourcing_acceptance_level: "accept",
    expected_industry: "互联网",
    expected_company_size: "大型",
    constraints: ["不接受长期出差"],
    updated_time: isoNow(),
  });

  return [
    // C-MVP-001: 期望薪资范围为空 → 触发 10-7 pending
    {
      candidate_expectation_id: "CE-MVP-001",
      candidate_id: "C-MVP-001",
      expected_position: "高级后端工程师",
      expected_location: "深圳",
      expected_salary_range: "",
      outsourcing_acceptance_level: "accept",
      expected_industry: "互联网",
      expected_company_size: "大型",
      constraints: [],
      updated_time: isoNow(),
    },
    // C-MVP-002: 50000-70000 在 Job upper 80000 内 → pass
    base("CE-MVP-002", "C-MVP-002", "50000-70000"),
    base("CE-MVP-003", "C-MVP-003", "45000-60000"),
    base("CE-MVP-004", "C-MVP-004", "45000-60000"),
    base("CE-MVP-005", "C-MVP-005", "45000-60000"),
    base("CE-MVP-006", "C-MVP-006", "45000-60000"),
    base("CE-MVP-007", "C-MVP-007", "45000-60000"),
    base("CE-MVP-008", "C-MVP-008", "45000-60000"),
    base("CE-MVP-009", "C-MVP-009", "45000-60000"),
    base("CE-MVP-010", "C-MVP-010", "45000-60000"),
  ];
}

interface ResumeRow extends Record<string, unknown> {
  resume_id: string;
  candidate_id: string;
}

interface WorkExperienceEntry {
  company: string;
  title: string;
  start_date: string;
  end_date: string;
  departure_code?: string;
  responsibilities?: string;
}

function workExpJson(entries: WorkExperienceEntry[]): string {
  return JSON.stringify(entries);
}

function buildResumes(): ResumeRow[] {
  const eduJson = JSON.stringify([
    {
      school: "复旦大学",
      degree: "本科",
      major: "计算机科学与技术",
      graduation_year: 2012,
      is_full_time: true,
    },
  ]);

  const projectJson = JSON.stringify([
    {
      project_name: "大型交易系统重构",
      role: "后端负责人",
      duration: "2022-01 ~ 2024-06",
      description: "主导亿级 QPS 后端架构升级，优化 P99 延迟。",
    },
  ]);

  const langJson = JSON.stringify([
    { language: "中文", level: "母语" },
    { language: "英语", level: "CET-6" },
  ]);

  const base = (
    overrides: Partial<ResumeRow> & {
      resume_id: string;
      candidate_id: string;
      work_experience: string;
      skill_tags: string[];
    },
  ): ResumeRow => ({
    job_requisition_id: [ID.JOB_TENCENT],
    sourcing_channel_id: ID.SOURCING_CHANNEL,
    project_experience: projectJson,
    education_experience: eduJson,
    language_skills: langJson,
    file_path: "/mvp/seed/resume-placeholder.pdf",
    is_original: true,
    skill_ranking: "Java>MySQL>Spring Boot",
    highlight_keywords: "亿级流量；高可用；分布式",
    recommendation_reason: "技术栈高度匹配，履历清晰，背景稳定。",
    project_description_validity: "validated",
    certificate: "PMP；OCP",
    portfolio_attachment: "",
    language: "zh-CN",
    employee_id: ID.EMP_RECRUITER,
    created_time: isoNow(),
    updated_time: isoNow(),
    ...overrides,
  });

  return [
    base({
      resume_id: "R-MVP-001",
      candidate_id: "C-MVP-001",
      work_experience: workExpJson([
        { company: "百度", title: "后端工程师", start_date: "2020-03", end_date: "2025-12" },
      ]),
      skill_tags: ["Java", "Spring Boot", "MySQL"],
    }),
    base({
      resume_id: "R-MVP-002",
      candidate_id: "C-MVP-002",
      work_experience: workExpJson([
        { company: "阿里", title: "后端工程师", start_date: "2019-06", end_date: "2025-11" },
      ]),
      skill_tags: ["Java", "Spring Boot", "MySQL", "Redis"],
    }),
    base({
      resume_id: "R-MVP-003",
      candidate_id: "C-MVP-003",
      work_experience: workExpJson([
        {
          company: "中软国际",
          title: "项目工程师",
          start_date: "2020-01",
          end_date: "2024-02",
          departure_code: "A15",
        },
      ]),
      skill_tags: ["Java", "MySQL"],
    }),
    base({
      resume_id: "R-MVP-004",
      candidate_id: "C-MVP-004",
      work_experience: workExpJson([
        {
          company: "中软国际",
          title: "项目工程师",
          start_date: "2020-01",
          end_date: "2024-08",
          departure_code: "A1",
        },
      ]),
      skill_tags: ["Java", "MySQL"],
    }),
    base({
      resume_id: "R-MVP-005",
      candidate_id: "C-MVP-005",
      work_experience: workExpJson([
        {
          company: "华腾",
          title: "测试工程师",
          start_date: "2019-09",
          end_date: "2023-12",
          departure_code: "A13(1)EHS",
        },
      ]),
      skill_tags: ["Java", "MySQL"],
    }),
    base({
      resume_id: "R-MVP-006",
      candidate_id: "C-MVP-006",
      work_experience: workExpJson([
        { company: "美团", title: "后端工程师", start_date: "2020-07", end_date: "2025-08" },
      ]),
      skill_tags: ["Java", "MySQL"],
    }),
    base({
      resume_id: "R-MVP-007",
      candidate_id: "C-MVP-007",
      work_experience: workExpJson([
        {
          company: "华为",
          title: "后端工程师",
          start_date: "2020-04",
          end_date: dateOnly(daysAgoIso(30)),
        },
      ]),
      skill_tags: ["Java", "Spring Boot"],
    }),
    base({
      resume_id: "R-MVP-008",
      candidate_id: "C-MVP-008",
      work_experience: workExpJson([
        {
          company: "华为",
          title: "后端工程师",
          start_date: "2019-04",
          end_date: dateOnly(daysAgoIso(240)),
        },
      ]),
      skill_tags: ["Java", "Spring Boot"],
    }),
    base({
      resume_id: "R-MVP-009",
      candidate_id: "C-MVP-009",
      work_experience: workExpJson([
        { company: "京东", title: "后端工程师", start_date: "2020-03", end_date: "2025-09" },
      ]),
      skill_tags: ["Java", "Spring Boot"],
    }),
    base({
      resume_id: "R-MVP-010",
      candidate_id: "C-MVP-010",
      work_experience: workExpJson([
        { company: "京东", title: "后端工程师", start_date: "2019-03", end_date: "2025-04" },
      ]),
      skill_tags: ["Java", "Spring Boot"],
    }),
  ];
}

interface ApplicationRow extends Record<string, unknown> {
  application_id: string;
}

function buildApplications(): ApplicationRow[] {
  const base = (overrides: Partial<ApplicationRow> & { application_id: string }): ApplicationRow => ({
    client_id: ID.CLIENT_TENCENT,
    job_requisition_id: ID.JOB_TENCENT,
    candidate_id: "",
    resume_id: "",
    recruiter_employee_id: ID.EMP_RECRUITER,
    status: "筛选淘汰",
    stage: "resume_screening",
    matching_score: 65,
    process_sla: isoNow(),
    push_timestamp: isoNow(),
    duplicate_check_result: "no_duplicate",
    original_level: "P6",
    supplier_suggested_level: "P6",
    negotiated_level: "P6",
    compliance_credential: "no_pending",
    approved_onboard_date: "",
    actual_onboard_date: "",
    sla_deadline: isoNow(),
    portfolio_attachment: "",
    notes: "MVP 演示数据",
    has_referral_bonus: false,
    ...overrides,
  });

  return [
    base({
      application_id: "AH-MVP-001",
      candidate_id: "C-MVP-009",
      resume_id: "R-MVP-009",
      push_timestamp: daysAgoIso(42),
      sla_deadline: daysAgoIso(20),
      status: "筛选淘汰",
    }),
    base({
      application_id: "AH-MVP-002",
      candidate_id: "C-MVP-010",
      resume_id: "R-MVP-010",
      push_timestamp: daysAgoIso(150),
      sla_deadline: daysAgoIso(120),
      status: "筛选淘汰",
    }),
  ];
}

// ─── date helpers ───

function daysAgoIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function isoNow(): string {
  return new Date().toISOString();
}

// ─── schema helpers ───

function extractFieldCount(schema: unknown): number {
  if (typeof schema !== "object" || schema === null) return 0;
  const obj = schema as Record<string, unknown>;
  const props = obj["properties"];
  if (typeof props === "string") {
    try {
      const parsed = JSON.parse(props);
      if (Array.isArray(parsed)) return parsed.length;
    } catch {
      // fall through
    }
  }
  if (Array.isArray(props)) return props.length;
  if (typeof props === "object" && props !== null) return Object.keys(props).length;
  return 0;
}

function extractPk(schema: unknown): string {
  if (typeof schema !== "object" || schema === null) return "(unknown)";
  const obj = schema as Record<string, unknown>;
  return typeof obj["primary_key"] === "string" ? (obj["primary_key"] as string) : "(unknown)";
}

main().catch((err) => {
  process.stderr.write(`\n[simple-rule-check-seed] FATAL: ${(err as Error).message}\n`);
  if ((err as Error).stack) {
    process.stderr.write((err as Error).stack + "\n");
  }
  process.exit(1);
});
