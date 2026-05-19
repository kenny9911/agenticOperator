/**
 * MVP prompt strategy: extract single rule's source text + execution wrapper,
 * fenced with the fetched instances and required output schema.
 *
 * Renders per SPEC §7.2 — focused, low-token, schema-strict. The LLM sees
 * exactly the one rule it must judge, the relevant runtime data, the current
 * time, and the strict JSON output schema.
 */

import type { PromptBuildInput, PromptBuildOutput, PromptStrategy } from "./index";

const SYSTEM_PROMPT = `你是一名 Rule Evaluation Agent。基于给定的 rule 原文 + candidate 的真实数据，判定该 candidate 在该客户的招聘场景下，针对该 rule，应当采取的处置动作。

# 输出约束

- 你只能使用 prompt 中提供的 rule 原文 + instance 数据。不允许凭知识脑补、不允许引用未提供的数据。
- 不允许编造 evidence —— 每一条 evidence 必须能在提供的 instance 数据中精确定位到 (objectType, objectId, field, value)。
- evidence.value 必须与 instance 数据中的字段值 byte-equal（不要重新格式化、不要截断、不要意译、不要把数字字符串转成数字）。
- 严格按指定 JSON schema 输出（响应会被强校验；不要包含 schema 之外的字段）。
- 所有文字输出（rootCause、nextAction）必须使用**中文**。

# decision 取值与语义（只能取这四个）

- "not_started"   —— 该 rule 在本次场景中不适用 / 前置条件未满足 / 不需要触发判定（例：rule 要求 "若曾在华为任职", 但候选人 work_experience 全无华为记录，则该 rule 不进入判定）。
- "passed"        —— 数据明确显示候选人未触犯该 rule，可继续后续推荐流程。
- "blocked"       —— 数据明确显示候选人触犯该 rule，必须拦截，不得推荐。
- "pending_human" —— 数据不足以自动判定 / 存在风险 / 判定边界模糊，需要人工复核（例：缺少必需字段、需要 HSM 评估、需要主观判断）。

# rootCause（这是最重要的字段，必须自包含、可独立审计）

rootCause 是给"未看过 rule 也未看过数据"的审计人员看的证明性文字。一段合格的 rootCause 必须**完整覆盖以下四点**，按下列结构组织：

1. **【规则要求】** 用一句话复述 rule 原文中具体的判定条件（如 "rule 10-7 要求候选人 expected_salary_range 上限不得超过该岗位 max_salary_limit"）。
2. **【数据观察】** 列出从 instance 数据中读到的关键事实，逐条带上来源 (objectType.field = 实际值)（如 "Candidate_Expectation/CE-MVP-002.expected_salary_range = '50000-70000'，Job_Requisition/JR-MVP-TENCENT-001.max_salary_limit = 80000"）。
3. **【对照推理】** 显式做匹配：规则要求 vs 实际数据，给出逻辑链（如 "候选人期望上限 70000 ≤ 岗位上限 80000，未触犯薪资约束"）。如有时间相关条件，必须代入当前时间显式计算（如 "end_date=2026-04-01，距当前时间 2026-05-12 约 41 天 < 3 个月，落入冷冻期"）。
4. **【结论】** 显式声明 decision，并说明为什么是这个值而不是其他三个（如 "因此判定 passed；不是 blocked 因为数据不触犯；不是 pending_human 因为数据完整无需人工；不是 not_started 因为薪资字段已填写，rule 已进入判定"）。

rootCause 不允许只写 "符合规则" / "不符合规则" / "数据不足" 这种无证明的判语。必须能让审计人员仅凭这一段文字 + 引用的 evidence 重现整个判定过程。

# evidence.field 路径语法（JSONPath-lite，校验器按此解析）

- 顶层字段:        "max_salary_limit"             → instance.data.max_salary_limit
- 数组元素的字段:  "work_experience[0].company"   → instance.data.work_experience[0].company
- 等价点号写法:    "work_experience.0.company"    （与方括号形式等价）
- 嵌套对象的字段:  "highest_education.school"
- 必须把 evidence.value 设为该路径解析出的**叶子值**（标量或最小完整子对象），不要拼整段 JSON 字符串。

# nextAction

简短描述下一步推荐流程动作，例：
- "continue_to_scoring"        passed 时
- "stop_recommendation"        blocked 时
- "hold_for_manual_review"     pending_human 时
- "skip_this_rule"             not_started 时`;

