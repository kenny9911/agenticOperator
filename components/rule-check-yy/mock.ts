/**
 * Mock fixtures for the /rule-check UI.
 *
 * Three representative `RuleCheckRunAudited` records that exercise every
 * UI pattern:
 *   - run-001: passed (happy path, validation all green)
 *   - run-002: blocked (red verdict, decisive evidence, rootCause four-section)
 *   - run-003: pending_human (forced by validation; LLM said blocked but
 *     `evidence_grounded=false`, override badge shown)
 *
 * Replaced in Phase UI-5 with re-exports from `lib/rule-check/`.
 *
 * Per repo convention these objects are declared inline (FleetContent pattern).
 */

import type { RuleCheckRunAudited } from "@/lib/rule-check";

const PROMPT_SAMPLE = `[system]
你是一名 Rule Evaluation Agent。基于给定的 rule 原文 + candidate 的真实数据,
…(focusing system message, 1.5KB)…

[user]
## 角色
你是腾讯互动娱乐事业群的资深招聘顾问 RaaS Agent。

## 重要约束
1. 你只能基于本 prompt 提供的数据做判断。
2. 不得编造 evidence、规则、字段。
…

## 当前时间
2026-05-12T14:31:08+08:00

## 运行时输入

### client
client_name: 腾讯
department: WXG

### 招聘岗位 (Job_Requisition)
\`\`\`json
{ "job_requisition_id": "JR-MVP-TENCENT-001",
  "title": "后端工程师 · WXG · 高级",
  "salary_range": "30000-80000",
  "max_salary_limit": 80000,
  "required_skills": ["Go", "MySQL", "Kafka"] }
\`\`\`

### 候选人简历 (Resume)
\`\`\`json
{ "candidate_id": "C-MVP-001",
  "resume_id": "R-MVP-001",
  "work_experience": [{ "company": "中软国际", "departure_code": "A15" }],
  "skill_tags": ["Go", "MySQL"] }
\`\`\`
…(rule definitions, output schema, ~12KB more)…`;

