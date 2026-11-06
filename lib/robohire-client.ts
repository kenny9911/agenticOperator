// AO ↔ RoboHire direct client.
//
// AO 不再通过 RAAS API Server 的 transparent-proxy 端点(/api/v1/parse-resume,
// /api/v1/match-resume) 调 RoboHire,改成直连 https://api.robohire.io。
//
// 仅 RoboHire-能力直连;持久化端点(/candidates, /match-results, /jd/sync-generated)
// 仍走 RAAS API Server,因为它们写 Postgres,RAAS 是 source of truth。
//
// 见 docs/superpowers/specs/2026-05-19-rule-check-independent-agent-design.md §3。
//
// 2026-05-21 — 每次 RoboHire 调用通过 currentLogger().apiCall(...) 落 file
// log 一行,terminal 同步 echo。这样 matchResume / parseResume / generateJd
// 的完整 request + response JSON 都能事后查。
//
// 2026-05-26 — currentLogger() 依赖 AsyncLocalStorage,而 Inngest step.run 在
// replay/retry 时不保留 ALS context → apiCall 静默 noop. 2026-05-25 陈昊_前端
// 简历.pdf 被 RoboHire 解析返 name="性别" 但 file log 一条都没,partner-pg 已
// 被污染才发现 — 整个 RoboHire 响应是黑盒. 加独立的 robohire-<date>.log sink,
// 直接 fs.appendFile,不依赖 ALS,绝不能被吞掉. agent logger 路径保留(并行)。
//
//   Sink 文件: logs/robohire-YYYY-MM-DD.log   (覆盖 AO_LOG_DIR env)
//   每行 1 个 JSON: { ts, label, url, method, status, duration_ms, request, response/error }
//   全字段 in/out — 不 truncate, 不 cherry-pick.

import { currentLogger, type AgentLogger } from './agent-logger';
import { logApiCall } from './external-api-log';

const DEFAULT_TIMEOUT_MS = 300_000;

/** Shared apiCall wrapper — logs request + response (or error) for every RoboHire op. */
async function instrumentedFetch<T>(
  label: string,
  url: string,
  method: 'GET' | 'POST',
  request: unknown,
  fetchFn: () => Promise<Response>,
  parse: (res: Response) => Promise<T>,
  traceId?: string,
  loggerOverride?: AgentLogger | null,
): Promise<T> {
  // 2026-05-27 — 优先用 agent 显式传入的 fileLogger(闭包,带 run_id,Inngest
  // step.run 内部也稳定);ALS-based currentLogger() 在 step.run 里不可靠.
  // 显式 logger → api.* 调用进 per-run 审计日志(/api/audit/runs 能 join).
  const logger = loggerOverride ?? currentLogger();
  const start = Date.now();
  let res: Response;
  try {
    res = await fetchFn();
  } catch (err) {
    // 独立 sink — 必落,绕过 ALS,失败路径
    logApiCall({
      category: 'robohire',
      label,
      url,
      method,
      trace_id: traceId ?? logger?.ctx?.traceId ?? null,
      agent: logger?.ctx?.agent ?? null,
      run_id: logger?.ctx?.runId ?? null,
      duration_ms: Date.now() - start,
      request,
      error: (err as Error).message,
    });
    logger?.apiCall(label, {
      url,
      method,
      request,
      durationMs: Date.now() - start,
      error: (err as Error).message,
    });
    throw err;
  }
  const status = res.status;
  // We need to read the body once for both logging and the caller's parser.
  // Clone the response so the parse() helper sees a fresh stream.
  const cloned = res.clone();
  let responseBody: unknown = null;
  try {
    responseBody = await cloned.json();
  } catch {
    try {
      responseBody = await cloned.text();
    } catch {
      responseBody = null;
    }
  }
  // 独立 sink — 必落,绕过 ALS,完整 in/out
  logApiCall({
    category: 'robohire',
    label,
    url,
    method,
    trace_id: traceId ?? logger?.ctx?.traceId ?? null,
    agent: logger?.ctx?.agent ?? null,
    run_id: logger?.ctx?.runId ?? null,
    status,
    duration_ms: Date.now() - start,
    request,
    response: responseBody,
  });
  // Agent logger 兜底(ALS context 在的话同步一份)
  logger?.apiCall(label, {
    url,
    method,
    request,
    status,
    durationMs: Date.now() - start,
    response: responseBody,
  });
  return parse(res);
}

