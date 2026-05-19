/**
 * v4-4 prompt assembly — Chinese fill-in template with original rule prose.
 *
 * Unlike v4-1/v4-2, this assembler does not consume LLM-generated rule
 * instructions. Rules are rendered as source prose blocks, so the execution
 * agent applies the original policy text directly.
 *
 * Maintenance note: this file was historically treated as immutable. The
 * `## 当前时间` section (rendered with a `{{CURRENT_TIME}}` placeholder, to
 * be substituted at fill time by `fillRuntimeInput`) is the one documented
 * deviation — it's a purely additive section between `## 任务` and `## 运行时
 * 输入` and does not change any pre-existing rendering logic.
 */

import { applyClientFilter } from "../compile/filter";
import type { Action, ActionRule, ActionStep } from "../types.public";

import {
  renderEnvelopeSkeleton,
  renderSingleStepEnvelopeSkeleton,
} from "./envelope-schema";
import type {
  ActionObjectMetaV4,
  ActionObjectV4,
  EnrichedAction,
} from "./types";

/**
 * Public shape for the optional per-rule "extra instances" passed in by
 * `rule-check`'s orchestrator (Phase 3 prefetch result). When provided, an
 * extra `## 额外数据` section is rendered between `## 运行时输入` and
 * `## 最终输出 JSON 结构` so the LLM sees the prefetched Ontology instances
 * with stable `fetchedInstanceIndex` numbering.
 *
 * fetchedInstanceIndex convention (locked):
 *   - position 0 = Job (already in 运行时输入)
 *   - position 1 = Resume (already in 运行时输入)
 *   - positions 2..N = entries of `extraInstances` in the order passed in
 *
 * The orchestrator is responsible for ordering `extraInstances` consistently
 * so the indices reproduce across calls.
 */
export interface ExtraInstance {
  objectType: string;
  objectId: string;
  data: Record<string, unknown>;
}

const RUNTIME_INPUT_PLACEHOLDER = "{{RUNTIME_INPUT}}";
const CURRENT_TIME_PLACEHOLDER = "{{CURRENT_TIME}}";
const MATCH_RESUME_RUNTIME_INPUT_EXAMPLE = `### client

client_name: 腾讯
department: 互动娱乐事业群

### 招聘岗位 (Job_Requisition)

\`\`\`json
{
  "job_requisition_id": "JR-2026-001",
  "title": "高级后端工程师",
  "client": "腾讯",
  "department": "互动娱乐事业群",
  "required_skills": ["Java", "Spring Boot", "MySQL"],
  "preferred_skills": ["Kafka", "Redis"],
  "min_years_experience": 5,
  "education": "本科及以上",
  "age_max": 40,
  "language_requirement": null,
  "gender_requirement": null
}
\`\`\`

### 候选人简历 (Resume)

\`\`\`json
{
  "candidate_id": "C-12345",
  "name": "Alice",
  "date_of_birth": "1990-03-15",
  "gender": "女",
  "highest_education": {
    "school": "复旦大学",
    "degree": "本科",
    "major": "计算机科学与技术",
    "graduation_year": 2012,
    "is_full_time": true
  },
  "work_experience": [
    {
      "company": "字节跳动",
      "title": "后端工程师",
      "start_date": "2022-01",
      "end_date": "2025-12",
      "responsibilities": "负责广告投放系统服务端开发，主导亿级 QPS 接口的性能优化。"
    },
    {
      "company": "华为",
      "title": "软件工程师",
      "start_date": "2014-07",
      "end_date": "2021-12",
      "responsibilities": "终端业务后端开发与维护。"
    }
  ],
  "skill_tags": ["Java", "Spring Boot", "MySQL", "Redis", "Kafka"],
  "language_certifications": [],
  "conflict_of_interest_declaration": "无亲属在腾讯任职。"
}
\`\`\``;