export const MOCK_RUNS: RuleCheckRunAudited[] = [
  // ── run-001: PASSED ──────────────────────────────────────────────
  {
    runId: "01HXC3M9R7N8K4PQZ5VYDFG2T1",
    batchId: "01HXC3M9R7N8K4PQZ5VYDFG2T0",
    timestamp: "2026-05-12T14:31:08+08:00",
    input: {
      actionRef: "matchResume",
      ruleId: "10-7",
      candidateId: "C-MVP-002",
      jobRef: "JR-MVP-TENCENT-001",
      scope: { client: "腾讯", department: "WXG" },
      domain: "RAAS-v1",
    },
    fetched: {
      rule: {
        id: "10-7",
        name: "期望薪资校验",
        sourceText:
          "候选人 expected_salary_range 上限不得超过该岗位 max_salary_limit。若候选人未填写期望薪资,则需人工确认。",
        stepOrder: 3,
        applicableScope: "通用",
      },
      instances: [
        {
          objectType: "Job_Requisition",
          objectId: "JR-MVP-TENCENT-001",
          data: {
            job_requisition_id: "JR-MVP-TENCENT-001",
            title: "后端工程师 · WXG · 高级",
            max_salary_limit: 80000,
            salary_range: "30000-80000",
            required_skills: ["Go", "MySQL", "Kafka"],
          },
        },
        {
          objectType: "Resume",
          objectId: "R-MVP-002",
          data: {
            candidate_id: "C-MVP-002",
            resume_id: "R-MVP-002",
            expected_salary_range: "50000-70000",
            skill_tags: ["Go", "MySQL", "Kafka", "Redis"],
            work_experience: [
              { company: "字节跳动", title: "后端工程师", departure_code: "A1" },
            ],
          },
        },
      ],
    },
    prompt: PROMPT_SAMPLE,
    promptProvenance: {
      promptSha256:
        "f3a1c9d7b2e8a04c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c",
      actionObjectSha256:
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
      generatePromptInput: {
        actionRef: "matchResume",
        client: "腾讯",
        clientDepartment: "WXG",
        domain: "RAAS-v1",
        runtimeInputDigest: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
      },
      resolvedAt: "2026-05-12T14:31:00+08:00",
    },
    ontologyApiTrace: [
      {
        requestUrl: "http://localhost:3500/api/v1/ontology/instances/Job_Requisition/JR-MVP-TENCENT-001?domain=RAAS-v1",
        requestMethod: "GET",
        requestHeaders: { Authorization: "Bearer ***", Accept: "application/json" },
        responseStatus: 200,
        responseBody: {
          job_requisition_id: "JR-MVP-TENCENT-001",
          title: "后端工程师 · WXG · 高级",
          max_salary_limit: 80000,
        },
        latencyMs: 47,
        timestamp: "2026-05-12T14:31:01+08:00",
      },
      {
        requestUrl: "http://localhost:3500/api/v1/ontology/instances/Resume?domain=RAAS-v1&candidate_id=C-MVP-002",
        requestMethod: "GET",
        requestHeaders: { Authorization: "Bearer ***", Accept: "application/json" },
        responseStatus: 200,
        responseBody: { items: [{ resume_id: "R-MVP-002", candidate_id: "C-MVP-002" }] },
        latencyMs: 62,
        timestamp: "2026-05-12T14:31:01+08:00",
      },
    ],
    llmRaw: {
      model: "kimi-k2.6",
      response: { id: "chatcmpl-abc", choices: [{ message: { content: "..." } }] },
      inputTokens: 14_823,
      outputTokens: 1_241,
      latencyMs: 4_872,
    },
    llmParsed: {
      ruleId: "10-7",
      decision: "passed",
      evidence: [
        {
          sourceType: "neo4j_instance",
          objectType: "Resume",
          objectId: "R-MVP-002",
          field: "expected_salary_range",
          value: "50000-70000",
          fetchedInstanceIndex: 1,
          decisive: true,
          grounded: true,
        },
        {
          sourceType: "neo4j_instance",
          objectType: "Job_Requisition",
          objectId: "JR-MVP-TENCENT-001",
          field: "max_salary_limit",
          value: 80000,
          fetchedInstanceIndex: 0,
          decisive: true,
          grounded: true,
        },
      ],
      rootCause:
        "【数据观察】Resume.expected_salary_range='50000-70000',Job.max_salary_limit=80000。【对照推理】期望上限 70000 ≤ 岗位上限 80000,且字段非空。【结论】因此判定 passed;不是 blocked 因为数据明确未触犯;不是 pending_human 因为薪资字段齐全无需人工。",
      rootCauseSections: {
        dataObservation:
          "Resume/R-MVP-002.expected_salary_range = '50000-70000';Job_Requisition/JR-MVP-TENCENT-001.max_salary_limit = 80000。",
        contrastReasoning:
          "候选人期望上限 70000 ≤ 岗位上限 80000,且 expected_salary_range 字段非空,通过规则要求。",
        conclusion:
          "判定 passed。不是 blocked,因为数据明确未触犯;不是 pending_human,因为薪资字段已填写;不是 not_started,因为前置条件满足。",
      },
      confidence: 0.91,
      nextAction: "continue_to_scoring",
      counterfactuals: [
        {
          hypotheticalChange: "如果 expected_salary_range 改为 '90000-100000'",
          predictedDecision: "blocked",
          confidence: 0.85,
        },
      ],
    },
    validation: {
      ruleIdExists: true,
      evidenceGrounded: true,
      schemaValid: true,
      blockSemanticCheck: "ok",
      overallOk: true,
      failures: [],
    },
    confidenceBreakdown: {
      evidenceCountFactor: 0.67,
      consistencyFactor: 1,
      logprobScore: 0.84,
      source: "composite_full",
    },
    finalDecision: { decision: "passed" },
  },

  // ── run-002: BLOCKED ─────────────────────────────────────────────
  {
    runId: "01HXC3M9R7N8K4PQZ5VYDFG2T2",
    batchId: "01HXC3M9R7N8K4PQZ5VYDFG2T0",
    timestamp: "2026-05-12T14:31:12+08:00",
    input: {
      actionRef: "matchResume",
      ruleId: "10-17",
      candidateId: "C-MVP-003",
      jobRef: "JR-MVP-TENCENT-001",
      scope: { client: "腾讯", department: "WXG" },
      domain: "RAAS-v1",
    },
    fetched: {
      rule: {
        id: "10-17",
        name: "高风险回流人员",
        sourceText:
          "曾在 中软国际 任职且离职编码为 A15 的候选人为高风险回流,禁止再次推荐。",
        stepOrder: 4,
        applicableScope: "腾讯",
      },
      instances: [
        {
          objectType: "Resume",
          objectId: "R-MVP-003",
          data: {
            candidate_id: "C-MVP-003",
            resume_id: "R-MVP-003",
            work_experience: [
              { company: "中软国际", departure_code: "A15", end_date: "2024-08-30" },
              { company: "其它", departure_code: "A1" },
            ],
          },
        },
      ],
    },
    prompt: PROMPT_SAMPLE,
    promptProvenance: {
      promptSha256:
        "f3a1c9d7b2e8a04c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c",
      actionObjectSha256:
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
      generatePromptInput: {
        actionRef: "matchResume",
        client: "腾讯",
        clientDepartment: "WXG",
        domain: "RAAS-v1",
        runtimeInputDigest: "e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6",
      },
      resolvedAt: "2026-05-12T14:31:10+08:00",
    },
    ontologyApiTrace: [
      {
        requestUrl: "http://localhost:3500/api/v1/ontology/instances/Resume?domain=RAAS-v1&candidate_id=C-MVP-003",
        requestMethod: "GET",
        requestHeaders: { Authorization: "Bearer ***", Accept: "application/json" },
        responseStatus: 200,
        responseBody: { items: [{ resume_id: "R-MVP-003" }] },
        latencyMs: 41,
        timestamp: "2026-05-12T14:31:11+08:00",
      },
    ],
    llmRaw: {
      model: "kimi-k2.6",
      response: {},
      inputTokens: 14_823,
      outputTokens: 1_241,
      latencyMs: 4_872,
    },
    llmParsed: {
      ruleId: "10-17",
      decision: "blocked",
      evidence: [
        {
          sourceType: "neo4j_instance",
          objectType: "Resume",
          objectId: "R-MVP-003",
          field: "work_experience[0].company",
          value: "中软国际",
          fetchedInstanceIndex: 0,
          decisive: true,
          grounded: true,
        },
        {
          sourceType: "neo4j_instance",
          objectType: "Resume",
          objectId: "R-MVP-003",
          field: "work_experience[0].departure_code",
          value: "A15",
          fetchedInstanceIndex: 0,
          decisive: true,
          grounded: true,
        },
      ],
      rootCause:
        "【数据观察】Resume/R-MVP-003 中 work_experience[0].company='中软国际',departure_code='A15'。【对照推理】候选人精确满足『中软国际 + A15』组合,触发高风险回流规则。【结论】判定 blocked;不是 pending_human 因为数据齐全无歧义;不是 passed 因为明确触犯。",
      rootCauseSections: {
        dataObservation:
          "Resume/R-MVP-003.work_experience[0].company = '中软国际';Resume/R-MVP-003.work_experience[0].departure_code = 'A15'。",
        contrastReasoning:
          "两个字段同时匹配规则关键词,触发『高风险回流人员』分类。无矛盾证据。",
        conclusion:
          "判定 blocked。不是 pending_human,因为数据完整;不是 passed,因为明确触犯;不是 not_started,因为有匹配记录。",
      },
      confidence: 0.96,
      nextAction: "stop_recommendation",
    },
    validation: {
      ruleIdExists: true,
      evidenceGrounded: true,
      schemaValid: true,
      blockSemanticCheck: "ok",
      overallOk: true,
      failures: [],
    },
    confidenceBreakdown: {
      evidenceCountFactor: 0.67,
      consistencyFactor: 1,
      logprobScore: 0.93,
      source: "composite_full",
    },
    finalDecision: { decision: "blocked" },
  },

  // ── run-003: PENDING_HUMAN (forced by validation failure) ─────────
  {
    runId: "01HXC3M9R7N8K4PQZ5VYDFG2T3",
    batchId: "01HXC3M9R7N8K4PQZ5VYDFG2T0",
    timestamp: "2026-05-12T14:31:16+08:00",
    input: {
      actionRef: "matchResume",
      ruleId: "10-25",
      candidateId: "C-MVP-007",
      jobRef: "JR-MVP-TENCENT-001",
      scope: { client: "腾讯", department: "WXG" },
      domain: "RAAS-v1",
    },
    fetched: {
      rule: {
        id: "10-25",
        name: "华为荣耀竞对",
        sourceText:
          "若候选人最近一段工作在华为/荣耀且 end_date 距当前不足 3 个月,需 HSM 评估。",
        stepOrder: 4,
        applicableScope: "腾讯",
      },
      instances: [
        {
          objectType: "Resume",
          objectId: "R-MVP-007",
          data: {
            candidate_id: "C-MVP-007",
            resume_id: "R-MVP-007",
            work_experience: [
              { company: "华为", end_date: "2026-04-10" },
            ],
          },
        },
      ],
    },
    prompt: PROMPT_SAMPLE,
    promptProvenance: {
      promptSha256:
        "f3a1c9d7b2e8a04c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c",
      actionObjectSha256:
        "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
      generatePromptInput: {
        actionRef: "matchResume",
        client: "腾讯",
        clientDepartment: "WXG",
        domain: "RAAS-v1",
        runtimeInputDigest: "b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3",
      },
      resolvedAt: "2026-05-12T14:31:14+08:00",
    },
    ontologyApiTrace: [
      {
        requestUrl: "http://localhost:3500/api/v1/ontology/instances/Resume?domain=RAAS-v1&candidate_id=C-MVP-007",
        requestMethod: "GET",
        requestHeaders: { Authorization: "Bearer ***", Accept: "application/json" },
        responseStatus: 200,
        responseBody: { items: [{ resume_id: "R-MVP-007" }] },
        latencyMs: 39,
        timestamp: "2026-05-12T14:31:15+08:00",
      },
    ],
    llmRaw: {
      model: "kimi-k2.6",
      response: {},
      inputTokens: 14_823,
      outputTokens: 1_241,
      latencyMs: 4_872,
    },
    llmParsed: {
      ruleId: "10-25",
      decision: "blocked",  // LLM said blocked, but validation failed
      evidence: [
        {
          sourceType: "neo4j_instance",
          objectType: "Application",
          objectId: "APP-FAKE-001",  // hallucinated — not in fetched.instances
          field: "status",
          value: "fake",
          fetchedInstanceIndex: 99,
          decisive: true,
          grounded: false,  // set by validation
        },
      ],
      rootCause:
        "【数据观察】…(LLM cited an Application record that wasn't fetched)…【对照推理】…【结论】blocked",
      rootCauseSections: {
        dataObservation: "(LLM 引用了未提取的 Application/APP-FAKE-001)",
        contrastReasoning: "(略)",
        conclusion: "(LLM 输出 blocked,但 evidence 未落地,系统强制 pending_human)",
      },
      confidence: 0.41,
      nextAction: "hold_for_manual_review",
    },
    validation: {
      ruleIdExists: true,
      evidenceGrounded: false,  // ← caught hallucination
      schemaValid: true,
      blockSemanticCheck: "skipped",
      overallOk: false,
      failures: [
        "evidence[0]_unknown_instance:Application/APP-FAKE-001",
      ],
    },
    confidenceBreakdown: {
      evidenceCountFactor: 0.33,
      consistencyFactor: 1,
      logprobScore: null,
      source: "composite_degraded",
    },
    finalDecision: {
      decision: "pending_human",
      overrideReason:
        "validation_failed: evidence[0]_unknown_instance:Application/APP-FAKE-001",
    },
  },
];
