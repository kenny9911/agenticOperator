// RAAS API client — proxies RoboHire resume parsing & matching via internal gateway.
// API docs: docs/robohire/api-external-resume-parsing-and-matching.md
//
// Two endpoints used:
//   POST /api/v1/parse-resume   multipart, body: file=PDF binary, max 10MB
//   POST /api/v1/match-resume   JSON,      body: { resume, jd, ... }
//
// Auth:    Authorization: Bearer ${AGENT_API_KEY}   (provided by raas team)
// Base:    RAAS_API_BASE_URL (dev: http://localhost:3001; prod: https://aicoe.chinasoftinc.com/raas-api)
// Latency: parse 3-8s, match 5-15s. Configurable timeout (default 300s).
//
// IMPORTANT — return shape is RAW.
// Per partner spec §4 ("payload.parsed.data 内的 schema 就是 RoboHire
// /api/v1/parse-resume response 里的 data 字段，原样转发即可，不需要任何
// 字段重命名 / 拍扁"), this client returns RoboHire's `data` field
// verbatim. The caller is expected to dump it directly into
// `payload.parsed.data` (and `payload.match.data` for match outcomes).

import type { LoggerLike } from "@/server/agent-logger";
import { fetchWithTelemetry } from "@/server/http/instrumented";

const BASE = process.env.RAAS_API_BASE_URL ?? "http://localhost:3001";
const KEY = process.env.AGENT_API_KEY ?? "";
const TIMEOUT_MS = Number(process.env.ROBOHIRE_TIMEOUT_MS ?? 300_000);

export class RoboHireError extends Error {
  constructor(
    public status: number,
    message: string,
    public requestId?: string,
  ) {
    super(`RoboHire ${status}: ${message}${requestId ? ` (req=${requestId})` : ""}`);
    this.name = "RoboHireError";
  }
}

export function isRoboHireConfigured(): boolean {
  return KEY.length > 0;
}

// ─── parse-resume ──────────────────────────────────────────────────

export type RoboHireParseResult = {
  /** RoboHire response `data` field — passed through verbatim. */
  data: Record<string, unknown>;
  requestId: string;
  /** RAAS-minted or caller-supplied trace ID echoed in X-Trace-Id response header. */
  traceId?: string;
  cached: boolean;
  documentId?: string;
  savedAs?: string;
  duration_ms: number;
};