export interface AssembleV4_4Input {
  enriched: EnrichedAction;
  client?: string;
  domain?: string;
  runtimeInput?: string | Record<string, unknown>;
  /**
   * Optional prefetched instances rendered into `## 额外数据 (按 rule 依赖预取)`.
   * When non-empty, the section is slotted between `## 运行时输入` and
   * `## 最终输出 JSON 结构`. fetchedInstanceIndex begins at 2 (Job=0, Resume=1).
   */
  extraInstances?: ExtraInstance[];
  /**
   * Path C: when set, the assembler renders a slim per-step prompt — only the
   * focus step's rules + a per-step `{ rule_judgments: [...] }` skeleton, no
   * `## 最终输出汇总` block. When omitted, the existing full-prompt behavior
   * is preserved verbatim (used by `/dev/generate-prompt` and Path B fallback).
   */
  focusStep?: number;
}

export function assembleActionObjectV4_4(input: AssembleV4_4Input): ActionObjectV4 {
  const action = input.client
    ? applyClientFilter(input.enriched.action, { client: input.client })
    : input.enriched.action;

  const focusStep = input.focusStep;
  const stepsSorted = [...action.actionSteps].sort((a, b) => a.order - b.order);
  const stepsToRender = focusStep === undefined
    ? stepsSorted
    : stepsSorted.filter((s) => s.order === focusStep);
  const focusStepObj = focusStep === undefined ? undefined : stepsToRender[0];

  const sections = [
    renderRole(action),
    renderConstraints(focusStepObj),
    renderTask(action, focusStepObj),
    renderCurrentTime(),
    renderRuntimeInput(action, input.runtimeInput),
    ...(input.extraInstances && input.extraInstances.length > 0
      ? [renderExtraInstances(input.extraInstances)]
      : []),
    renderFinalOutputSchema(action, focusStepObj),
    renderProcedureOverview(action, focusStepObj),
    ...stepsToRender.map((step) => renderStep(step)),
    ...(focusStep === undefined ? [renderFinalConsolidation(action)] : []),
    renderBeforeReturn(focusStepObj),
  ];

  const meta: ActionObjectMetaV4 = {
    actionId: action.id,
    actionName: action.name,
    domain: input.domain ?? "RAAS-v1",
    client: input.client,
    compiledAt: new Date().toISOString(),
    templateVersion: "v4",
    promptStrategy: "v4-4",
    validation: {
      driftDetected: false,
      roundTripFailures: [],
      missingInstructions: [],
    },
  };

  return {
    prompt: sections.join("\n\n"),
    meta,
  };
}

function renderRole(action: Action): string {
  return [
    "## 角色",
    "",
    `你是 \`${action.name}\` action 的执行智能体。你会收到运行时输入，并根据本模板中的步骤、输出结构和规则内容，产出一个结构化 JSON 结果。`,
  ].join("\n");
}

