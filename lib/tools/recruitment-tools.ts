// Hand-coded recruitment tool library. Each entry wraps a real client method
// with a JSON schema + side-effect tag. `execute` lazily imports the client
// (no top-level coupling / side effects) and short-circuits to a schema-shaped
// mock under dryRun, so generation + tests never hit RoboHire/RAAS/Neo4j.
//
// This is the trust boundary: humans own these wrappers; the factory only
// selects + composes them. Wiring of the real branch is best-effort (typed
// loosely via dynamic import) — the factory/test path uses schemas + dryRun.

import { ToolRegistry, type ToolDescriptor } from "./registry";

const RECRUIT = "recruit";
/* eslint-disable @typescript-eslint/no-explicit-any */

// RANK-3 (golden fixture): the dry-run mocks used by sandbox_run must be
// SCHEMA-COMPLETE happy-path data — not empty shells. With `skills: []` an agent
// genuinely (and correctly) picks the failure branch (RESUME_INFO_MISSING), so
// the happy-path chain dies on the first hop and the sandbox can never go green.
// A complete golden candidate lets the verifier actually exercise the full chain.
const GOLDEN_CANDIDATE = {
  candidate_id: "cand_demo_001",
  name: "张三",
  phone: "13800000000",
  email: "zhangsan@example.com",
  gender: "男",
  age: 30,
  education: "本科",
  school: "示例大学",
  major: "计算机科学与技术",
  graduationYear: 2017,
  endDate: "2017-07",
  workYears: 6,
  skills: ["Java", "Spring Boot", "分布式系统", "MySQL", "Redis"],
  currentCompany: "示例科技有限公司",
  workHistory: [{ company: "示例科技有限公司", title: "高级后端工程师", years: 4 }],
} as const;
const GOLDEN_REQUIREMENT = {
  job_requisition_id: "jr_demo_001",
  title: "高级后端工程师",
  client: "示例客户",
  department: "技术部",
  must_have_skills: ["Java", "Spring Boot"],
  nice_to_have_skills: ["分布式系统", "Redis"],
  min_years: 3,
  education: "本科",
  headcount: 2,
} as const;

/** Fail-safe for LIVE tool execution: resolve a client export by name or throw.
 *  Guarantees that a missing/renamed client export throws (so the executor's
 *  try/catch marks the run failed) instead of silently returning `undefined`
 *  or — worse — falling through to the dry-run mock. The mock is ONLY ever
 *  reachable inside the `if (ctx?.dryRun)` branch; live mode has no mock path. */
function callExport<T = (...args: any[]) => any>(mod: any, fn: string, tool: string): T {
  const f = mod?.[fn];
  if (typeof f !== "function") {
    throw new Error(`[tool ${tool}] live execution failed: client export '${fn}' missing — refusing to silently mock`);
  }
  return f as T;
}

