// RAAS API client for agentic-operator agents.
//
// Wraps every endpoint defined in agentic-operator-onboarding(3).md.
// All agent-side calls to RoboHire / persistence / requirements lookup
// MUST go through this client (never direct to api.robohire.io).
//
// Endpoint catalog (per doc §1):
//   Capability proxies (sync passthrough to RoboHire):
//     POST /api/v1/parse-resume       (multipart)
//     POST /api/v1/match-resume       (json)
//     POST /api/v1/generate-jd        (json)
//     POST /api/v1/invite-interview   (json) — currently 501
//   Persistence (write to raas DB):
//     POST /api/v1/candidates
//     POST /api/v1/jd/sync-generated
//     POST /api/v1/match-results
//   Read-only:
//     GET  /api/v1/requirements/agent-view
//
// Auth: every request carries Authorization: Bearer ${AGENT_API_KEY}.
// Trace: optional X-Trace-Id request header; raas mints one if absent
// and echoes it on response headers (we capture both directions).
//
// Errors: raas returns a uniform envelope on failure
//   { success: false, error, code, requestId, traceId }
// We translate that into RaasApiError carrying status + code so callers
// can branch by code (AGENT_AUTH_INVALID / RATE_LIMITED / etc).

const TIMEOUT_MS_DEFAULT = 120_000; // RoboHire match-resume can take ~120s

// ─── Errors ─────────────────────────────────────────────────────────

/** Thrown for any non-2xx HTTP response or success:false body. */
export class RaasApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public traceId?: string,
  ) {
    super(
      `RAAS API ${status} ${code}: ${message}` +
        (requestId ? ` (req=${requestId})` : '') +
        (traceId ? ` (trace=${traceId})` : ''),
    );
    this.name = 'RaasApiError';
  }

  /**
   * Whether retrying with the same body has any chance of succeeding.
   * Per doc §5/§6: 429 + 502 + 504 are network-shaped and retryable;
   * 4xx (auth / payload / quota) are agent's responsibility to fix.
   */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 502 || this.status === 504;
  }

  /** Doc §5 'INVALID_*' / 'MISSING_FIELD' / 'PROMPT_LENGTH'. agent payload bug. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 429;
  }
}

// ─── Configuration (read lazily so tests can override env) ──────────

function config() {
  const baseUrl = process.env.RAAS_API_BASE_URL?.trim() ?? '';
  const agentKey = process.env.AGENT_API_KEY?.trim() ?? '';
  if (!baseUrl) {
    throw new RaasApiError(0, 'CONFIG', 'RAAS_API_BASE_URL not set in env');
  }
  if (!agentKey) {
    throw new RaasApiError(0, 'CONFIG', 'AGENT_API_KEY not set in env');
  }
  return { baseUrl, agentKey };
}

export function isRaasApiConfigured(): boolean {
  return (
    !!process.env.RAAS_API_BASE_URL?.trim() &&
    !!process.env.AGENT_API_KEY?.trim()
  );
}

// ─── Common types ───────────────────────────────────────────────────

export type CommonOpts = {
  /**
   * Optional X-Trace-Id to propagate. If absent, raas mints one and
   * returns it in the response header (we surface it via the response
   * object so callers can log it).
   */
  traceId?: string;
  /** Per-request timeout. Default 120000 (RoboHire upper bound). */
  timeoutMs?: number;
};

/** What the response wrapper exposes for every call. */
type RaasResponse = {
  /** raas requestId (= RoboHire's upstream requestId for proxy endpoints). */
  requestId?: string;
  /** trace_id from response header — log this for cross-service joins. */
  traceId?: string;
};

// ─── 4.1 parse-resume ───────────────────────────────────────────────

/**
 * RoboHire's parsed-resume `data` shape, kept opaque to tolerate
 * upstream evolution. Real fields documented in api-external-resume-
 * parsing-and-matching.md §2.
 */
