// AI summary LLM call.
//
// Generates a natural-language summary of an Inngest agent given:
//   - name + trigger events
//   - recent run stats (success rate, avg duration)
//   - one example event payload (for input shape context)
//
// Uses the existing AI gateway (AI_BASE_URL / AI_API_KEY) configured in .env.local.

import OpenAI from 'openai';

export type AgentSummaryInput = {
  name: string;
  slug: string;
  triggers: string[];
  outputEvents?: string[];                  // 下游 emit 的事件
  stats: { total: number; completed: number; failed: number; successRate: number | null };
  avgDurationMs?: number | null;
  exampleEventName?: string;
  exampleEventPayload?: Record<string, unknown> | null;   // ★ 实际 payload(不只 keys)
  exampleStepNames?: string[];              // ★ 这个 agent 跑过哪些 step
  knownDescription?: string;                // ★ 已知背景(来自 STATIC)
  recentFailureReason?: string;             // ★ 最近失败原因(如有)
};

const SYSTEM_PROMPT = `你是 Agentic Operator 的资深运维分析师。你负责给运维写每个 Inngest agent 的精准技术总结。

输入你会看到:
- agent 名 / slug / trigger 事件
- 下游 emit 的事件
- 24h 运行统计(成功率 / 平均耗时)
- 一个真实事件 payload 样本(JSON)
- agent 实际跑过的 step 名(从 Inngest history 抽出)
- 已知背景(可信的描述)

输出要求:
- 中文,3 段,80-150 字,不要客套话不要 markdown 标题。
- 第 1 段:用一句话精准说明这个 agent 做什么。要根据 step 名 + payload 字段推断具体行为,不要泛泛而谈。
- 第 2 段(2-3 句):列出关键 step 执行流程(input → 处理 → output 事件)。要点出真实 step 名。
- 第 3 段(1 句):列出 24h 统计 + 健康判断。如果有失败,简要分析可能原因。`;

function buildUserPrompt(input: AgentSummaryInput): string {
  const lines: string[] = [];
  lines.push(`Agent 名: ${input.name}`);
  lines.push(`Slug: ${input.slug}`);
  lines.push(`触发事件(input): ${input.triggers.join(' / ')}`);
  if (input.outputEvents?.length) {
    lines.push(`下游事件(output): ${input.outputEvents.join(' / ')}`);
  }
  lines.push(
    `24h 统计: total=${input.stats.total} · completed=${input.stats.completed} · failed=${input.stats.failed} · 成功率=${input.stats.successRate ?? '?'}%${
      input.avgDurationMs ? ` · 平均耗时=${input.avgDurationMs}ms` : ''
    }`,
  );
  if (input.exampleStepNames?.length) {
    lines.push(`实际 step 执行轨迹: ${input.exampleStepNames.join(' → ')}`);
  }
  if (input.exampleEventPayload) {
    const truncated = JSON.stringify(input.exampleEventPayload).slice(0, 1200);
    lines.push(`真实 payload 样本: ${truncated}`);
  }
  if (input.knownDescription) {
    lines.push(`已知背景(可信参考): ${input.knownDescription}`);
  }
  if (input.recentFailureReason) {
    lines.push(`近期失败原因: ${input.recentFailureReason}`);
  }
  return lines.join('\n');
}

function pickGateway(): { baseURL: string; apiKey: string; model: string } | null {
  if (process.env.AI_BASE_URL && process.env.AI_API_KEY) {
    return {
      baseURL: process.env.AI_BASE_URL,
      apiKey: process.env.AI_API_KEY,
      model: process.env.AI_MODEL || 'google/gemini-3-flash-preview',
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return { baseURL: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, model: 'gpt-4o-mini' };
  }
  return null;
}

export async function generateAgentSummary(input: AgentSummaryInput): Promise<{
  text: string;
  model: string;
  durationMs: number;
}> {
  const gw = pickGateway();
  if (!gw) {
    // Fallback: static summary if no LLM configured.
    return {
      text: staticSummaryFor(input),
      model: 'static-fallback',
      durationMs: 0,
    };
  }
  const start = Date.now();
  const client = new OpenAI({ baseURL: gw.baseURL, apiKey: gw.apiKey, timeout: 300_000 });
  const res = await client.chat.completions.create({
    model: gw.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(input) },
    ],
    temperature: 0.3,
    max_tokens: 320,
  });
  const text = res.choices[0]?.message?.content?.trim() ?? staticSummaryFor(input);
  return {
    text,
    model: gw.model,
    durationMs: Date.now() - start,
  };
}