function config(): { baseUrl: string; apiKey: string; timeoutMs: number } {
  const baseUrl = process.env.ROBOHIRE_API_BASE_URL?.trim();
  const apiKey = process.env.ROBOHIRE_API_KEY?.trim();
  if (!baseUrl) throw new RobohireApiError(0, 'CLIENT', 'ROBOHIRE_API_BASE_URL not set');
  if (!apiKey) throw new RobohireApiError(0, 'CLIENT', 'ROBOHIRE_API_KEY not set');
  const timeoutMs = Number(process.env.ROBOHIRE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  return { baseUrl, apiKey, timeoutMs };
}

export class RobohireApiError extends Error {
  constructor(
    public httpStatus: number,
    public code: 'CLIENT' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED' | 'SERVER' | 'NETWORK' | 'UNPARSEABLE',
    message: string,
    public requestId?: string,
  ) {
    super(message);
    this.name = 'RobohireApiError';
  }
  /** 4xx (except 429) — caller should NonRetriable. */
  get isClientError(): boolean {
    return this.httpStatus >= 400 && this.httpStatus < 500 && this.httpStatus !== 429;
  }
  /**
   * 400/422 — our own request is malformed (prompt too long / invalid input).
   * This is an AO-side bug, NOT a vendor health problem, so the caller should fail
   * the run WITHOUT recording a RoboHire dependency-degraded signal. 401/403 are
   * auth (real vendor/credential issue) and deliberately excluded.
   */
  get isBadRequest(): boolean {
    return this.httpStatus === 400 || this.httpStatus === 422;
  }
}

function statusToCode(status: number): RobohireApiError['code'] {
  if (status === 402) return 'QUOTA_EXHAUSTED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER';
  if (status >= 400) return 'CLIENT';
  return 'SERVER';
}

/**
 * True when RoboHire's error message says the *document itself* can't be parsed
 * (image-only / scanned / corrupt / unsupported PDF — no extractable text). This
 * is a content problem RoboHire reports truthfully; it is NOT a vendor outage and
 * must never be coded SERVER (which dependency-health treats as a recoverable
 * RoboHire degradation worth parking + auto-retrying — but this same document
 * will fail identically forever). Only meaningful for parse-resume.
 */
function isUnparseableDocMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return (
    /extraction\s+failed/.test(m) ||
    (/no\s+text/.test(m) && /extract/.test(m)) ||
    /no\s+extractable\s+text/.test(m) ||
    /could\s*n[o']?t?\s+extract/.test(m) ||
    /unparse?able/.test(m) ||
    /corrupt(ed)?\s+(file|pdf|document)/.test(m) ||
    /unsupported\s+(file|format|document)/.test(m)
  );
}

export type CommonOpts = {
  traceId?: string;
  timeoutMs?: number;
  /**
   * 2026-05-27 — agent 显式传入的 fileLogger. 让 RoboHire 调用的完整 in/out 进
   * per-run 审计日志(带 run_id). Inngest step.run 内部 ALS 不可靠,不传则
   * api.RoboHire.* 只落独立 sink(robohire-*.log,无 run_id),审计页 join 不到.
   */
  logger?: AgentLogger | null;
};

// ─── parse-resume ───────────────────────────────────────────────

export type RobohireParseResumeData = {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  experience?: Array<{
    title?: string; company?: string; location?: string;
    startDate?: string; endDate?: string;
    description?: string; highlights?: string[];
  }>;
  education?: Array<{
    degree?: string; field?: string; institution?: string; graduationYear?: string;
  }>;
  skills?: string[];
  certifications?: string[];
  languages?: Array<{ language?: string; proficiency?: string }>;
  [k: string]: unknown;
};

export type RobohireParseResumeResponse = {
  data: RobohireParseResumeData;
  cached: boolean;
  documentId?: string;
  savedAs?: string;
  requestId: string;
};

export async function parseResumeDirect(
  pdf: Buffer,
  filename: string,
  opts: CommonOpts = {},
): Promise<RobohireParseResumeResponse> {
  const { baseUrl, apiKey, timeoutMs } = config();
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), filename);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (opts.traceId) headers['X-Trace-Id'] = opts.traceId;

  const url = `${baseUrl}/api/v1/parse-resume`;
  // Logged request body is a metadata-only summary (we can't serialize the
  // multipart form bytes meaningfully; PDF blob would dump base64 noise).
  const requestSummary = { filename, pdf_bytes: pdf.length, trace_id: opts.traceId ?? null };
  return instrumentedFetch(
    'RoboHire.parseResume',
    url,
    'POST',
    requestSummary,
    () =>
      fetch(url, {
        method: 'POST',
        headers,
        body: form,
        signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
      }).catch((e) => {
        throw new RobohireApiError(0, 'NETWORK', `parse-resume fetch failed: ${(e as Error).message}`);
      }),
    (res) => handleJsonResponse<RobohireParseResumeResponse>(res, 'parse-resume'),
    opts.traceId,
    opts.logger,
  );
}