const str = (description: string) => ({ type: "string", description });
const num = (description?: string) => ({ type: "number", ...(description ? { description } : {}) });
const arr = (items: unknown, description?: string) => ({ type: "array", items, ...(description ? { description } : {}) });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const RECRUITMENT_TOOLS: ToolDescriptor[] = [
  {
    name: "minio.getResume",
    title: "下载简历原件",
    description: "从 MinIO 对象存储下载候选人简历原件(PDF Buffer),用于解析。",
    domain: RECRUIT,
    sideEffect: "read",
    parameters: obj({ object_key: str("MinIO 对象键 / 简历文件路径"), bucket: str("MinIO bucket(缺省取 MINIO_RESUME_BUCKET)") }, ["object_key"]),
    returns: obj({ buffer: str("PDF 字节流"), size: { type: "number" } }),
    requiredEnv: ["MINIO_ENDPOINT", "MINIO_ACCESS_KEY"],
    idempotent: true,
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "minio.getResume", size: 12345 };
      const mod: any = await import("@/lib/minio");
      const bucket = String(args.bucket ?? process.env.MINIO_RESUME_BUCKET ?? "resumes");
      return callExport(mod, "getResumeBuffer", "minio.getResume")(bucket, String(args.object_key));
    },
  },
  {
    name: "robohire.parseResume",
    title: "解析简历",
    description: "调用 RoboHire 直连接口把简历 PDF 解析为结构化字段(工作/项目/教育/技能)。性别不返回需从 rawText 补抽;毕业时间取 endDate。",
    domain: RECRUIT,
    sideEffect: "read",
    parameters: obj({ pdf: str("PDF Buffer"), filename: str("文件名,如 resume.pdf") }, ["pdf"]),
    // The REAL parsed shape RoboHire returns under `data` — so a generated agent
    // knows exactly which structured fields it gets back (and that gender/rawText
    // need补抽, endDate is the grad time). External-platform I/O lives HERE, not in
    // the ontology action.
    returns: obj({
      data: obj({
        name: str("姓名"), phone: str("手机号"), email: str("邮箱"),
        gender: str("性别(RoboHire 常不返回,需从 rawText 补抽)"),
        age: num("年龄"), education: str("最高学历"), school: str("毕业院校"), major: str("专业"),
        graduationYear: num("毕业年份(优先用 endDate)"), endDate: str("毕业时间(取此,非 graduationYear)"),
        workYears: num("工作年限"), currentCompany: str("当前公司"),
        skills: arr(str("技能标签"), "技能数组"),
        workHistory: arr(obj({ company: str("公司"), title: str("职位"), years: num("年限") }), "工作经历"),
        rawText: str("简历原文,gender 等缺失字段从此抽取"),
      }),
      requestId: str("请求 id"), cached: { type: "boolean" },
    }),
    requiredEnv: ["ROBOHIRE_API_BASE_URL", "ROBOHIRE_API_KEY"],
    idempotent: true,
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "robohire.parseResume", data: { ...GOLDEN_CANDIDATE } };
      const mod: any = await import("@/lib/robohire-client");
      return callExport(mod, "parseResumeDirect", "robohire.parseResume")(args.pdf as Buffer, String(args.filename ?? "resume.pdf"));
    },
  },
  {
    name: "robohire.matchResume",
    title: "简历匹配评分",
    description: "调用 RoboHire 直连接口对候选人简历与岗位 JD 做匹配评分,返回总分与维度理由。入参 resume/jd 为纯文本。",
    domain: RECRUIT,
    sideEffect: "read",
    parameters: obj({ resume: str("简历纯文本"), jd: str("岗位 JD 纯文本") }, ["resume", "jd"]),
    returns: obj({ score: { type: "number" }, reason: str("匹配理由") }),
    requiredEnv: ["ROBOHIRE_API_BASE_URL", "ROBOHIRE_API_KEY"],
    idempotent: true,
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "robohire.matchResume", score: 72 };
      const mod: any = await import("@/lib/robohire-client");
      return callExport(mod, "matchResumeDirect", "robohire.matchResume")({ resume: args.resume, jd: args.jd });
    },
  },
  {
    name: "robohire.generateJd",
    title: "生成 JD",
    description: "调用 RoboHire 直连接口由招聘需求生成 JD 文案(hardRequirements/niceToHave),散文需再拆为技能数组。",
    domain: RECRUIT,
    sideEffect: "read",
    parameters: obj({ requirement: str("招聘需求文本"), language: str("语言,默认 zh") }, ["requirement"]),
    // RoboHire returns hardRequirements/niceToHave as PROSE (no structured skill
    // arrays) — a generated agent must know to run proseToSkillArray downstream.
    returns: obj({
      hardRequirements: str("硬性要求(散文,需 proseToSkillArray 拆成 must_have_skills)"),
      niceToHave: str("加分项(散文,需拆成 nice_to_have_skills)"),
      jd_content: str("JD 正文"),
    }),
    requiredEnv: ["ROBOHIRE_API_BASE_URL", "ROBOHIRE_API_KEY"],
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "robohire.generateJd", jd_content: "示例 JD" };
      const mod: any = await import("@/lib/robohire-client");
      // client reads `prompt`, not `requirement` (accept either upstream key)
      return callExport(mod, "generateJdDirect", "robohire.generateJd")({
        prompt: String(args.requirement ?? args.prompt ?? ""),
        language: args.language,
      });
    },
  },
  {
    name: "robohire.inviteCandidate",
    title: "发送面试邀约",
    description: "调用 RoboHire 直连接口向候选人发送面试邀约。写操作 / 有外部副作用。",
    domain: RECRUIT,
    sideEffect: "write",
    parameters: obj(
      { candidate_id: str("候选人 id"), job_id: str("岗位 id"), resume_text: str("简历文本"), jd_text: str("JD 文本") },
      ["candidate_id", "job_id"],
    ),
    returns: obj({ ok: { type: "boolean" }, correlation_id: str("关联 id") }),
    requiredEnv: ["ROBOHIRE_API_BASE_URL", "ROBOHIRE_API_KEY"],
    idempotent: false,
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "robohire.inviteCandidate", ok: true };
      const mod: any = await import("@/lib/robohire-client");
      // map the tool's declared field names onto what the client actually reads
      // (resume/jd, not resume_text/jd_text) — else inviteCandidateDirect throws
      // its CLIENT "resume 或 resume_id 至少给一个" validation on every live call.
      return callExport(mod, "inviteCandidateDirect", "robohire.inviteCandidate")({
        resume: args.resume_text != null ? String(args.resume_text) : undefined,
        jd: args.jd_text != null ? String(args.jd_text) : undefined,
        job_id: args.job_id != null ? String(args.job_id) : undefined,
      });
    },
  },
  {
    name: "partnerpg.getRequirement",
    title: "读取招聘需求",
    description: "从 RAAS partner Postgres 读取岗位需求明细(Job_Requisition)。",
    domain: RECRUIT,
    sideEffect: "read",
    parameters: obj({ job_requisition_id: str("岗位需求 id") }, ["job_requisition_id"]),
    returns: obj({ requirement: { type: "object" } }),
    idempotent: true,
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "partnerpg.getRequirement", ...GOLDEN_REQUIREMENT };
      const mod: any = await import("@/lib/partner-pg/requirements");
      return callExport(mod, "getRequirementDetail", "partnerpg.getRequirement")(args.job_requisition_id);
    },
  },
  {
    name: "partnerpg.getParsedResume",
    title: "读取已解析简历",
    description: "从 partner Postgres 读取已结构化的候选人简历。",
    domain: RECRUIT,
    sideEffect: "read",
    parameters: obj({ candidate_id: str("候选人 id"), resume_id: str("简历 id") }, ["candidate_id"]),
    returns: obj({ resume: { type: "object" } }),
    idempotent: true,
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "partnerpg.getParsedResume", ...GOLDEN_CANDIDATE };
      const mod: any = await import("@/lib/partner-pg/parsed-resume");
      return callExport(mod, "getParsedResume", "partnerpg.getParsedResume")(args.candidate_id, args.resume_id);
    },
  },
  {
    name: "partnerpg.saveCandidate",
    title: "落库候选人(双写)",
    description: "把候选人+简历写入 RAAS partner Postgres 主表(dual-write 契约,需与 Neo4j 镜像一致)。",
    domain: RECRUIT,
    sideEffect: "dual-write",
    parameters: obj({ candidate: { type: "object" }, resume: { type: "object" } }, ["candidate"]),
    returns: obj({ candidate_id: str("落库候选人 id") }),
    idempotent: false,
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "partnerpg.saveCandidate", candidate_id: "cand_mock" };
      const mod: any = await import("@/lib/partner-pg/candidates");
      return callExport(mod, "saveCandidateToPartnerPg", "partnerpg.saveCandidate")(args);
    },
  },
  {
    name: "partnerpg.saveMatchResults",
    title: "落库匹配结果(双写)",
    description: "把匹配评分结果写入 partner Postgres Candidate_Match_Result。",
    domain: RECRUIT,
    sideEffect: "dual-write",
    parameters: obj({ match: { type: "object" } }, ["match"]),
    returns: obj({ candidate_match_result_id: str("CMR id") }),
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "partnerpg.saveMatchResults" };
      const mod: any = await import("@/lib/partner-pg/match-results");
      return callExport(mod, "saveMatchResultsToPartnerPg", "partnerpg.saveMatchResults")(args.match);
    },
  },
  {
    name: "partnerpg.saveRuleCheckFail",
    title: "落库规则未通过(双写)",
    description: "规则校验未通过时无条件 upsert candidate_match_result(match_status=未通过)。",
    domain: RECRUIT,
    sideEffect: "dual-write",
    parameters: obj({ candidate_id: str("候选人 id"), job_requisition_id: str("岗位 id"), reason: str("原因") }, ["candidate_id"]),
    returns: obj({ ok: { type: "boolean" } }),
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "partnerpg.saveRuleCheckFail" };
      const mod: any = await import("@/lib/partner-pg/rule-check-result");
      return callExport(mod, "saveRuleCheckFailToPartnerPg", "partnerpg.saveRuleCheckFail")(args);
    },
  },
  {
    name: "partnerpg.syncJd",
    title: "落库 JD(双写)",
    description: "把生成的 JD(job_posting)写入 partner Postgres。",
    domain: RECRUIT,
    sideEffect: "dual-write",
    parameters: obj({ job_posting: { type: "object" } }, ["job_posting"]),
    returns: obj({ job_posting_id: str("职位发布 id") }),
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "partnerpg.syncJd", job_posting_id: "jp_mock" };
      const mod: any = await import("@/lib/partner-pg/job-posting");
      return callExport(mod, "syncJdToPartnerPg", "partnerpg.syncJd")(args.job_posting);
    },
  },
  {
    name: "partnerpg.markInterview",
    title: "标记面试已邀约",
    description: "按 correlation_id 在 partner Postgres 标记面试邀约已发送。",
    domain: RECRUIT,
    sideEffect: "write",
    parameters: obj({ correlation_id: str("关联 id") }, ["correlation_id"]),
    returns: obj({ ok: { type: "boolean" } }),
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "partnerpg.markInterview" };
      const mod: any = await import("@/lib/partner-pg/interview-invitations");
      return callExport(mod, "markInterviewInvitationSent", "partnerpg.markInterview")(args.correlation_id);
    },
  },
  {
    name: "allmeta.getInstance",
    title: "读取本体实例",
    description: "按 label + 主键从 Neo4j(Allmeta)读取一个实例。",
    domain: RECRUIT,
    sideEffect: "read",
    parameters: obj({ label: str("对象 label,如 Candidate"), pk: str("主键值") }, ["label", "pk"]),
    returns: obj({ instance: { type: "object" } }),
    idempotent: true,
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "allmeta.getInstance" };
      const mod: any = await import("@/lib/allmeta-client");
      return callExport(mod, "getInstance", "allmeta.getInstance")(String(args.label), String(args.pk));
    },
  },
  {
    name: "allmeta.writeInstance",
    title: "写入本体实例",
    description: "把一个实例写入 Neo4j(Allmeta)。写操作 / dual-write 镜像。",
    domain: RECRUIT,
    sideEffect: "write",
    parameters: obj({ label: str("对象 label"), payload: { type: "object", description: "实例属性" } }, ["label", "payload"]),
    returns: obj({ ok: { type: "boolean" } }),
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "allmeta.writeInstance" };
      const mod: any = await import("@/lib/allmeta-client");
      return callExport(mod, "writeInstance", "allmeta.writeInstance")(String(args.label), args.payload);
    },
  },
  {
    name: "allmeta.searchEntities",
    title: "检索本体实体",
    description: "在 Neo4j(Allmeta)按类型/关键字检索实体(失败降级为 [],不抛)。",
    domain: RECRUIT,
    sideEffect: "read",
    parameters: obj({ type: str("实体类型"), q: str("关键字"), limit: { type: "number" } }, ["type"]),
    returns: obj({ results: { type: "array", items: { type: "object" } } }),
    idempotent: true,
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "allmeta.searchEntities", results: [] };
      const mod: any = await import("@/lib/allmeta-client");
      return callExport(mod, "searchEntitiesNeo4j", "allmeta.searchEntities")(args);
    },
  },
  {
    name: "candidateLock.runLockCheck",
    title: "候选人锁定/去重",
    description: "对候选人做三级去重 + 归属锁定判定。LOCK_CHECK_ENFORCE=1 时对不可恢复故障会抛错(Inngest 挂起)。",
    domain: RECRUIT,
    sideEffect: "write",
    parameters: obj({ candidate: { type: "object" }, employee_id: str("发起人 id") }, ["candidate"]),
    returns: obj({ decision: str("锁定决策"), same_as_candidate_id: str("命中的既有候选人") }),
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "candidateLock.runLockCheck", decision: "proceed" };
      const mod: any = await import("@/lib/candidate-lock");
      return callExport(mod, "runLockCheck", "candidateLock.runLockCheck")(args);
    },
  },
  {
    name: "llm.complete",
    title: "AI 补全",
    description: "通用 LLM 调用(经统一网关)。用于需要语言理解/生成的步骤。",
    domain: "*",
    sideEffect: "read",
    parameters: obj({ system: str("系统提示"), user: str("用户输入") }, ["system", "user"]),
    returns: obj({ text: str("补全文本") }),
    requiredEnv: ["AI_API_KEY"],
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "llm.complete", text: "" };
      const mod: any = await import("@/server/llm/gateway");
      const r = await callExport(mod, "chatComplete", "llm.complete")({ system: String(args.system), user: String(args.user) });
      return { text: r.text };
    },
  },
  {
    name: "llm.fieldJudge",
    title: "字段等价判定(AI)",
    description: "用 LLM 判定两个字段(姓名/学校/专业/学历)是否等价,用于候选人模糊去重。",
    domain: "*",
    sideEffect: "read",
    parameters: obj({ field: str("字段名"), a: str("值 A"), b: str("值 B") }, ["field", "a", "b"]),
    returns: obj({ equivalent: { type: "boolean" }, confidence: { type: "number" } }),
    requiredEnv: ["AI_API_KEY"],
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "llm.fieldJudge", equivalent: true };
      const mod: any = await import("@/server/llm/gateway");
      const r = await callExport(mod, "chatComplete", "llm.fieldJudge")({
        system: "你判定两个字段是否指同一事物,只回 true 或 false。",
        user: `${args.field}: A=${args.a} B=${args.b}`,
      });
      return { equivalent: /true/i.test(r.text), confidence: 0.7 };
    },
  },
  {
    // The capability the REAL rule-check agent uses: pull the live business
    // rules for an action from Allmeta/Neo4j (Action→step→Rule edges) instead
    // of having them baked into the prompt. Cross-domain (`*`) so any domain's
    // rule-check agent can fetch its own live rules.
    name: "ontology.fetchActionRules",
    title: "抓取本动作的规则",
    description:
      "从 Allmeta/Neo4j 按 Action→step→Rule 图边【动态抓取】这个动作该执行的业务规则(实时,不是烤进 prompt 的静态文本)。rule-check 类 agent 用它取回红线/冷冻期/竞对等规则后逐条核对候选人。返回 {ruleCount, rules:[{id,name,rule,enforcement,failurePolicy}]}。",
    domain: "*",
    sideEffect: "read",
    parameters: obj(
      { action: str("要抓规则的 action 名(本 agent 对应的动作名)"), domain: str("业务域 id") },
      ["action", "domain"],
    ),
    returns: obj({ ruleCount: { type: "number" }, rules: { type: "array" } }),
    idempotent: true,
    impl: { module: "@/lib/ontology-rules", export: "fetchOntologyActionRules" },
    execute: async (args, ctx) => {
      if (ctx?.dryRun) return { __mock: true, tool: "ontology.fetchActionRules", ruleCount: 0, rules: [] };
      const mod: any = await import("@/lib/ontology-rules");
      return callExport(mod, "fetchOntologyActionRules", "ontology.fetchActionRules")(
        String(args.action),
        String(args.domain ?? ""),
      );
    },
  },
];

