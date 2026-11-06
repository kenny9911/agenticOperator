// Declarative metadata for each agent in the workflow.
//
// AGENT_MAP (lib/agent-mapping.ts) already captures the wiring (which events
// trigger an agent, which it emits). This file adds the natural-language
// understanding layer the AI summary endpoint and the Workflow inspector
// need: a one-line summary of the agent's job, a list of typical operations
// it performs, and the tools it reaches for.
//
// When this file disagrees with AGENT_MAP, AGENT_MAP wins for wiring (and
// the registry should be updated). The text fields below are descriptive
// only; they're injected into the LLM prompt to ground the model in real
// behavior, and rendered directly into the UI when the LLM is unavailable.

import type { AgentMeta } from "./agent-mapping";
import { AGENT_MAP, byShort } from "./agent-mapping";

export type AgentFunctionMeta = {
  short: string;
  /** One-line summary of what the agent does in business terms. */
  summary: string;
  /** Concrete operations the agent typically runs in a single invocation. */
  operations: string[];
  /** Tools / external systems / models the agent calls into. */
  tools: string[];
  /** Inputs (the trigger payload — what the agent reads from). */
  inputs: string[];
  /** Outputs (what the agent writes to / emits). */
  outputs: string[];
  /** Failure modes worth mentioning in summaries. */
  failureModes?: string[];
};