// ─── match-resume ───────────────────────────────────────────────

export type RobohireMatchResumeInput = {
  resume: string;
  jd: string;
  candidatePreferences?: string;
  jobMetadata?: string;
  /**
   * 匹配分析输出语言 — RoboHire 据此决定 summary / analysis 文本语言。
   * 调用方不显式指定时,matchResumeDirect 统一回填 'zh'(中文)。可传 'en' 等覆盖。
   */
  locale?: string;
};

export type RobohireMatchResumeData = {
  matchScore: number;
  recommendation: 'STRONG_MATCH' | 'GOOD_MATCH' | 'PARTIAL_MATCH' | 'WEAK_MATCH';
  summary: string;
  matchAnalysis?: Record<string, unknown>;
  mustHaveAnalysis?: Record<string, unknown>;
  niceToHaveAnalysis?: Record<string, unknown>;
  [k: string]: unknown;
};

export type RobohireMatchResumeResponse = {
  data: RobohireMatchResumeData;
  requestId: string;
  savedAs?: string;
};

export async function matchResumeDirect(
  input: RobohireMatchResumeInput,
  opts: CommonOpts = {},
): Promise<RobohireMatchResumeResponse> {
  const { baseUrl, apiKey, timeoutMs } = config();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (opts.traceId) headers['X-Trace-Id'] = opts.traceId;

  const url = `${baseUrl}/api/v1/match-resume`;
  // /api/v1/match-resume 入参统一补 locale,默认 'zh' —— 调用方未显式指定时
  // 一律按中文输出匹配分析,可经 input.locale 覆盖(如 'en')。在 HTTP 边界单点
  // 回填,覆盖所有调用方(当前生产链路 matchResumeAgent + 未来新调用方)。(partner-pg 79a6257)
  const body = { ...input, locale: input.locale ?? 'zh' };
  return instrumentedFetch(
    'RoboHire.matchResume',
    url,
    'POST',
    body,
    () =>
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
      }).catch((e) => {
        throw new RobohireApiError(0, 'NETWORK', `match-resume fetch failed: ${(e as Error).message}`);
      }),
    (res) => handleJsonResponse<RobohireMatchResumeResponse>(res, 'match-resume'),
    opts.traceId,
    opts.logger,
  );
}

// ─── jobs/generate-jd ───────────────────────────────────────────

export type RobohireGenerateJdInput = {
  /** Free-text prompt 4-4000 chars per RoboHire spec */
  prompt: string;
  language?: 'en' | 'zh' | 'zh-TW' | 'ja' | 'es' | 'fr' | 'pt' | 'de';
  companyName?: string;
  department?: string;
};

/**
 * RoboHire generate-jd 响应 — combined parse+generate one-call.
 * Response field set verified by live probe 2026-05-19.
 */
