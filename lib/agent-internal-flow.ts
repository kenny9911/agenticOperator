// Per-agent internal flow definitions.
//
// Each entry describes the INTERNAL pipeline an agent runs through when handling
// one event — used to render an internal flow diagram on the agent detail page.
//
// Sources:
//   - Static step names from agent code (check-pause, save-candidate, etc.)
//   - Sub-system mentions (e.g., Matcher includes rule-check as an internal stage)
//   - I/O event mapping
//
// To enrich at runtime, we can cross-check actual step trace from Inngest history
// — that's what InngestAgentDetailContent does to confirm which steps actually ran.

export type AgentInternalStep = {
  id: string;
  name: string;             // technical name(matches Inngest stepName when applicable)
  label: string;            // human-friendly label
  description: string;
  kind: 'guard' | 'fetch' | 'compute' | 'persist' | 'emit' | 'subsystem' | 'audit';
  externalCall?: string;    // optional: which RAAS / LLM endpoint this step hits
  note?: string;            // optional: extra detail (e.g., "planned, not yet wired")
};

export type AgentInternalFlow = {
  slug: string;
  shortName: string;
  fullName: string;
  inputs: string[];
  outputs: string[];
  steps: AgentInternalStep[];
};

export const AGENT_INTERNAL_FLOWS: Record<string, AgentInternalFlow> = {
  // ─── Resume Parser ───
  'agentic-operator-main-resume-parser-agent': {
    slug: 'agentic-operator-main-resume-parser-agent',
    shortName: 'ResumeParser',
    fullName: 'Resume Parser Agent',
    inputs: ['RESUME_DOWNLOADED'],
    outputs: ['RESUME_PROCESSED'],
    steps: [
      {
        id: 'check-pause',
        name: 'check-pause',
        label: '1. 暂停闸',
        description: '检查 AgentConfig.enabled 是否为 false。若被运维暂停,short-circuit 返回 { ok, paused: true },不消费 token 不调下游。',
        kind: 'guard',
      },
      {
        id: 'unwrap-envelope',
        name: 'unwrap',
        label: '2. 解包事件',
        description: '兼容 RAAS canonical envelope 和 flat 两种 shape · 提取 upload_id / bucket / object_key / parsed.data。',
        kind: 'compute',
      },
      {
        id: 'fetch-pdf',
        name: 'fetch-pdf',
        label: '3. 拉简历 PDF',
        description: '如果事件没带 parsed.data,调 RAAS GET /api/v1/resumes/uploads/{upload_id}/raw 拉原始 PDF 字节(MinIO transparent proxy)。',
        kind: 'fetch',
        externalCall: 'RAAS GET /resumes/uploads/{id}/raw',
      },
      {
        id: 'parse-resume',
        name: 'parse-resume',
        label: '4. 解析 PDF',
        description: '调 RAAS POST /api/v1/parse-resume(透传 RoboHire LLM)解析 PDF → 结构化 candidate / experience / education / skills。',
        kind: 'fetch',
        externalCall: 'RAAS POST /parse-resume',
      },
      {
        id: 'save-candidate',
        name: 'save-candidate',
        label: '5. 持久化',
        description: '调 RAAS POST /api/v1/candidates 写入候选人 + 简历记录 · 拿到 candidate_id + resume_id · etag 去重。',
        kind: 'persist',
        externalCall: 'RAAS POST /candidates',
      },
      {
        id: 'em-audit-resume-processed',
        name: 'em-audit-resume-processed',
        label: '6. EM 审计',
        description: '经 AO-main EventManager publish RESUME_PROCESSED · 写 EventInstance 表做审计 trace。',
        kind: 'audit',
      },
      {
        id: 'emit-resume-processed',
        name: 'emit-resume-processed',
        label: '7. 发下游事件',
        description: 'Inngest sendEvent RESUME_PROCESSED → 触发下游 Matcher。',
        kind: 'emit',
      },
    ],
  },

  // ─── Create JD ───
  'agentic-operator-main-create-jd-agent': {
    slug: 'agentic-operator-main-create-jd-agent',
    shortName: 'CreateJD',
    fullName: 'Create JD Agent',
    inputs: ['REQUIREMENT_LOGGED', 'CLARIFICATION_READY', 'JD_REJECTED'],
    outputs: ['JD_GENERATED'],
    steps: [
      {
        id: 'check-pause',
        name: 'check-pause',
        label: '1. 暂停闸',
        description: '同 ResumeParser:查 AgentConfig 是否暂停,paused → no-op return。',
        kind: 'guard',
      },
      {
        id: 'load-requirement',
        name: 'load-requirement',
        label: '2. 拉取需求详情',
        description: '调 RAAS GET /api/v1/requirements/{id} 拉 raw_input_data(prompt / language / company / department)。',
        kind: 'fetch',
        externalCall: 'RAAS GET /requirements/{id}',
      },
      {
        id: 'generate-jd',
        name: 'generate-jd',
        label: '3. LLM 生成 JD',
        description: '调 RAAS POST /api/v1/generate-jd(透传 RoboHire LLM)生成 JD 草稿 — title / description / qualifications / hardRequirements / niceToHave / salaryMin/Max。',
        kind: 'fetch',
        externalCall: 'RAAS POST /generate-jd',
      },
      {
        id: 'project-canonical',
        name: 'project-canonical',
        label: '4. 投影 partner shape',
        description: 'RoboHire camelCase data → partner-canonical snake_case(posting_title / posting_description / city / salary_range / must_have_skills 等)。',
        kind: 'compute',
      },
      {
        id: 'sync-generated',
        name: 'sync-generated',
        label: '5. 持久化 JD',
        description: '调 RAAS POST /api/v1/jd/sync-generated 写回 RAAS DB · 拿到 jd_id。',
        kind: 'persist',
        externalCall: 'RAAS POST /jd/sync-generated',
      },
      {
        id: 'em-audit-jd-generated',
        name: 'em-audit-jd-generated',
        label: '6. EM 审计',
        description: '经 EM publish JD_GENERATED · 写 EventInstance。',
        kind: 'audit',
      },
      {
        id: 'emit-jd-generated',
        name: 'emit-jd-generated',
        label: '7. 发下游事件',
        description: 'Inngest sendEvent JD_GENERATED → 触发 JDReviewer / Publisher。',
        kind: 'emit',
      },
    ],
  },

  // ─── Match Resume (with explicit rule-check stage) ───
  'agentic-operator-main-match-resume-agent': {
    slug: 'agentic-operator-main-match-resume-agent',
    shortName: 'Matcher',
    fullName: 'Match Resume Agent',
    inputs: ['RESUME_PROCESSED'],
    outputs: ['MATCH_PASSED_NEED_INTERVIEW', 'MATCH_PASSED_NO_INTERVIEW', 'MATCH_FAILED'],
    steps: [
      {
        id: 'check-pause',
        name: 'check-pause',
        label: '1. 暂停闸',
        description: '同 ResumeParser:查 AgentConfig.enabled,被暂停就 short-circuit。',
        kind: 'guard',
      },
      {
        id: 'unwrap-envelope',
        name: 'unwrap',
        label: '2. 解包事件',
        description: '抽 upload_id / candidate_id / resume_id / employee_id / job_requisition_id / parsed.data。',
        kind: 'compute',
      },
      {
        id: 'build-resume-text',
        name: 'build-resume-text',
        label: '3. 简历转 text',
        description: '把 parsed.data 拍平成 plain text(姓名 / 联系方式 / 技能 / 经历 / 教育)— 喂给 /match-resume 的 resume 字段。',
        kind: 'compute',
      },
      {
        id: 'fetch-jr-list',
        name: 'fetch-jr-list',
        label: '4. 取 JR 列表',
        description: '如果事件带 job_requisition_id 就只匹配该 1 个;否则调 RAAS GET /api/v1/requirements/agents/view 拉员工名下所有 recruiting JR 批量匹配。',
        kind: 'fetch',
        externalCall: 'RAAS GET /requirements/agents/view',
      },
      {
        id: 'rule-check',
        name: 'rule-check',
        label: '5. Rule Check 预筛 ⚡',
        description: 'AO 内部 5-agent pipeline(OntologyQuery → SeverityInference → RuleScopeClassifier → RuleClassifier → PromptComposer → LLMRunner)对每个 JR + Candidate 跑 ontology 规则预筛 · 写 RuleCheckAudit 到 Prisma/Postgres · 失败的 JR 跳过 /match-resume 节省 RoboHire 配额。',
        kind: 'subsystem',
        externalCall: 'AO Prisma RuleCheckAudit · scripts/rule-check-poc',
        note: '★ POC 已完成,生产集成中(matchResumeAgent step 4 之前插入)',
      },
      {
        id: 'match-resume',
        name: 'match-resume',
        label: '6. 算 match score',
        description: '对 rule-check 通过的每个 JR · 调 RAAS POST /api/v1/match-resume(透传 RoboHire LLM)算 overallMatchScore.score + overallFit.verdict 等 20+ 字段。',
        kind: 'fetch',
        externalCall: 'RAAS POST /match-resume',
      },
      {
        id: 'save-match-results',
        name: 'save-match-results',
        label: '7. 持久化 match',
        description: '调 RAAS POST /api/v1/match-results 写回 source=need_interview · 拿到 match_result_id。',
        kind: 'persist',
        externalCall: 'RAAS POST /match-results',
      },
      {
        id: 'em-audit-match',
        name: 'em-audit-match',
        label: '8. EM 审计',
        description: '经 EM publish MATCH_PASSED_NEED_INTERVIEW / MATCH_PASSED_NO_INTERVIEW / MATCH_FAILED 之一。',
        kind: 'audit',
      },
      {
        id: 'emit-match',
        name: 'emit-match',
        label: '9. 发下游事件',
        description: 'Inngest sendEvent · 触发下游 InterviewInviter / Evaluator / 重新进 ResumeFixer。',
        kind: 'emit',
      },
    ],
  },
};

export const STEP_KIND_COLOR: Record<AgentInternalStep['kind'], { fill: string; border: string; icon: string }> = {
  guard:     { fill: 'bg-panel',    border: 'border-line',          icon: '🔒' },
  fetch:     { fill: 'bg-accent-bg', border: 'border-accent',        icon: '↓' },
  compute:   { fill: 'bg-surface',  border: 'border-line',          icon: '⚙' },
  persist:   { fill: 'bg-ok-bg',    border: 'border-ok',            icon: '💾' },
  audit:     { fill: 'bg-panel',    border: 'border-line',          icon: '📋' },
  subsystem: { fill: 'bg-warn-bg',  border: 'border-warn',          icon: '⚡' },
  emit:      { fill: 'bg-surface',  border: 'border-line',          icon: '→' },
};
