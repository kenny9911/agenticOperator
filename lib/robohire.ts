// RAAS API wrapper — proxies RoboHire resume parsing & matching via internal gateway.
// /parse-resume: multipart/form-data 上传 PDF → 结构化 JSON
// /match-resume: JSON 提交 resume + jd 文本 → 匹配评分
//
// Auth: AGENT_API_KEY (issued by raas team; AO must NOT call api.robohire.io directly)
// Base: RAAS_API_BASE_URL (dev: http://localhost:3001; prod: https://aicoe.chinasoftinc.com/raas-api)

const BASE = process.env.RAAS_API_BASE_URL ?? 'http://localhost:3001';

function authHeader() {
  const key = process.env.AGENT_API_KEY;
  if (!key) throw new Error('AGENT_API_KEY is not set');
  return { Authorization: `Bearer ${key}` };
}

export class RoboHireNonRetryableError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`RoboHire non-retryable ${status}: ${JSON.stringify(body).slice(0, 300)}`);
    this.name = 'RoboHireNonRetryableError';
  }
}

// ─── /parse-resume ────────────────────────────────────────
export type RoboHireParsedExperience = {
  title?: string;
  company?: string;
  location?: string;
  startDate?: string;
  endDate?: string;
  description?: string;
  highlights?: string[];
};

export type RoboHireParsedEducation = {
  degree?: string;
  field?: string;
  institution?: string;
  graduationYear?: string;
};

export type RoboHireParsedData = {
  name?: string;
  email?: string;
  phone?: string;
  location?: string;
  summary?: string;
  experience?: RoboHireParsedExperience[];
  education?: RoboHireParsedEducation[];
  skills?: string[];
  certifications?: string[];
  languages?: Array<{ language?: string; proficiency?: string }>;
};

export type RoboHireParseResponse = {
  success: boolean;
  data?: RoboHireParsedData;
  cached?: boolean;
  documentId?: string;
  savedAs?: string;
  requestId?: string;
  error?: string;
};

/** 把 PDF Buffer 包成 Blob 走 multipart 发到 RoboHire /parse-resume */
export async function parseResumePdf(
  pdfBuffer: Buffer,
  filename: string
): Promise<RoboHireParseResponse> {
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(pdfBuffer)], { type: 'application/pdf' }),
    filename || 'resume.pdf'
  );

  const r = await fetch(`${BASE}/api/v1/parse-resume`, {
    method: 'POST',
    headers: { ...authHeader() },
    body: form,
  });

  const json = (await r.json().catch(() => ({}))) as RoboHireParseResponse & {
    error?: string;
    requestId?: string;
  };

  if (!r.ok) {
    if (r.status >= 400 && r.status < 500 && r.status !== 429) {
      throw new RoboHireNonRetryableError(r.status, json);
    }
    throw new Error(`RoboHire parse-resume ${r.status}: ${json.error ?? r.statusText}`);
  }

  if (!json.success) {
    throw new RoboHireNonRetryableError(r.status, json);
  }

  return json;
}

// ─── /match-resume ────────────────────────────────────────
export type RoboHireMatchInput = {
  resume: string;
  jd: string;
  candidatePreferences?: string;
  jobMetadata?: string;
};

export type RoboHireMatchData = {
  matchScore: number;
  recommendation: 'STRONG_MATCH' | 'GOOD_MATCH' | 'PARTIAL_MATCH' | 'WEAK_MATCH';
  summary: string;
  matchAnalysis?: {
    technicalSkills?: { score?: number; matchedSkills?: string[]; missingSkills?: string[] };
    experienceLevel?: {
      score?: number;
      required?: string;
      candidate?: string;
      assessment?: string;
    };
  };
  mustHaveAnalysis?: {
    extractedMustHaves?: { skills?: string[]; experience?: string[] };
    candidateMustHaves?: { skills?: string[]; experience?: string[] };
    matchedMustHaves?: string[];
  };
  niceToHaveAnalysis?: {
    extractedNiceToHaves?: { skills?: string[]; certifications?: string[] };
    matchedNiceToHaves?: string[];
  };
};

export type RoboHireMatchResponse = {
  success: boolean;
  data?: RoboHireMatchData;
  requestId?: string;
  savedAs?: string;
  error?: string;
};

export async function matchResumeToJd(input: RoboHireMatchInput): Promise<RoboHireMatchResponse> {
  const r = await fetch(`${BASE}/api/v1/match-resume`, {
    method: 'POST',
    headers: { ...authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  const json = (await r.json().catch(() => ({}))) as RoboHireMatchResponse;

  if (!r.ok) {
    if (r.status >= 400 && r.status < 500 && r.status !== 429) {
      throw new RoboHireNonRetryableError(r.status, json);
    }
    throw new Error(`RoboHire match-resume ${r.status}: ${json.error ?? r.statusText}`);
  }

  if (!json.success) {
    throw new RoboHireNonRetryableError(r.status, json);
  }

  return json;
}