export type RobohireGenerateJdData = {
  title?: string;
  companyName?: string;
  department?: string;
  location?: string;
  workType?: string;
  employmentType?: string;
  experienceLevel?: string;
  education?: string;
  headcount?: number | string;
  qualifications?: string;
  hardRequirements?: string;
  niceToHave?: string;
  description?: string;
  benefits?: string;
  interviewRequirements?: string;
  evaluationRules?: string;
  salaryMin?: string | number;
  salaryMax?: string | number;
  salaryCurrency?: string;
  salaryPeriod?: string;
  salaryText?: string;
  [k: string]: unknown;
};

export type RobohireGenerateJdResponse = {
  data: RobohireGenerateJdData;
  meta?: { stages?: { parse?: string; generate?: string } };
  requestId: string;
};

export async function generateJdDirect(
  input: RobohireGenerateJdInput,
  opts: CommonOpts = {},
): Promise<RobohireGenerateJdResponse> {
  const { baseUrl, apiKey, timeoutMs } = config();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (opts.traceId) headers['X-Trace-Id'] = opts.traceId;

  const url = `${baseUrl}/api/v1/jobs/generate-jd`;
  const resp = await instrumentedFetch(
    'RoboHire.generateJd',
    url,
    'POST',
    input,
    () =>
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
      }).catch((e) => {
        throw new RobohireApiError(0, 'NETWORK', `jobs/generate-jd fetch failed: ${(e as Error).message}`);
      }),
    (res) => handleJsonResponse<RobohireGenerateJdResponse>(res, 'jobs/generate-jd'),
    opts.traceId,
    opts.logger,
  );
  // Contract-faithful: generate-jd's two internal stages (parse, generate) are
  // NON-FATAL. A degraded stage still returns a usable response — parse-fail →
  // generate ran off the raw prompt (real body, raw-prompt title); generate-fail →
  // parse's structured fields are still returned. The docs say to read
  // `meta.stages` to see which succeeded, NOT to treat a failed stage as a failed
  // call. So the transport client returns the response verbatim (stages and all);
  // whether the *content* is usable is the caller's decision, owned by
  // classifyRobohire (the single source of truth for "is this payload usable").
  // Throwing on stage status here would discard a parse-fail-but-generate-ok JD
  // that is fully usable. handleJsonResponse still rejects transport faults +
  // envelope `success: false`.
  return resp;
}

// ─── invite-candidate ───────────────────────────────────────────
//
// POST /api/v1/invite-candidate
// 触发 RoboHire 在 GoHire 端为候选人开一个 AI 视频面试入口(login_url +
// qrcode_url),并把请求/响应记录到 RoboHire 自有的 Interview/HiringRequest
// 表。AO 这边收到 _SENT 事件后会再把 Interview_Record + Communication_Log
// 写到 Neo4j 通过 allmeta。
//
// 入参契约:
//   - (resume OR resume_id) 必带其一:resume 为简历纯文本;resume_id 为
//     已注册到 RoboHire 的 Resume.id(会 server-side 加载 resumeText +
//     parsedData)。
//   - (jd OR job_id) 必带其一:jd 为 JD 纯文本;job_id 为已注册到 RoboHire
//     的 Job.id(server-side 解析 title/description/duration/language)。
// 其它字段全可选,可覆盖 server-side 推断值。
//
// 返回 data 在 fresh-invite 路径含 login_url/qrcode_url/user_id 等
// candidate-facing 入口字段;在 dedup-hit 路径会带 `reused:true` 复用之前的
// invite。两种情况字段集基本一致,agent 端无需区分。

export type RobohireInviteCandidateInput = {
  // 二选一(resume / resume_id)
  resume?: string;
  resume_id?: string;
  // 二选一(jd / job_id)
  jd?: string;
  job_id?: string;
  // 可选
  hiring_request_id?: string;
  candidate_email?: string;
  recruiter_email?: string;
  interviewer_requirement?: string;
  job_title?: string;
  company_name?: string;
  interview_language?: 'en' | 'zh' | 'ja';
  /** Minutes, > 0;default Job.interviewDuration → 30. */
  interview_duration?: number;
  /** e.g. 'ai_video';RoboHire 仅落 Interview.metadata.inviteConfig. */
  interview_mode?: string;
  /** 0-100;RoboHire-side post-interview gate. */
  passing_score?: number;
  /** 字面 "null" 字符串会清掉 Job 层级的默认绑定. */
  linked_assessment_id?: string;
};