export const AGENT_FUNCTIONS: AgentFunctionMeta[] = [
  {
    short: "ReqSync",
    summary: "定时从客户 RMS 拉取最新职位需求并对齐内部知识库。",
    operations: [
      "调用客户 RMS API（HTTP / SDK）获取增量职位列表",
      "比对内部知识库的最新版本，判定新增 / 修改 / 下架",
      "写入 Job_Requisition 实体，触发 REQUIREMENT_SYNCED",
    ],
    tools: ["RMS API", "KnowledgeBase.upsert", "Inngest.send"],
    inputs: ["SCHEDULED_SYNC（定时器 / webhook）"],
    outputs: ["REQUIREMENT_SYNCED", "SYNC_FAILED_ALERT"],
    failureModes: ["RMS 5xx / timeout", "JSON schema 漂移"],
  },
  {
    short: "ManualEntry",
    summary: "HSM 在系统补录无法自动同步的需求；用于解除 CLARIFICATION_INCOMPLETE。",
    operations: [
      "渲染表单并预填已知字段",
      "校验必填项 / 字段格式",
      "提交后写入 Job_Requisition，发布 REQUIREMENT_LOGGED",
    ],
    tools: ["HSM 表单 UI", "Validator", "Inngest.send"],
    inputs: ["CLARIFICATION_INCOMPLETE"],
    outputs: ["REQUIREMENT_LOGGED"],
  },
  {
    short: "ReqAnalyzer",
    summary: "用 LLM 把原始需求解析为结构化分析（技能、薪资带、级别），评估完整性。",
    operations: [
      "提取关键字段（技能、年限、级别、薪资）",
      "推断完整度评分与缺失项",
      "若信息齐发 ANALYSIS_COMPLETED，否则 ANALYSIS_BLOCKED",
    ],
    tools: ["LLM.extract（gemini-3 / gpt-4o-mini）", "Schema validator"],
    inputs: ["REQUIREMENT_SYNCED", "REQUIREMENT_LOGGED"],
    outputs: ["ANALYSIS_COMPLETED", "ANALYSIS_BLOCKED"],
    failureModes: ["LLM 输出非 JSON", "字段冲突无法解析"],
  },
  {
    short: "Clarifier",
    summary: "针对缺失字段生成澄清问题，由 HSM 回填，闭环重试。",
    operations: [
      "根据缺失项编排澄清问题",
      "推送给 HSM Inbox 等待回填",
      "若已齐发 CLARIFICATION_READY，否则 CLARIFICATION_INCOMPLETE",
    ],
    tools: ["LLM.questions", "HSM Inbox"],
    inputs: ["ANALYSIS_COMPLETED"],
    outputs: ["CLARIFICATION_READY", "CLARIFICATION_INCOMPLETE"],
  },
  {
    short: "JDGenerator",
    summary: "用 LLM 把分析后的需求扩写成可发布的 JD（标题、描述、技能列表）。",
    operations: [
      "调用 LLM 生成结构化 JD payload",
      "渲染多渠道副本（标题 + hook）",
      "合规字段 lint（PII / EEO 风险词）",
      "发布 JD_GENERATED 事件",
    ],
    tools: [
      "LLM.generateJD（gemini-3-flash / gpt-4o-mini）",
      "Template.render",
      "Compliance.lint",
    ],
    inputs: ["CLARIFICATION_READY", "JD_REJECTED"],
    outputs: ["JD_GENERATED"],
    failureModes: ["LLM JSON schema 不符", "合规拦截"],
  },
  {
    short: "JDReviewer",
    summary: "HSM 审批 JD：通过 → JD_APPROVED；驳回 → JD_REJECTED 并附理由。",
    operations: [
      "渲染 JD diff（与上一版本）",
      "记录审批人 / 时间 / 备注",
      "通过 / 驳回",
    ],
    tools: ["HSM 审批 UI", "AuditLog.write"],
    inputs: ["JD_GENERATED"],
    outputs: ["JD_APPROVED", "JD_REJECTED"],
  },
  {
    short: "TaskAssigner",
    summary: "把已批准的 JD 分配到合适的发布 / 招聘小组。",
    operations: [
      "查询招聘运营组成员负载",
      "按规则（地域 / 行业）分配 owner",
      "发出 TASK_ASSIGNED",
    ],
    tools: ["Routing rules", "Inngest.send"],
    inputs: ["JD_APPROVED"],
    outputs: ["TASK_ASSIGNED"],
  },
  {
    short: "Publisher",
    summary: "把 JD 发布到外部渠道（前程无忧 / 智联 / BOSS / 官网门户）。",
    operations: [
      "并发调用各渠道发布 API",
      "处理 4xx / 限流，按 backoff 重试",
      "成功 → CHANNEL_PUBLISHED；失败 → CHANNEL_PUBLISHED_FAILED",
    ],
    tools: ["BOSS API", "智联 API", "前程无忧 API", "Retry/Backoff"],
    inputs: ["TASK_ASSIGNED"],
    outputs: ["CHANNEL_PUBLISHED", "CHANNEL_PUBLISHED_FAILED"],
    failureModes: ["渠道 API 429 / 5xx", "审核驳回"],
  },
  {
    short: "ManualPublish",
    summary: "渠道自动发布失败时，HSM 手动登录渠道发布并回填 URL。",
    operations: [
      "向 HSM 派发任务（带失败原因）",
      "等待人工提交渠道 URL",
      "成功后发出 CHANNEL_PUBLISHED",
    ],
    tools: ["HSM Inbox"],
    inputs: ["CHANNEL_PUBLISHED_FAILED"],
    outputs: ["CHANNEL_PUBLISHED"],
  },
  {
    short: "ResumeCollector",
    summary: "拉取 / 接收候选人简历（渠道 webhook + 主动拉取）。",
    operations: [
      "订阅渠道 webhook 与 cron 拉取",
      "去重并落入 MinIO 原文",
      "发布 RESUME_DOWNLOADED",
    ],
    tools: ["Channel API", "MinIO.put"],
    inputs: ["CHANNEL_PUBLISHED"],
    outputs: ["RESUME_DOWNLOADED"],
  },
  {
    short: "ResumeParser",
    summary: "把简历原文（PDF / image）解析为结构化候选人档案。",
    operations: [
      "PDF text extraction（unpdf / pdf-parse）",
      "OCR fallback for scans",
      "LLM.extract 候选人字段",
      "DupeCheck（手机 / 邮箱 / 身份证哈希）",
    ],
    tools: ["unpdf", "OCR", "LLM.extract", "DupeIndex"],
    inputs: ["RESUME_DOWNLOADED"],
    outputs: ["RESUME_PROCESSED", "RESUME_PARSE_ERROR"],
    failureModes: ["扫描件 OCR 失败", "LLM 字段不全"],
  },
  {
    short: "ResumeFixer",
    summary: "解析失败时由 HSM 手工补充关键字段。",
    operations: [
      "渲染原文 + 缺失字段表单",
      "保存后强制触发 RESUME_PROCESSED",
    ],
    tools: ["HSM 表单 UI"],
    inputs: ["RESUME_PARSE_ERROR"],
    outputs: ["RESUME_PROCESSED"],
  },
  {
    short: "Matcher",
    summary: "把候选人 vs 职位做硬性 / 加分 / 负向打分，决定是否进入面试。",
    operations: [
      "硬性条件过滤（技能 / 年限 / 学历）",
      "加分项打分（背景 / 公司 / 项目）",
      "负向项检测（黑名单 / 竞业）",
      "聚合置信度，发出 MATCH_PASSED_* / MATCH_FAILED",
    ],
    tools: ["LLM.classify", "Skill 词典", "Blacklist 服务"],
    inputs: ["RESUME_PROCESSED"],
    outputs: [
      "MATCH_PASSED_NEED_INTERVIEW",
      "MATCH_PASSED_NO_INTERVIEW",
      "MATCH_FAILED",
    ],
    failureModes: ["低置信样本", "技能词典覆盖不足"],
  },
  // MatchReviewer removed: not in canonical workflow spec. MATCH_FAILED is terminal.
  {
    short: "InterviewInviter",
    summary: "向通过 Matcher 的候选人发出 AI 面试邀请。",
    operations: [
      "生成面试链接 + 时间窗口",
      "发短信 / 邮件",
      "发出 INTERVIEW_INVITATION_SENT",
    ],
    tools: ["短信网关", "Mail provider"],
    inputs: ["MATCH_PASSED_NEED_INTERVIEW"],
    outputs: ["INTERVIEW_INVITATION_SENT"],
  },
  {
    short: "AIInterviewer",
    summary: "驱动 AI 面试（语音 / 视频）并产出转写 + 评分。",
    operations: [
      "实时 ASR 转写",
      "按 rubric 提问 / 追问",
      "产出能力评分 + 关键片段",
      "发出 AI_INTERVIEW_COMPLETED",
    ],
    tools: ["ASR", "LLM.interview", "评分 rubric"],
    inputs: ["INTERVIEW_INVITATION_SENT"],
    outputs: ["AI_INTERVIEW_COMPLETED"],
    failureModes: ["音频抖动 / 候选人退出"],
  },
  {
    short: "Evaluator",
    summary: "结合面试转写 + 简历做综合评估和 bias 检查。",
    operations: [
      "综合评分（面试 + 简历 + 项目证据）",
      "Bias / EEO 风险检查",
      "EVALUATION_PASSED / FAILED",
    ],
    tools: ["LLM.evaluate", "Bias detector"],
    inputs: ["AI_INTERVIEW_COMPLETED"],
    outputs: ["EVALUATION_PASSED", "EVALUATION_FAILED"],
  },
  {
    short: "ResumeRefiner",
    summary: "为客户提交润色候选人简历（隐去 PII、突出岗位匹配点）。",
    operations: [
      "PII 脱敏",
      "按岗位 keyword 重排亮点",
      "生成 RESUME_OPTIMIZED",
    ],
    tools: ["LLM.rewrite", "Templates"],
    inputs: ["EVALUATION_PASSED", "MATCH_PASSED_NO_INTERVIEW"],
    outputs: ["RESUME_OPTIMIZED"],
  },
  {
    short: "PackageBuilder",
    summary: "把简历 + 评估打包成客户可读的推荐材料。",
    operations: [
      "组装 PDF / HTML 推荐包",
      "校验关键字段是否齐全",
      "PACKAGE_GENERATED 或 PACKAGE_MISSING_INFO",
    ],
    tools: ["Template.render", "PDF 渲染"],
    inputs: ["RESUME_OPTIMIZED"],
    outputs: ["PACKAGE_GENERATED", "PACKAGE_MISSING_INFO"],
  },
  {
    short: "PackageFiller",
    summary: "推荐包字段缺失时人工补全。",
    operations: ["显示缺失项与上下文", "人工填写并保存"],
    tools: ["HSM 表单 UI"],
    inputs: ["PACKAGE_MISSING_INFO"],
    outputs: ["PACKAGE_GENERATED"],
  },
  {
    short: "PackageReviewer",
    summary: "HSM 终审：确认推荐包合规与客户匹配，再放行。",
    operations: [
      "渲染最终推荐包预览",
      "审核 + 添加批注",
      "PACKAGE_APPROVED",
    ],
    tools: ["HSM 审批 UI"],
    inputs: ["PACKAGE_GENERATED"],
    outputs: ["PACKAGE_APPROVED"],
  },
  {
    // Not a workflow agent — system-level meta agent for the per-run
    // chatbot. Surfacing it here lets /api/agents/Chatbot/explain return
    // useful context, and makes Chatbot appear in cross-agent UIs (logs,
    // /workflow Inspector if user navigates to it) consistently.
    short: "Chatbot",
    summary: "Run-scoped 问答助手；调底层 API 取真数据回答用户的问题。",
    operations: [
      "接收用户自然语言问题",
      "用 OpenAI tool-use 协议从 5 个只读工具中挑选合适的（getActivityLog / getAgentStats / getEventTrace / getRunSummary / getAgentInfo）",
      "把工具结果合成回答；每个事实附 inline citation",
      "回答完成后写两条 AgentActivity（user 问 + AI 答）作为审计 trail",
    ],
    tools: ["LLM (gemini-3-flash-preview / gpt-4o-mini)", "5 个只读 API 工具"],
    inputs: ["用户在 AI 助手 Tab 输入的自由文本"],
    outputs: ["chat 回复（markdown）+ sources[] 引用 + 2 条 AgentActivity 审计行"],
    failureModes: [
      "LLM 网关未配置 → 走 keyword-route fallback",
      "LLM 调工具调到第 4 轮还没结束 → 强制收尾（max_turns 保护）",
    ],
  },
  {
    short: "PortalSubmitter",
    summary: "把推荐包提交到客户门户（API / 表单自动化）。",
    operations: [
      "认证客户门户",
      "提交字段 + 附件",
      "失败时重试 / 失败上报",
    ],
    tools: ["客户门户 API", "Headless 提交（fallback）"],
    inputs: ["PACKAGE_APPROVED"],
    outputs: ["APPLICATION_SUBMITTED", "SUBMISSION_FAILED"],
    failureModes: ["客户门户认证过期", "提交字段格式漂移"],
  },
];