export type RaasParseResumeData = {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  experience?: Array<Record<string, unknown>>;
  education?: Array<Record<string, unknown>>;
  skills?: string[] | Record<string, unknown>;
  languages?: Array<Record<string, unknown>>;
  certifications?: Array<Record<string, unknown>>;
  rawText?: string;
  [k: string]: unknown;
};

export type ParseResumeResponse = RaasResponse & {
  data: RaasParseResumeData;
  /** RoboHire content-hash cache hit — true means no LLM quota was used. */
  cached: boolean;
  documentId?: string;
  savedAs?: string;
};

export async function parseResume(
  pdfBuffer: Buffer,
  filename: string,
  opts: CommonOpts = {},
): Promise<ParseResumeResponse> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' }),
    filename || 'resume.pdf',
  );
  const body = await doRequest('POST', '/api/v1/parse-resume', { body: form }, opts);
  return {
    data: body.data ?? {},
    cached: body.cached === true,
    documentId: body.documentId,
    savedAs: body.savedAs,
    requestId: body.requestId,
    traceId: body._traceId,
  };
}

// ─── 4.X candidates/:id/resumes/:rid/parsed — thin event back-pull (F1, 2026-05-19) ───
//
// Partner sends thin RESUME_PROCESSED events (no parsed.data inline).
// Agent calls this to fetch the parsed resume body from RAAS DB when needed.
// See: docs/superpowers/specs/2026-05-19-raas-integration-divergence-fixes-design.md §2

export type ParsedResumeResponse = {
  candidate_id: string;
  resume_id: string;
  /** RoboHire-shape parsed data: name, email, experience, education, skills, etc. */
  data: Record<string, unknown>;
  candidate_snapshot?: Record<string, unknown>;
  resume_meta?: Record<string, unknown>;
  requestId?: string;
  traceId?: string;
};

export async function getParsedResume(
  candidateId: string,
  resumeId: string,
  opts: CommonOpts = {},
): Promise<ParsedResumeResponse> {
  if (!candidateId?.trim()) {
    throw new RaasApiError(0, 'CLIENT', 'getParsedResume: candidateId required');
  }
  if (!resumeId?.trim()) {
    throw new RaasApiError(0, 'CLIENT', 'getParsedResume: resumeId required');
  }
  const path = `/api/v1/candidates/${encodeURIComponent(candidateId.trim())}/resumes/${encodeURIComponent(resumeId.trim())}/parsed`;
  const body = await doRequest('GET', path, {}, opts);
  // Response is top-level direct (not wrapped in { success, data })
  return {
    candidate_id: typeof body.candidate_id === 'string' ? body.candidate_id : candidateId,
    resume_id: typeof body.resume_id === 'string' ? body.resume_id : resumeId,
    data: (body.data && typeof body.data === 'object') ? (body.data as Record<string, unknown>) : {},
    candidate_snapshot: body.candidate_snapshot,
    resume_meta: body.resume_meta,
    requestId: body.requestId,
    traceId: body._traceId,
  };
}

// ─── 4.2 match-resume ───────────────────────────────────────────────

export type RaasMatchResumeData = {
  matchScore: number;
  recommendation: 'STRONG_MATCH' | 'GOOD_MATCH' | 'PARTIAL_MATCH' | 'WEAK_MATCH';
  summary?: string;
  matchAnalysis?: Record<string, unknown>;
  mustHaveAnalysis?: Record<string, unknown>;
  niceToHaveAnalysis?: Record<string, unknown>;
  [k: string]: unknown;
};

export type MatchResumeInput = {
  resume: string;
  jd: string;
  candidatePreferences?: string;
  jobMetadata?: string;
};

export type MatchResumeResponse = RaasResponse & {
  data: RaasMatchResumeData;
  savedAs?: string;
};

export async function matchResume(
  input: MatchResumeInput,
  opts: CommonOpts = {},
): Promise<MatchResumeResponse> {
  const body = await doJsonRequest('POST', '/api/v1/match-resume', input, opts);
  return {
    data: body.data,
    savedAs: body.savedAs,
    requestId: body.requestId,
    traceId: body._traceId,
  };
}