export async function roboHireParseResume(
  fileBuffer: Buffer,
  filename: string,
  opts?: { logger?: LoggerLike },
): Promise<RoboHireParseResult> {
  if (!KEY) throw new RoboHireError(0, "AGENT_API_KEY not set");

  const startedAt = Date.now();
  const form = new FormData();
  // RoboHire docs §2: field name "file", mime application/pdf.
  // Don't set Content-Type manually — FormData adds the multipart boundary.
  const blob = new Blob([new Uint8Array(fileBuffer)], {
    type: "application/pdf",
  });
  form.append("file", blob, filename);

  const res = await fetchWithTelemetry(
    `${BASE}/api/v1/parse-resume`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}` },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
    {
      logger: opts?.logger,
      toolName: "RoboHire.parseResume",
      meta: { filename, bytes: fileBuffer.length },
    },
  );

  const headerRequestId = res.headers.get("x-request-id") ?? "";
  const headerTraceId = res.headers.get("x-trace-id") ?? "";

  if (!res.ok) {
    let msg = res.statusText;
    let bodyRequestId = "";
    try {
      const body = (await res.json()) as Record<string, unknown>;
      msg =
        (body as any)?.error ??
        (body as any)?.message ??
        JSON.stringify(body);
      bodyRequestId = (body as any)?.requestId ?? "";
    } catch {
      try {
        msg = await res.text();
      } catch {
        /* keep statusText */
      }
    }
    throw new RoboHireError(
      res.status,
      msg,
      bodyRequestId || headerRequestId,
    );
  }

  const json = (await res.json()) as {
    success?: boolean;
    data?: Record<string, unknown>;
    cached?: boolean;
    documentId?: string;
    savedAs?: string;
    requestId?: string;
  };

  if (!json.data) {
    throw new RoboHireError(
      500,
      "RAAS API 200 response missing `data`",
      json.requestId ?? headerRequestId,
    );
  }

  return {
    data: json.data,
    requestId: json.requestId ?? headerRequestId,
    traceId: headerTraceId || undefined,
    cached: Boolean(json.cached),
    documentId: json.documentId,
    savedAs: json.savedAs,
    duration_ms: Date.now() - startedAt,
  };
}

// ─── match-resume ──────────────────────────────────────────────────

export type RoboHireMatchInput = {
  /** Plain text resume — typically `parsed.data.rawText` or a flattened summary. */
  resume: string;
  /** Plain text job description. */
  jd: string;
  /** Optional free-form candidate preferences (location/salary/etc). */
  candidatePreferences?: string;
  /** Optional free-form job metadata (company stage, must-haves). */
  jobMetadata?: string;
};

export type RoboHireMatchResult = {
  /** RoboHire response `data` field — passed through verbatim. */
  data: Record<string, unknown>;
  requestId: string;
  /** RAAS-minted or caller-supplied trace ID echoed in X-Trace-Id response header. */
  traceId?: string;
  savedAs?: string;
  duration_ms: number;
};

export async function roboHireMatchResume(
  input: RoboHireMatchInput,
  opts?: { logger?: LoggerLike },
): Promise<RoboHireMatchResult> {
  if (!KEY) throw new RoboHireError(0, "AGENT_API_KEY not set");

  const startedAt = Date.now();
  const body: Record<string, string> = {
    resume: input.resume,
    jd: input.jd,
  };
  if (input.candidatePreferences) body.candidatePreferences = input.candidatePreferences;
  if (input.jobMetadata) body.jobMetadata = input.jobMetadata;

  const res = await fetchWithTelemetry(
    `${BASE}/api/v1/match-resume`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
    {
      logger: opts?.logger,
      toolName: "RoboHire.matchResume",
      meta: {
        resume_chars: input.resume.length,
        jd_chars: input.jd.length,
      },
    },
  );

  const headerRequestId = res.headers.get("x-request-id") ?? "";
  const headerTraceId = res.headers.get("x-trace-id") ?? "";
  if (!res.ok) {
    let msg = res.statusText;
    let bodyRequestId = "";
    try {
      const errBody = (await res.json()) as Record<string, unknown>;
      msg =
        (errBody as any)?.error ??
        (errBody as any)?.message ??
        JSON.stringify(errBody);
      bodyRequestId = (errBody as any)?.requestId ?? "";
    } catch {
      try {
        msg = await res.text();
      } catch {
        /* keep statusText */
      }
    }
    throw new RoboHireError(
      res.status,
      msg,
      bodyRequestId || headerRequestId,
    );
  }

  const json = (await res.json()) as {
    success?: boolean;
    data?: Record<string, unknown>;
    requestId?: string;
    savedAs?: string;
  };

  if (!json.data) {
    throw new RoboHireError(
      500,
      "RAAS API 200 response missing `data`",
      json.requestId ?? headerRequestId,
    );
  }

  return {
    data: json.data,
    requestId: json.requestId ?? headerRequestId,
    traceId: headerTraceId || undefined,
    savedAs: json.savedAs,
    duration_ms: Date.now() - startedAt,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Pull a plain-text resume out of RoboHire's parse response so we can
 * feed it to /match-resume. Prefers the `rawText` field RoboHire
 * returns; falls back to a synthesized summary from structured fields.
 */
export function roboHireDataToResumeText(data: Record<string, unknown>): string {
  const rawText = (data as any)?.rawText;
  if (typeof rawText === "string" && rawText.trim().length > 200) {
    return rawText;
  }
  // Fallback: stringify the structured payload — RoboHire docs §3 say this
  // is acceptable for /match-resume and that plain text scores marginally
  // better than JSON, so prefer rawText when long enough.
  const lines: string[] = [];
  const d = data as any;
  if (d.name) lines.push(d.name);
  if (d.summary) lines.push(d.summary);
  if (d.email) lines.push(`Email: ${d.email}`);
  if (d.phone) lines.push(`Phone: ${d.phone}`);
  if (d.address) lines.push(`Address: ${d.address}`);
  if (Array.isArray(d.experience)) {
    lines.push("\nExperience:");
    for (const e of d.experience) {
      lines.push(`- ${e?.startDate ?? ""}–${e?.endDate ?? ""} ${e?.role ?? e?.title ?? ""} @ ${e?.company ?? ""}`);
      if (e?.description) lines.push(`  ${e.description}`);
    }
  }
  if (Array.isArray(d.education)) {
    lines.push("\nEducation:");
    for (const e of d.education) {
      lines.push(`- ${e?.institution ?? ""}  ${e?.degree ?? ""} ${e?.field ?? ""} (${e?.startDate ?? ""}–${e?.endDate ?? ""})`);
    }
  }
  if (d.skills && typeof d.skills === "object") {
    const s = d.skills as Record<string, string[]>;
    const allSkills = [
      ...(Array.isArray(s.technical) ? s.technical : []),
      ...(Array.isArray(s.tools) ? s.tools : []),
      ...(Array.isArray(s.languages) ? s.languages : []),
      ...(Array.isArray(s.frameworks) ? s.frameworks : []),
    ];
    if (allSkills.length) lines.push(`\nSkills: ${allSkills.join(", ")}`);
  } else if (Array.isArray(d.skills)) {
    lines.push(`\nSkills: ${d.skills.join(", ")}`);
  }
  return lines.join("\n");
}