function renderConstraints(focusStep?: ActionStep): string {
  const iterationConstraint = focusStep
    ? `- 本次评估**仅聚焦 Step ${focusStep.order}**；按 rule 在 prompt 中出现的顺序为本步骤的**每一条** rule 产出一个 RuleJudgment 对象，写入 \`rule_judgments[]\`。**不允许省略任何 rule**。`
    : "- 按 step.order 顺序遍历每个 step；在每个 step 内，按 rule 在 prompt 中出现的顺序为**每一条** rule 产出一个 RuleJudgment 对象，写入 `step_results.step_<step.order>.rule_judgments[]`。**不允许省略任何 rule**。";
  return [
    "## 重要约束",
    "",
    "- 你只能依据本模板中引用的 action、step 和 rule 原文进行判断；不得依赖你的先验知识。",
    "- 规则部分是原文引用，不是改写后的解释；不得补充、扩展或替换规则中的判断条件。",
    "- 评估每条 rule 时只能使用其“适用条件”和“规则”中的内容，以及“运行时输入”/“额外数据”中提供的 instance 数据。",
    iterationConstraint,
    "- decision 只能取四个值之一：`not_started` | `passed` | `blocked` | `pending_human`。",
    "- `passed` —— 数据明确显示未触犯 rule；`blocked` —— 数据明确显示触犯 rule；`pending_human` —— 数据不足/边界模糊/需人工复核；`not_started` —— rule 的“适用条件”未满足，本次不进入判定。",
    "- 每条 evidence 必须能在“运行时输入”或“额外数据”section 中精确定位到 (objectType, objectId, field, value)。**不允许编造**。evidence.value 必须与原数据 byte-equal（不重新格式化、不截断、不意译、不把数字字符串转数字）。",
    "- 每条 evidence 必须填写 `fetchedInstanceIndex` —— 该 evidence 引用的 instance 在“运行时输入 + 额外数据”整体序列中的下标 (0 = Job, 1 = Resume, 2..N = 额外数据 section 内按出现顺序)。`decisive: true` 表示该 evidence 是判定的决定性依据；`decisive: false` 仅作上下文说明。",
    "- `rootCause` 必须使用**中文**，按三段结构组织 —— 【数据观察】+【对照推理】+【结论】 —— 并与 `rootCauseSections` 同源。`rootCauseSections.dataObservation / contrastReasoning / conclusion` 是同一内容的结构化拆分。",
    "- 如果数据不足以判定 → `decision = \"pending_human\"`，并在 `rootCauseSections` 显式说明缺失字段。",
    "- 如果 rule 的“适用条件”未满足（例如：rule 仅对“曾在某公司任职”的候选人适用，但 resume 中无该记录） → `decision = \"not_started\"`。",
    ...(focusStep
      ? []
      : [
          "- 评估完所有 rule 后，由 rule_judgments 聚合 `final_output`：`aggregateDecision` 按优先级取值 —— 任一 blocked → `blocked`；否则任一 pending_human → `pending_human`；否则任一 passed → `passed`；全部 not_started → `not_started`。",
          "- `final_output.triggeredRules[]` = 所有 decision 为 `blocked` 或 `pending_human` 的 ruleId。",
          "- 如果 rule sourceText 要求“终止/不予录用/停止后续流程”等阻断动作并被判定为 `blocked` → `final_output.terminal = true`；否则 `false`。",
          "- 如果 rule sourceText 要求通知/待办/提醒/HSM 转介/人工处理 → 把通知对象加入 `final_output.notifications`，`trigger_rule_id` 必须填该 rule 的 id。",
        ]),
    "- 你不直接读写数据存储；运行时系统会根据你的 JSON 输出执行写入、通知和流程流转。",
  ].join("\n");
}

function renderTask(action: Action, focusStep?: ActionStep): string {
  const taskDirective = focusStep
    ? `当前需要执行的 action 是 \`${action.name}\`，**本次仅聚焦 Step ${focusStep.order} (${focusStep.name})**。你需要读取“运行时输入”中的业务对象，结合 Action 描述，严格按照“本步骤规则”中的 rules 出现顺序逐条判断，并将本步骤的每条 rule 判断结果汇总为 JSON。`
    : `当前需要执行的 action 是 \`${action.name}\`。你需要读取“运行时输入”中的业务对象，结合 Action 描述，严格按照“执行步骤总览”中的 actionSteps 顺序执行；在每个 Step 内，严格按照“本步骤规则”中的 rules 出现顺序逐条判断，并将判断过程与业务结果汇总为最终 JSON。`;
  return [
    "## 任务",
    "",
    taskDirective,
    "",
    "Action 描述：",
    action.description || "(无描述)",
  ].join("\n");
}

function renderCurrentTime(): string {
  return [
    "## 当前时间",
    "",
    CURRENT_TIME_PLACEHOLDER,
  ].join("\n");
}

function renderRuntimeInput(
  action: Action,
  runtimeInput: string | Record<string, unknown> | undefined,
): string {
  let body: string;
  if (runtimeInput === undefined) {
    body = isMatchResumeAction(action) ? MATCH_RESUME_RUNTIME_INPUT_EXAMPLE : RUNTIME_INPUT_PLACEHOLDER;
  } else if (typeof runtimeInput === "string") {
    body = runtimeInput;
  } else {
    body = "```json\n" + JSON.stringify(runtimeInput, null, 2) + "\n```";
  }

  return [
    "## 运行时输入",
    "",
    body,
  ].join("\n");
}