export function byShortFunction(short: string): AgentFunctionMeta | undefined {
  return AGENT_FUNCTIONS.find((a) => a.short === short);
}

/** Combined view: AgentMeta wiring + AgentFunctionMeta narrative. */
export function getAgentBundle(short: string):
  | { meta: AgentMeta; fn: AgentFunctionMeta }
  | null {
  const meta = byShort(short);
  const fn = byShortFunction(short);
  if (!meta || !fn) return null;
  return { meta, fn };
}

/** Deterministic fallback used when no LLM is configured. */
export function fallbackAgentExplanation(short: string): string {
  const bundle = getAgentBundle(short);
  if (!bundle) {
    return `没有 ${short} 的元数据。请先在 lib/agent-mapping.ts / lib/agent-functions.ts 注册。`;
  }
  const { meta, fn } = bundle;
  const lines: string[] = [];
  lines.push(`# ${short} · ${fn.summary}`);
  lines.push("");
  lines.push(`**阶段**: ${meta.stage}　**类型**: ${meta.kind}　**Owner**: ${meta.ownerTeam}　**版本**: ${meta.version}`);
  lines.push("");
  lines.push("## 触发条件");
  lines.push(meta.triggersEvents.length ? meta.triggersEvents.map((e) => `- \`${e}\``).join("\n") : "- （无显式触发，被动执行）");
  lines.push("");
  lines.push("## 典型操作");
  lines.push(fn.operations.map((o) => `- ${o}`).join("\n"));
  lines.push("");
  lines.push("## 调用工具");
  lines.push(fn.tools.map((t) => `- ${t}`).join("\n"));
  lines.push("");
  lines.push("## 产出事件");
  lines.push(meta.emitsEvents.length ? meta.emitsEvents.map((e) => `- \`${e}\``).join("\n") : "- （终端 agent，不再产生下游事件）");
  if (fn.failureModes && fn.failureModes.length > 0) {
    lines.push("");
    lines.push("## 常见失败模式");
    lines.push(fn.failureModes.map((f) => `- ${f}`).join("\n"));
  }
  return lines.join("\n");
}