// Tool → real client (module + export) so the agent code generator can emit a
// native import + call. Mirrors the `await import(...)` / `callExport(...)` in
// each execute above. Kept as a side-table (not 18 inline `impl:` fields) so the
// mapping stays reviewable in one place.
const TOOL_IMPL: Record<string, { module: string; export: string }> = {
  "minio.getResume": { module: "@/lib/minio", export: "getResumeBuffer" },
  "robohire.parseResume": { module: "@/lib/robohire-client", export: "parseResumeDirect" },
  "robohire.matchResume": { module: "@/lib/robohire-client", export: "matchResumeDirect" },
  "robohire.generateJd": { module: "@/lib/robohire-client", export: "generateJdDirect" },
  "robohire.inviteCandidate": { module: "@/lib/robohire-client", export: "inviteCandidateDirect" },
  "partnerpg.getRequirement": { module: "@/lib/partner-pg/requirements", export: "getRequirementDetail" },
  "partnerpg.getParsedResume": { module: "@/lib/partner-pg/parsed-resume", export: "getParsedResume" },
  "partnerpg.saveCandidate": { module: "@/lib/partner-pg/candidates", export: "saveCandidateToPartnerPg" },
  "partnerpg.saveMatchResults": { module: "@/lib/partner-pg/match-results", export: "saveMatchResultsToPartnerPg" },
  "partnerpg.saveRuleCheckFail": { module: "@/lib/partner-pg/rule-check-result", export: "saveRuleCheckFailToPartnerPg" },
  "partnerpg.syncJd": { module: "@/lib/partner-pg/job-posting", export: "syncJdToPartnerPg" },
  "partnerpg.markInterview": { module: "@/lib/partner-pg/interview-invitations", export: "markInterviewInvitationSent" },
  "allmeta.getInstance": { module: "@/lib/allmeta-client", export: "getInstance" },
  "allmeta.writeInstance": { module: "@/lib/allmeta-client", export: "writeInstance" },
  "allmeta.searchEntities": { module: "@/lib/allmeta-client", export: "searchEntitiesNeo4j" },
  "candidateLock.runLockCheck": { module: "@/lib/candidate-lock", export: "runLockCheck" },
  "llm.complete": { module: "@/server/llm/gateway", export: "chatComplete" },
  "llm.fieldJudge": { module: "@/server/llm/gateway", export: "chatComplete" },
  "ontology.fetchActionRules": { module: "@/lib/ontology-rules", export: "fetchOntologyActionRules" },
};
for (const t of RECRUITMENT_TOOLS) {
  if (!t.impl && TOOL_IMPL[t.name]) t.impl = TOOL_IMPL[t.name];
}

/** Build the recruitment registry. */
export function buildRecruitmentRegistry(): ToolRegistry {
  return new ToolRegistry().registerAll(RECRUITMENT_TOOLS);
}