function renderFinalOutputSchema(action: Action, focusStep?: ActionStep): string {
  if (focusStep) {
    return [
      "## 最终输出 JSON 结构",
      "",
      "返回一个 JSON object，仅包含一个顶层字段：`rule_judgments`。",
      "",
      "- `rule_judgments[]` —— 本 step 下的每条 rule 都对应一个 RuleJudgment 对象。",
      "- 不要输出 `step_results` 包装层，也不要输出 `final_output`（由编排器在所有 step 完成后 deterministic 推导）。",
      "",
      "JSON 骨架：",
      "",
      "```json",
      renderSingleStepEnvelopeSkeleton(focusStep),
      "```",
    ].join("\n");
  }
  return [
    "## 最终输出 JSON 结构",
    "",
    "返回一个 JSON object，包含两个顶层字段：`step_results` 和 `final_output`。",
    "",
    "- `step_results.<step_N>.rule_judgments[]` —— 每个 step 下的 rule 都对应一个 RuleJudgment 对象。step 键名为 `step_<step.order>` (e.g. `step_1`, `step_2`)。",
    "- `final_output` —— action 级聚合结果（aggregateDecision / terminal / triggeredRules / notifications），由 rule_judgments 推导得到。",
    "",
    "JSON 骨架：",
    "",
    "```json",
    renderEnvelopeSkeleton(action),
    "```",
  ].join("\n");
}

function renderProcedureOverview(action: Action, focusStep?: ActionStep): string {
  if (focusStep) {
    return [
      "## 执行步骤总览",
      "",
      `本次仅评估 Step ${focusStep.order}（action 中其它步骤本次不在范围）。`,
      "",
      `Step ${focusStep.order}: ${focusStep.name} — ${oneLine(focusStep.description)}`,
    ].join("\n");
  }
  const lines = [
    "## 执行步骤总览",
    "",
    `按顺序执行以下 ${action.actionSteps.length} 个步骤。每个步骤都维护自己的中间结果对象，最后汇总到最终 JSON。`,
    "",
  ];

  for (const step of [...action.actionSteps].sort((a, b) => a.order - b.order)) {
    lines.push(`Step ${step.order}: ${step.name} — ${oneLine(step.description)}`);
  }

  return lines.join("\n");
}

function renderStep(step: ActionStep): string {
  return [
    `## Step ${step.order}: ${step.name} [${step.objectType || "logic"}]`,
    "",
    "### 本步骤规则",
    "",
    renderRules(step),
  ].join("\n");
}

function renderRules(step: ActionStep): string {
  if (step.rules.length === 0) {
    return "本步骤没有业务规则，按步骤描述执行。";
  }

  return step.rules.map((rule, index) => renderRule(rule, index + 1)).join("\n\n");
}

function renderRule(rule: ActionRule, ruleOrder: number): string {
  const standardized = getRuleStandardizedText(rule);
  const description = rule.description || "";
  const shouldRenderDescription =
    !isBlank(description) && normalizeForCompare(description) !== normalizeForCompare(standardized);

  const lines = [
    `#### ${ruleOrder}. [规则 ${rule.id}] ${rule.businessLogicRuleName || "(未命名规则)"}`,
    "",
    "适用条件:",
    plainText(rule.submissionCriteria, "(无适用条件)"),
    "",
    "规则:",
    plainText(standardized, "(无规则)"),
  ];

  if (shouldRenderDescription) {
    lines.push("", "补充描述:", plainText(description, "(无补充描述)"));
  }

  return lines.join("\n");
}