// ─── 4.3 generate-jd ────────────────────────────────────────────────
// (Migrated 2026-05-19 PR-4 to lib/robohire-client.ts:generateJdDirect.
//  RAAS API Server's /generate-jd was a transparent proxy to RoboHire;
//  AO now calls RoboHire /api/v1/jobs/generate-jd directly.)

// ─── 4.8 resumes/uploads/:upload_id/raw — 拉原始 PDF 字节 ──────────
//
// doc v7 §4.8: agent 收到 RESUME_DOWNLOADED 事件后,按 upload_id 拉
// 原始 PDF 字节,自己包 multipart 调 POST /api/v1/parse-resume,再调
// POST /api/v1/candidates 落库.
//
// 为什么不能直接读 event payload 里的 parsed.data:
//   raas 在事件里**不**预先 parse —— 按 ADR-0011 边界, parse-resume 是
//   raas 提供的"加工能力", 编排 (何时 parse / parse 失败兜底 / parse
//   结果如何写库) 是 agent 责任. 事件 payload 只带上传元数据
//   (upload_id / bucket / object_key / etag / filename / operator_*).

export type DownloadResumeRawResponse = {
  /** 原始 PDF 字节. */
  pdf: Buffer;
  /** Content-Type from response header (一般是 application/pdf). */
  contentType: string;
  /** 从 Content-Disposition 解析的 filename, 可能 undefined. */
  filename?: string;
  /** trace_id from response header. */
  traceId?: string;
};

/**
 * GET /api/v1/resumes/uploads/:upload_id/raw — 拉原始 PDF 字节.
 *
 * 直接返回 application/pdf 字节流, 不是 JSON envelope. 调用者负责
 * 把返回的 Buffer 喂给 parseResume(buffer, filename, opts).
 */