export type RobohireInviteCandidateData = {
  /** dedup hit 时 server 会返回这个标记;fresh invite 此字段不存在. */
  reused?: boolean;
  email?: string;
  name?: string;
  login_url?: string;
  qrcode_url?: string;
  /** Fresh-invite 是 number,dedup-hit 可能是 string. */
  user_id?: number | string;
  request_introduction_id?: string;
  company_name?: string;
  job_title?: string;
  /** 实际生效的面试时长(分钟). */
  job_interview_duration?: number;
  gohire_job_id?: number | string;
  message?: string;
  resumeId?: string;
  hiringRequestId?: string;
  /**
   * RoboHire 透传 GoHire 那一跳的完整 req/res — 出问题用来 forensic.
   * Shape: { provider, endpoint, method, requestBody, responseBody }
   */
  gohireInviteLog?: Record<string, unknown>;
  /**
   * 200 + 这个字段非空 = "邀请送出,但 RoboHire 自己的 DB 落库失败";
   * 不算 fatal,但应当 emit _FAILED(error_code=PERSISTENCE_WARNING)让
   * RAAS 端知情,因为这条 RoboHire 侧不会自动对账。
   */
  persistenceWarning?: string;
  [k: string]: unknown;
};

export type RobohireInviteCandidateResponse = {
  data: RobohireInviteCandidateData;
  requestId: string;
  /** RoboHire 包了 envelope,success/error 字段在 handleJsonResponse 已校验. */
  success?: boolean;
};

export async function inviteCandidateDirect(
  input: RobohireInviteCandidateInput,
  opts: CommonOpts = {},
): Promise<RobohireInviteCandidateResponse> {
  // 二选一字段校验 — 早 fail 比 RoboHire 返 400 后再翻 response 清晰得多.
  if (!input.resume && !input.resume_id) {
    throw new RobohireApiError(0, 'CLIENT', 'invite-candidate: resume 或 resume_id 至少给一个');
  }
  if (!input.jd && !input.job_id) {
    throw new RobohireApiError(0, 'CLIENT', 'invite-candidate: jd 或 job_id 至少给一个');
  }

  const { baseUrl, apiKey, timeoutMs } = config();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (opts.traceId) headers['X-Trace-Id'] = opts.traceId;

  const url = `${baseUrl}/api/v1/invite-candidate`;
  return instrumentedFetch(
    'RoboHire.inviteCandidate',
    url,
    'POST',
    input,
    () =>
      fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
      }).catch((e) => {
        throw new RobohireApiError(0, 'NETWORK', `invite-candidate fetch failed: ${(e as Error).message}`);
      }),
    (res) => handleJsonResponse<RobohireInviteCandidateResponse>(res, 'invite-candidate'),
    opts.traceId,
    opts.logger,
  );
}

// ─── shared response handler ────────────────────────────────────

async function handleJsonResponse<T>(res: Response, op: string): Promise<T> {
  let body: any;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const errMsg = body?.error ?? `${op} ${res.status} ${res.statusText}`;
    // A parse-resume failure whose message says the document has no extractable
    // text is a content problem, not a vendor one — code it UNPARSEABLE so the
    // agent fails it terminally without polluting RoboHire's health signal.
    const code =
      op === 'parse-resume' && typeof body?.error === 'string' && isUnparseableDocMessage(body.error)
        ? 'UNPARSEABLE'
        : statusToCode(res.status);
    throw new RobohireApiError(res.status, code, errMsg, body?.requestId);
  }

  if (!body || body.success === false) {
    const errMsg = body?.error ?? 'unknown';
    const code =
      op === 'parse-resume' && typeof errMsg === 'string' && isUnparseableDocMessage(errMsg)
        ? 'UNPARSEABLE'
        : 'SERVER';
    throw new RobohireApiError(
      res.status,
      code,
      `${op} returned success=false: ${errMsg}`,
      body?.requestId,
    );
  }

  return body as T;
}