function buildExtractedPrompt(input: PromptBuildInput): PromptBuildOutput {
  const scopeLine = input.scope.department
    ? `${input.scope.client} / ${input.scope.department}`
    : input.scope.client;

  const sections: string[] = [];

  sections.push(`## Action\n${input.actionRef}`);
  sections.push(`## 当前时间 (Asia/Shanghai)\n${input.currentTime}`);
  sections.push(`## Client\n${scopeLine}`);
  sections.push(
    [
      `## 待判定 Rule`,
      `[${input.rule.id}] ${input.rule.name}`,
      `适用范围: ${input.rule.applicableScope}`,
      `Step 顺序: ${input.rule.stepOrder}`,
      ``,
      `规则原文:`,
      input.rule.sourceText,
    ].join("\n"),
  );

  // Candidate is always present per MVP.
  sections.push(
    [
      `## Candidate (instance from Neo4j)`,
      `objectId: ${input.candidate.objectId}`,
      "```json",
      JSON.stringify(input.candidate.data, null, 2),
      "```",
    ].join("\n"),
  );

  if (input.resumes && input.resumes.length > 0) {
    sections.push(
      [
        `## Resume(s) (${input.resumes.length} record(s) for this candidate)`,
        ...input.resumes.map((inst) =>
          [
            `### ${inst.objectType}/${inst.objectId}`,
            "```json",
            JSON.stringify(inst.data, null, 2),
            "```",
          ].join("\n"),
        ),
      ].join("\n\n"),
    );
  } else if (input.resumes) {
    sections.push(`## Resume\n(no Resume record found for this candidate)`);
  }

  if (input.expectations && input.expectations.length > 0) {
    sections.push(
      [
        `## Candidate_Expectation (${input.expectations.length} record(s) — 求职期望，含 expected_salary_range 等)`,
        ...input.expectations.map((inst) =>
          [
            `### ${inst.objectType}/${inst.objectId}`,
            "```json",
            JSON.stringify(inst.data, null, 2),
            "```",
          ].join("\n"),
        ),
      ].join("\n\n"),
    );
  } else if (input.expectations) {
    sections.push(
      `## Candidate_Expectation\n(no Candidate_Expectation record found — the candidate has not declared salary / location / industry preferences yet)`,
    );
  }

  if (input.job) {
    sections.push(
      [
        `## Job (Job_Requisition instance)`,
        `objectId: ${input.job.objectId}`,
        "```json",
        JSON.stringify(input.job.data, null, 2),
        "```",
      ].join("\n"),
    );
  }

  if (input.applications && input.applications.length > 0) {
    sections.push(
      [
        `## Application history (${input.applications.length} records, filtered per rule)`,
        ...input.applications.map((inst) =>
          [
            `### ${inst.objectType}/${inst.objectId}`,
            "```json",
            JSON.stringify(inst.data, null, 2),
            "```",
          ].join("\n"),
        ),
      ].join("\n\n"),
    );
  } else if (input.applications) {
    // Empty array is meaningful — the LLM should know no records matched the filter.
    sections.push(`## Application history\n(no matching Application records in the lookback window)`);
  }

  if (input.blacklist && input.blacklist.length > 0) {
    sections.push(
      [
        `## Blacklist (${input.blacklist.length} records, filtered per rule)`,
        ...input.blacklist.map((inst) =>
          [
            `### ${inst.objectType}/${inst.objectId}`,
            "```json",
            JSON.stringify(inst.data, null, 2),
            "```",
          ].join("\n"),
        ),
      ].join("\n\n"),
    );
  }

  sections.push(
    [
      `## 输出格式约束`,
      `- 单一 JSON 对象，按上层指定的 response_format json_schema 严格输出。`,
      `- evidence[] 的每一项必须能在上面的 instance JSON 中找到 (objectType, objectId, field, value) 的精确对应。`,
      `- decision 必须只取 "not_started" | "passed" | "blocked" | "pending_human" 之一（注意 system prompt 中的语义说明）。`,
      `- rootCause 必须使用**中文**，并按 system prompt 中"四段结构"组织：【规则要求】+【数据观察】+【对照推理】+【结论】。任何一段缺失都会被视为不合格输出。`,
      `- confidence ∈ [0, 1]，反映你对当前判定的把握度（数据齐全 + 推理直接 → 高；存在主观/边界 → 低）。`,
      `- nextAction 简短描述下一步动作，参见 system prompt 中的取值建议。`,
    ].join("\n"),
  );

  return {
    system: SYSTEM_PROMPT,
    user: sections.join("\n\n"),
  };
}

export const extractedRulePromptStrategy: PromptStrategy = {
  name: "extracted-rule",
  build: buildExtractedPrompt,
};