// ─────────────────────────────────────────────────────────────
// Static fallback summaries + known descriptions for LLM context.
//
// Two roles:
//   1. STATIC: 用作 LLM 不可用时的兜底文本(直接展示)
//   2. KNOWN_DESCRIPTIONS: 喂给 LLM 作为"可信背景",让 LLM 生成更具体的总结
// ─────────────────────────────────────────────────────────────
const STATIC: Record<string, string> = {
  'agentic-operator-main-resume-parser-agent':
    'ResumeParser 在收到 RESUME_DOWNLOADED 事件后:从 MinIO 拉简历 PDF → 调 RAAS /parse-resume 解析 → 调 RAAS /candidates 持久化 → 发出 RESUME_PROCESSED 触发下游 Matcher。每份简历约 200-500ms。',
  'agentic-operator-main-create-jd-agent':
    'CreateJD 在收到 REQUIREMENT_LOGGED 事件后:调 RAAS /generate-jd 用 LLM 生成 JD 文本 → 投影成 partner-canonical 形状 → 调 RAAS /jd/sync-generated 持久化 → 发出 JD_GENERATED 通知。也接 CLARIFICATION_READY / JD_REJECTED 做 refine。',
  'agentic-operator-main-match-resume-agent':
    'Matcher 在 RESUME_PROCESSED 后:从 parsed.data 拍平成 resume text → 拉相关 JR(单个或全部 recruiting)→ 对每个 JR 调 RAAS /match-resume 打分 → 写回 /match-results → 发 MATCH_PASSED_NEED_INTERVIEW 或 MATCH_FAILED。',
};

/** Rich known descriptions used as LLM context. More detail than STATIC for the LLM to riff on. */
export const KNOWN_DESCRIPTIONS: Record<string, string> = {
  'agentic-operator-main-resume-parser-agent': [
    '功能职责:简历解析中枢。当 RAAS dashboard 上传一份简历后,RAAS 发出 RESUME_DOWNLOADED 事件,此 agent 接管。',
    '关键 step:',
    '  1) check-pause(查 AgentConfig.enabled 是否暂停)',
    '  2) 用 upload_id 调 RAAS GET /api/v1/resumes/uploads/{id}/raw 拉 PDF 字节',
    '  3) 调 RAAS POST /api/v1/parse-resume(透传 RoboHire)解析简历',
    '  4) 调 RAAS POST /api/v1/candidates 持久化候选人 + 简历',
    '  5) em-audit-resume-processed:经 EM gateway 发审计型 RESUME_PROCESSED',
    '  6) emit-resume-processed:发 RESUME_PROCESSED 触发下游 matchResumeAgent',
    '幂等:有 etag 去重(同一份 PDF 再发不重复处理)',
    'legacy 路径:事件 payload 直接带 parsed.data 时跳过 step 2-3',
  ].join('\n'),
  'agentic-operator-main-create-jd-agent': [
    '功能职责:JD 自动生成。当 RAAS 提交一条新的招聘需求(REQUIREMENT_LOGGED),或澄清完成(CLARIFICATION_READY),或被 reviewer 驳回(JD_REJECTED)时触发。',
    '关键 step:',
    '  1) check-pause',
    '  2) 从 RAAS GET /api/v1/requirements/{id} 拉 raw_input_data',
    '  3) 调 RAAS POST /api/v1/generate-jd(透传 RoboHire LLM)生成 JD 草稿',
    '  4) 投影成 partner-canonical 形状(title / posting_description / hard_requirements / nice_to_have ...)',
    '  5) 调 RAAS POST /api/v1/jd/sync-generated 持久化',
    '  6) emit JD_GENERATED 通知下游 reviewer / publisher',
    '常见失败:LLM gateway timeout / RAAS 4xx / prompt 不合规',
  ].join('\n'),
  'agentic-operator-main-match-resume-agent': [
    '功能职责:候选人 - JR 匹配打分。当 ResumeParser 发出 RESUME_PROCESSED 后触发。',
    '关键 step:',
    '  1) check-pause',
    '  2) build-resume-text:从 parsed.data 拍平成 plain text 喂给 /match-resume',
    '  3) fetch JR 列表:如果事件带 job_requisition_id 就只匹配该 1 个;否则拉员工名下所有 recruiting JR',
    '  4) 对每个 JR 调 RAAS POST /api/v1/match-resume(透传 RoboHire)算 score',
    '  5) 调 RAAS POST /api/v1/match-results 持久化(source="need_interview")',
    '  6) em-audit-match-X:经 EM gateway 发审计型 MATCH_PASSED_NEED_INTERVIEW',
    '  7) emit-match-X:发实际事件',
    '现在版本:RoboHire data.matchScore 顶级永远 null,真实评分在 data.overallMatchScore.score(0-100)。verdict 在 data.overallFit.verdict("Strong Match" 等自然语言)。',
  ].join('\n'),
};

export function staticSummaryFor(input: AgentSummaryInput): string {
  return (
    STATIC[input.slug] ??
    `${input.name} 监听 ${input.triggers.join(' / ')} 事件。近 24h 跑了 ${input.stats.total} 次,成功率 ${input.stats.successRate ?? '?'}%。`
  );
}