export async function downloadResumeRaw(
  uploadId: string,
  opts: CommonOpts = {},
): Promise<DownloadResumeRawResponse> {
  if (!uploadId || !uploadId.trim()) {
    throw new RaasApiError(0, 'CLIENT', 'downloadResumeRaw: uploadId required');
  }

  const { baseUrl, agentKey } = config();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${agentKey}`,
  };
  if (opts.traceId) headers['X-Trace-Id'] = opts.traceId;

  const url = `${baseUrl}/api/v1/resumes/uploads/${encodeURIComponent(uploadId.trim())}/raw`;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS_DEFAULT;

  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const responseTraceId =
    res.headers.get('x-trace-id') ?? res.headers.get('X-Trace-Id') ?? undefined;

  if (!res.ok) {
    // 错误 body 可能是 JSON envelope, 也可能是空/text. 尝试 parse,失败用兜底.
    type RaasErrEnvelope = { code?: string; error?: string; requestId?: string; traceId?: string };
    let errorBody: RaasErrEnvelope = {};
    try {
      const j = (await res.json()) as RaasErrEnvelope;
      if (j && typeof j === 'object') errorBody = j;
    } catch {
      // ignore — non-JSON error response
    }
    throw new RaasApiError(
      res.status,
      errorBody.code ?? `HTTP_${res.status}`,
      errorBody.error ?? `download raw resume failed (upload_id=${uploadId})`,
      errorBody.requestId,
      errorBody.traceId ?? responseTraceId,
    );
  }

  const arrayBuf = await res.arrayBuffer();
  const pdf = Buffer.from(arrayBuf);

  // Content-Disposition: inline; filename="zhangsan_resume.pdf"
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  const filename = m ? decodeURIComponent(m[1]) : undefined;

  return {
    pdf,
    contentType: res.headers.get('content-type') ?? 'application/pdf',
    filename,
    traceId: responseTraceId,
  };
}

// ─── 4.4 invite-interview (currently 501) ───────────────────────────

export type InviteInterviewInput = {
  candidate_id: string;
  candidate_name: string;
  candidate_email: string;
  candidate_phone?: string;
  job_requisition_id?: string;
  job_title: string;
  invite_window_days?: number;
};

export async function inviteInterview(
  input: InviteInterviewInput,
  opts: CommonOpts = {},
): Promise<RaasResponse & { data: unknown }> {
  const body = await doJsonRequest('POST', '/api/v1/invite-interview', input, opts);
  return { data: body.data, requestId: body.requestId, traceId: body._traceId };
}

// ─── 4.5 candidates persist ─────────────────────────────────────────

export type SaveCandidateInput = {
  upload_id: string;
  bucket: string;
  object_key: string;
  etag?: string;
  mime_type?: string;
  file_size?: number;
  original_filename?: string;
  operator_employee_id?: string;
  operator_id?: string;
  client_id?: string;
  job_requisition_id?: string;
  /** RoboHire /parse-resume `data` payload, spread directly. */
  parsed: RaasParseResumeData;
  /** Upstream RoboHire requestId for cross-service tracing. */
  robohire_request_id?: string;
};

export type SaveCandidateResult = {
  candidate_id: string;
  candidate_name?: string;
  resume_id?: string;
  resume_file_path?: string;
  application_id?: string;
  is_new_candidate?: boolean;
  is_new_resume?: boolean;
};

export async function saveCandidate(
  input: SaveCandidateInput,
  opts: CommonOpts = {},
): Promise<SaveCandidateResult & RaasResponse> {
  const body = await doJsonRequest('POST', '/api/v1/candidates', input, opts);
  return { ...(body.data as SaveCandidateResult), requestId: body.requestId, traceId: body._traceId };
}

// ─── 4.6 jd/sync-generated persist ──────────────────────────────────

/**
 * sync-generated 入参 — handler **同时接受 camelCase（RoboHire 原始）和
 * snake_case（raas 内部）**（doc v5 §4.6 2026-05-08 起）。最便捷的写法是
 * 拿到 generate-jd 的 data 直接 spread:
 *
 *   await syncJdGenerated({
 *     job_requisition_id, client_id,
 *     ...generateJdResult.data,    // ← RoboHire camelCase 全部带过去
 *     // (可选) 额外补 snake_case 增强字段:
 *     must_have_skills, nice_to_have_skills, expected_level, ...
 *   })
 *
 * 字段语义对照 (节选, 完整见 doc §4.6 表):
 *   title           / posting_title         → JobPosting.posting_title
 *   description     / posting_description   → JobPosting.posting_description
 *   salaryText      / salary_text           → JobPosting.salary_range
 *   salaryMin       / salary_min            → JobPosting.salary_range_monthly_min
 *   salaryMax       / salary_max            → JobPosting.salary_range_monthly_max
 *   salaryCurrency  / salary_currency       → JobPosting.salary_currency
 *   salaryPeriod    / salary_period         → JobPosting.salary_period
 *   qualifications                          → JobRequisition.qualifications
 *   hardRequirements / hard_requirements    → JobRequisition.hard_requirements
 *   niceToHave      / nice_to_have          → JobRequisition.nice_to_have
 *   interviewRequirements / interview_requirements → JobRequisition.interview_requirements
 *   evaluationRules / evaluation_rules      → JobRequisition.evaluation_rules
 *   must_have_skills, nice_to_have_skills, negative_requirement,
 *   language_requirements, expected_level, degree_requirement,
 *   education_requirement, work_years, interview_mode, recruitment_type → JobRequisition.*
 *   city (string[]) → JobPosting.city (取 [0])
 *   search_keywords (string[]) → JobPosting.search_keywords (前 5)
 *
 * 未持久化（doc 列出，handler 忽略，agent 可不传）:
 *   companyName · department · location · workType · employmentType ·
 *   experienceLevel · education · benefits · meta.stages.*
 */
export type SyncJdInput = {
  // ── 必填 ──
  job_requisition_id: string;
  client_id: string;

  // ── RoboHire camelCase (来自 generate-jd data，spread 即可) ──
  title?: string;
  description?: string;
  qualifications?: string;
  hardRequirements?: string;
  niceToHave?: string;
  interviewRequirements?: string;
  evaluationRules?: string;
  benefits?: string;
  salaryMin?: number | string;
  salaryMax?: number | string;
  salaryCurrency?: string;
  salaryPeriod?: string;
  salaryText?: string;
  headcount?: number | string;
  experienceLevel?: string;
  education?: string;
  employmentType?: string;
  location?: string;
  workType?: string;
  companyName?: string;
  department?: string;

  // ── raas snake_case (内部惯例 + 可选增强) ──
  posting_title?: string;
  posting_description?: string;
  must_have_skills?: string[];
  nice_to_have_skills?: string[];
  negative_requirement?: string;
  language_requirements?: string;
  expected_level?: string;
  degree_requirement?: string;
  education_requirement?: string;
  work_years?: number;
  interview_mode?: string;
  recruitment_type?: string;
  city?: string[];
  salary_range?: string;
  search_keywords?: string[];
  /** legacy fallback — handler 仅读 .title / .salaryBenefits */
  jd_content?: Record<string, unknown>;

  // ── 允许额外字段（spread RoboHire data 时可能带入未来新字段）──
  [key: string]: unknown;
};

export type SyncJdResult = {
  synced: boolean;
  job_posting_id: string;
  job_requisition_id: string;
};

export async function syncJdGenerated(
  input: SyncJdInput,
  opts: CommonOpts = {},
): Promise<SyncJdResult & RaasResponse> {
  const body = await doJsonRequest('POST', '/api/v1/jd/sync-generated', input, opts);
  return { ...(body.data as SyncJdResult), requestId: body.requestId, traceId: body._traceId };
}

// ─── 4.7 match-results persist ──────────────────────────────────────

/**
 * /api/v1/match-results 单条 item.
 *
 * doc 推荐写法（跟 §4.6 sync-generated 一样）: 拿到 RoboHire /match-resume
 * `data` 后**整段 spread**, agent 不需要 cherry-pick 字段名:
 *
 *   await saveMatchResults({
 *     source: 'need_interview',
 *     candidate_id, upload_id, job_requisition_id, client_id,
 *     ...matchResult.data,    // ← RoboHire 全 20+ 字段透传
 *   })
 *
 * RoboHire /match-resume 实际返回的字段（partner 文档 2026-05-08 验证）:
 *   resumeAnalysis · jdAnalysis · mustHaveAnalysis · niceToHaveAnalysis ·
 *   skillMatch · skillMatchScore · experienceMatch · experienceValidation ·
 *   candidatePotential · transferableSkills · experienceBreakdown ·
 *   hardRequirementGaps · overallMatchScore · overallFit · recommendations ·
 *   suggestedInterviewQuestions · areasToProbeDeeper · preferenceAlignment ·
 *   candidateSummary · savedAs
 *
 * 这跟 doc §4.2 列出的"标准 6 字段" (matchScore/recommendation/summary/
 * matchAnalysis/mustHaveAnalysis/niceToHaveAnalysis) 不一致 —— doc §4.2
 * 描述的是简化语义, 实际 RoboHire 字段更细. agent 不要按 §4.2 cherry-pick,
 * 直接 spread 整段 data, 让 RAAS 端按需挑字段写库.
 *
 * `[key: string]: unknown` 兜底, 允许 RoboHire 未来加新字段不破类型.
 */
export type MatchResultItem = {
  /** Either candidate_id OR upload_id required. */
  candidate_id?: string;
  upload_id?: string;
  /** Either job_requisition_id or job_id (alias). */
  job_requisition_id?: string;
  job_id?: string;
  client_id?: string;
  job_posting_id?: string;
  /** Explicit override, otherwise raas dedups on (candidate_id, job_requisition_id). */
  candidate_match_result_id?: string;

  // ── doc §4.2 列出的"简化 6 字段" — 实际 RoboHire 不一定都返回, 用 spread
  //    覆盖更稳, 这些字段保留只为类型提示 ──
  matchScore?: number;
  matchAnalysis?: Record<string, unknown>;
  mustHaveAnalysis?: Record<string, unknown>;
  niceToHaveAnalysis?: Record<string, unknown>;
  summary?: string;
  recommendation?: string;

  // ── RoboHire /match-resume 实际返回的 camelCase 字段 ──
  resumeAnalysis?: Record<string, unknown>;
  jdAnalysis?: Record<string, unknown>;
  skillMatch?: Record<string, unknown>;
  skillMatchScore?: Record<string, unknown> | number;
  experienceMatch?: Record<string, unknown>;
  experienceValidation?: Record<string, unknown>;
  candidatePotential?: Record<string, unknown>;
  transferableSkills?: unknown[];
  experienceBreakdown?: Record<string, unknown>;
  hardRequirementGaps?: unknown[];
  overallMatchScore?: Record<string, unknown> | number;
  overallFit?: Record<string, unknown>;
  recommendations?: Record<string, unknown>;
  suggestedInterviewQuestions?: Record<string, unknown>;
  areasToProbeDeeper?: unknown[];
  preferenceAlignment?: Record<string, unknown>;
  candidateSummary?: Record<string, unknown>;

  // ── 透传 RoboHire requestId 给 RAAS 做跨服务 trace ──
  robohire_request_id?: string;
  /** RoboHire upstream requestId (alt name, 同义) */
  requestId?: string;
  /** RAAS 那边 LLM 输出的归档名, 透传方便审计 */
  savedAs?: string;

  // RoboHire 未来加新字段从这里兜底, 不破类型
  [key: string]: unknown;
};

export type SaveMatchResultsInput =
  | (MatchResultItem & { source: 'need_interview' })
  | { source: 'no_interview'; match_results: MatchResultItem[] };

export type MatchResultsNeedInterviewResponse = {
  upserted: boolean;
  candidate_match_result_id: string;
  source: 'need_interview';
};

export type MatchResultsNoInterviewItem =
  | { upserted: true; candidate_match_result_id: string; source: 'no_interview' }
  | { skipped: true; reason: string; source: 'no_interview' };

export type MatchResultsNoInterviewResponse = {
  count: number;
  results: MatchResultsNoInterviewItem[];
};

export type SaveMatchResultsResponse =
  | MatchResultsNeedInterviewResponse
  | MatchResultsNoInterviewResponse;

export async function saveMatchResults(
  input: SaveMatchResultsInput,
  opts: CommonOpts = {},
): Promise<SaveMatchResultsResponse & RaasResponse> {
  const body = await doJsonRequest('POST', '/api/v1/match-results', input, opts);
  return { ...(body.data as SaveMatchResultsResponse), requestId: body.requestId, traceId: body._traceId };
}

// ─── Read-only: requirements/:id (单条详情) ─────────────────────────
//
// 跟 agent-view (list) 不同的是这条返回**单条 requisition 的全部字段** +
// specification + siblings + latest_task / analysis 等一坨上下文。agent
// 在 REQUIREMENT_LOGGED 事件里只拿到 entity_id (= job_requisition_id)，
// 后续详情全部走这条 GET 拉取，RAAS 不再 push 到 event payload 里。

/** Job_Requisition 主对象，全字段。RAAS 端字段较多，这里给常用字段 + 兜底 [k:string]. */
export type RaasRequirement = {
  job_requisition_id: string;
  job_requisition_specification_id?: string;
  client_id?: string;
  client_department_id?: string;
  client_job_id?: string;
  client_job_title?: string;
  job_responsibility?: string;
  job_requirement?: string;
  must_have_skills?: string[];
  nice_to_have_skills?: string[];
  negative_requirement?: string;
  language_requirements?: string;
  city?: string;
  salary_range?: string;
  headcount?: number;
  work_years?: number;
  degree_requirement?: string;
  education_requirement?: string;
  interview_mode?: string;
  expected_level?: string;
  recruitment_type?: string;
  [k: string]: unknown;
};

/** Job_Requisition_Specification 全字段 (priority / deadline / hsm_employee_id 等). */
export type RaasRequirementSpecification = {
  job_requisition_specification_id: string;
  hro_service_contract_id?: string;
  client_id?: string;
  start_date?: string;
  deadline?: string;
  priority?: string;
  is_exclusive?: boolean;
  number_of_competitors?: number;
  status?: string;
  hsm_employee_id?: string;
  recruiter_employee_id?: string;
  [k: string]: unknown;
};

export type RaasRequirementSibling = {
  job_requisition_id: string;
  client_job_id?: string;
  client_job_title?: string;
  headcount?: number;
  hc_status?: string;
  competitor_application_count?: number;
  [k: string]: unknown;
};

export type RequirementDetailResponse = RaasResponse & {
  requirement: RaasRequirement;
  specification: RaasRequirementSpecification | null;
  siblings: RaasRequirementSibling[];
  latest_task: Record<string, unknown> | null;
  latest_analysis: Record<string, unknown> | null;
  analysis_history: Array<Record<string, unknown>>;
  clarification_rounds: Array<Record<string, unknown>>;
  manual_override_history: Array<Record<string, unknown>>;
  can_trigger_analysis: boolean;
};

/**
 * GET /api/v1/requirements/:id — 拉单条需求的全字段详情 + spec + siblings.
 *
 * agent 拿到 REQUIREMENT_LOGGED 事件后，从 event.data.entity_id 取出
 * job_requisition_id 直接调这条 endpoint 取完整数据，不再依赖 RAAS 在
 * event payload 里塞 raw_input_data。
 *
 * 注意:
 *  - id 必须 URL-encode（agent 这层用 encodeURIComponent 做，对当前
 *    JR_xxx 形式无影响，但加上更稳）
 *  - 鉴权: Bearer ${AGENT_API_KEY} (与其他 endpoint 一致)
 *  - 返回 200，body 直接是 { requirement, specification, ... } —
 *    不是 { success, data } 包装。我们的 doRequest 对没有 success 字段的
 *    body 不抛错（只在 success:false 时抛），所以这里直接 cast。
 */
export async function getRequirementDetail(
  jobRequisitionId: string,
  opts: CommonOpts = {},
): Promise<RequirementDetailResponse> {
  if (!jobRequisitionId || !jobRequisitionId.trim()) {
    throw new RaasApiError(
      0,
      'CLIENT',
      'getRequirementDetail: jobRequisitionId required',
    );
  }
  const path = `/api/v1/requirements/${encodeURIComponent(jobRequisitionId.trim())}`;
  const body = await doRequest('GET', path, {}, opts);
  return {
    requirement: (body.requirement ?? {}) as RaasRequirement,
    specification:
      (body.specification as RaasRequirementSpecification | null | undefined) ?? null,
    siblings: Array.isArray(body.siblings) ? (body.siblings as RaasRequirementSibling[]) : [],
    latest_task: (body.latest_task as Record<string, unknown> | null | undefined) ?? null,
    latest_analysis:
      (body.latest_analysis as Record<string, unknown> | null | undefined) ?? null,
    analysis_history: Array.isArray(body.analysis_history)
      ? (body.analysis_history as Array<Record<string, unknown>>)
      : [],
    clarification_rounds: Array.isArray(body.clarification_rounds)
      ? (body.clarification_rounds as Array<Record<string, unknown>>)
      : [],
    manual_override_history: Array.isArray(body.manual_override_history)
      ? (body.manual_override_history as Array<Record<string, unknown>>)
      : [],
    can_trigger_analysis: body.can_trigger_analysis === true,
    requestId: body.requestId,
    traceId: body._traceId,
  };
}

// ─── Read-only: requirements/agent-view (list) ──────────────────────

export type RequirementsAgentViewItem = Record<string, unknown>;

export type GetRequirementsQuery = {
  /** ★ 必传 — 招聘人员 employee_id (per partner 2026-05-08 接口约定:
   *   `GET /api/v1/requirements/agent-view?claimer_employee_id=EMP001`) */
  claimer_employee_id: string;
  /**
   * F2 (2026-05-19): 原始简历文件名(可选)— RAAS 端用文件名内 `【岗位】` 模糊收敛
   * 该 claimer 的在招岗位列表。
   *
   * - 不传 → RAAS 退回返回全量岗位(零回归)
   * - 文件名解析失败 / 0 命中 → RAAS 也退回全量
   *
   * AO 端**不解析文件名**,原样透传。
   */
  resume_filename?: string;
};

export type GetRequirementsResponse = RaasResponse & {
  items: RequirementsAgentViewItem[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
};

export async function getRequirementsAgentView(
  query: GetRequirementsQuery,
  opts: CommonOpts = {},
): Promise<GetRequirementsResponse> {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') search.set(k, String(v));
  }
  const path = '/api/v1/requirements/agent-view' + (search.toString() ? `?${search.toString()}` : '');
  const body = await doRequest('GET', path, {}, opts);
  // Endpoint shape is { items, page, page_size, total, total_pages } at top level
  // (not wrapped in .data per doc convention).
  return {
    items: (body.items as RequirementsAgentViewItem[]) ?? [],
    page: typeof body.page === 'number' ? body.page : 1,
    page_size: typeof body.page_size === 'number' ? body.page_size : 20,
    total: typeof body.total === 'number' ? body.total : 0,
    total_pages: typeof body.total_pages === 'number' ? body.total_pages : 0,
    requestId: body.requestId,
    traceId: body._traceId,
  };
}

// ─── Internal: HTTP plumbing ────────────────────────────────────────

// `any` value type is intentional: the JSON body shape varies per endpoint
// and the public-API typed wrappers do the picking + casting. RawBody is
// just a transport vehicle out of doRequest into each public function.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawBody = Record<string, any> & {
  /** trace_id captured from response header (synthetic key, not from body). */
  _traceId?: string;
};

async function doJsonRequest(
  method: string,
  path: string,
  jsonBody: unknown,
  opts: CommonOpts,
): Promise<RawBody> {
  return doRequest(
    method,
    path,
    {
      body: JSON.stringify(jsonBody),
      headers: { 'Content-Type': 'application/json' },
    },
    opts,
  );
}

async function doRequest(
  method: string,
  path: string,
  init: { body?: BodyInit; headers?: Record<string, string> },
  opts: CommonOpts,
): Promise<RawBody> {
  const { baseUrl, agentKey } = config();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${agentKey}`,
    ...(init.headers ?? {}),
  };
  if (opts.traceId) headers['X-Trace-Id'] = opts.traceId;

  const url = path.startsWith('http') ? path : `${baseUrl}${path}`;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS_DEFAULT;

  const res = await fetch(url, {
    method,
    headers,
    body: init.body,
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Capture trace headers regardless of success/failure.
  const responseTraceId =
    res.headers.get('x-trace-id') ?? res.headers.get('X-Trace-Id') ?? undefined;
  const responseRequestId =
    res.headers.get('x-request-id') ?? res.headers.get('X-Request-Id') ?? undefined;

  let body: RawBody | null = null;
  try {
    body = (await res.json()) as RawBody;
    body._traceId = responseTraceId;
  } catch {
    body = { _traceId: responseTraceId };
  }

  // Both transport (non-2xx) and application (success:false) failures
  // become RaasApiError with the same shape.
  if (!res.ok || (body && (body as { success?: boolean }).success === false)) {
    const code = (body?.code as string | undefined) ?? `HTTP_${res.status}`;
    const message =
      (body?.error as string | undefined) ??
      (typeof body === 'object' && body !== null
        ? JSON.stringify(body).slice(0, 200)
        : res.statusText);
    throw new RaasApiError(
      res.status,
      code,
      message,
      (body?.requestId as string | undefined) ?? responseRequestId,
      (body?.traceId as string | undefined) ?? responseTraceId,
    );
  }

  return body ?? {};
}