function renderFinalConsolidation(_action: Action): string {
  return [
    "## 最终输出汇总",
    "",
    "所有 rule_judgments 完成后，按以下规则推导 `final_output`：",
    "",
    "- `aggregateDecision`：按优先级取值 —— 任一 rule_judgment.decision 为 `blocked` → `blocked`；否则任一为 `pending_human` → `pending_human`；否则任一为 `passed` → `passed`；全部为 `not_started` → `not_started`。",
    "- `triggeredRules`：所有 decision 为 `blocked` 或 `pending_human` 的 ruleId，去重后按 step.order + rule 出现顺序排列。",
    "- `terminal`：当 `aggregateDecision === \"blocked\"` 且对应的 blocked rule 在 sourceText 中明确要求“终止/不予录用/停止后续流程”等阻断动作时为 `true`；否则为 `false`。",
    "- `notifications`：扫描所有 rule_judgments，对 sourceText 要求“通知/待办/提醒/HSM 转介/人工处理”的 rule，输出对应通知对象（`trigger_rule_id` 填该 rule.id）。",
  ].join("\n");
}

function renderBeforeReturn(focusStep?: ActionStep): string {
  if (focusStep) {
    return [
      "## 返回前检查",
      "",
      "返回最终 JSON 前，逐项确认：",
      `1. 输出仅是 \`{ "rule_judgments": [...] }\` 单层结构；不要包 \`step_results\` 也不要输出 \`final_output\`。`,
      `2. \`rule_judgments[]\` 涵盖本 Step (${focusStep.order}) 的**每一条** rule，按 prompt 中出现顺序排列。`,
      "3. 每条 rule_judgment 的 evidence 都可在“运行时输入”或“额外数据”中精确定位到对应 (objectType, objectId, field, value)，且 `fetchedInstanceIndex` 正确。",
      "4. 每条 `rootCauseSections` 都包含完整三段（dataObservation / contrastReasoning / conclusion），且与 `rootCause` 同源。",
    ].join("\n");
  }
  return [
    "## 返回前检查",
    "",
    "返回最终 JSON 前，逐项确认：",
    "1. 输出符合“最终输出 JSON 结构”，字段名不要随意改写；`step_results.<step_N>.rule_judgments[]` 涵盖每个 step 的**每一条** rule。",
    "2. 每条 rule_judgment 的 evidence 都可在“运行时输入”或“额外数据”中精确定位到对应 (objectType, objectId, field, value)，且 `fetchedInstanceIndex` 正确。",
    "3. 每条 `rootCauseSections` 都包含完整三段（dataObservation / contrastReasoning / conclusion），且与 `rootCause` 同源。",
    "4. `final_output.aggregateDecision` 与按优先级（blocked > pending_human > passed > not_started）从 rule_judgments 推导出的值一致。",
    "5. `final_output.triggeredRules` 覆盖所有 `blocked` 与 `pending_human` 的 ruleId；`terminal` 与阻断 rule 的 sourceText 意图一致；每条 `notifications` 的 `trigger_rule_id` 都能在 rule_judgments 中找到对应 rule。",
  ].join("\n");
}

function renderExtraInstances(extras: ExtraInstance[]): string {
  const lines = [
    "## 额外数据 (按 rule 依赖预取)",
    "",
    "下方列出本次评估按规则数据依赖额外预取的 Ontology instance，按 `fetchedInstanceIndex` 从 2 开始编号（0 = Job, 1 = Resume，已在“运行时输入”中给出）。evidence 引用这些 instance 时，请使用对应的 `fetchedInstanceIndex` 值。",
    "",
  ];

  extras.forEach((inst, i) => {
    const idx = i + 2; // 0 = Job, 1 = Resume
    lines.push(
      `### fetchedInstanceIndex=${idx} — ${inst.objectType}/${inst.objectId}`,
      "",
      "```json",
      JSON.stringify(inst.data, null, 2),
      "```",
      "",
    );
  });

  // Trim trailing blank line for clean join.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

function getRuleStandardizedText(rule: ActionRule): string {
  return rule.standardizedLogicRule || rule.description || "";
}

function plainText(text: string | undefined, fallback: string): string {
  const normalized = text?.trim();
  return normalized && normalized.length > 0 ? normalized : fallback;
}

function isMatchResumeAction(action: Action): boolean {
  return action.id === "10" || action.name === "matchResume";
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim() || "(无描述)";
}

function isBlank(text: string | undefined): boolean {
  return !text || text.trim().length === 0;
}

function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
