/**
 * Thin HTTP client around Node's native `fetch`. Handles bearer auth,
 * timeout via AbortController, and HTTP-status → typed-error mapping per spec §4.2.
 */

import {
  OntologyAuthError,
  OntologyContractError,
  OntologyNotFoundError,
  OntologyRequestError,
  OntologyServerError,
  OntologyTimeoutError,
  OntologyUpstreamError,
} from "./errors";

const DEFAULT_TIMEOUT_MS = 8000;

export interface ClientCallOptions {
  apiBase: string;
  apiToken: string;
  path: string;
  timeoutMs?: number;
}

/**
 * GET `<apiBase><path>` with bearer auth and timeout. Returns the parsed JSON
 * body on 2xx, throws a typed `OntologyGenError` on any failure.
 */
export async function getJson(opts: ClientCallOptions): Promise<unknown> {
  return requestJson({ ...opts, method: "GET" });
}

/**
 * POST/PUT `<apiBase><path>` with a JSON body, bearer auth, and timeout.
 * Mirrors `getJson` for instance writes (e.g. `POST /api/v1/ontology/instances/{label}`).
 */
export async function postJson(
  opts: ClientCallOptions & { body: unknown; method?: "POST" | "PUT" | "PATCH" | "DELETE" },
): Promise<unknown> {
  return requestJson({
    apiBase: opts.apiBase,
    apiToken: opts.apiToken,
    path: opts.path,
    timeoutMs: opts.timeoutMs,
    method: opts.method ?? "POST",
    body: opts.body,
  });
}

interface RequestJsonOptions extends ClientCallOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
}

async function requestJson(opts: RequestJsonOptions): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const url = `${opts.apiBase.replace(/\/+$/, "")}${opts.path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.apiToken}`,
    Accept: "application/json",
  };
  let bodyInit: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    bodyInit = JSON.stringify(opts.body);
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: opts.method,
      headers,
      body: bodyInit,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      throw new OntologyTimeoutError(timeoutMs, `Request to ${url} timed out after ${timeoutMs}ms`);
    }
    throw new OntologyUpstreamError(
      `Network error fetching ${url}: ${err instanceof Error ? err.message : String(err)}`,
      { url },
    );
  }
  clearTimeout(timer);

  // Try to read the body — even on errors, the API documents an error envelope.
  const rawText = await response.text();
  let parsed: unknown = null;
  if (rawText.length > 0) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new OntologyContractError(
        `Response from ${url} is not valid JSON (status ${response.status})`,
        { url, status: response.status, bodySnippet: rawText.slice(0, 200) },
      );
    }
  }

  if (response.ok) {
    return parsed;
  }

  // Error envelope per API doc: { error, message, details? }
  const env = isErrorEnvelope(parsed) ? parsed : null;
  const errCode = env?.error ?? "";
  const errMessage = env?.message ?? `HTTP ${response.status} from ${url}`;
  const errDetails: Record<string, unknown> = {
    url,
    status: response.status,
    method: opts.method,
    ...(env?.details && typeof env.details === "object" ? { upstreamDetails: env.details } : {}),
  };

  switch (response.status) {
    case 400:
      throw new OntologyRequestError(errMessage, { ...errDetails, errorCode: errCode });
    case 401:
      throw new OntologyAuthError(errMessage, { ...errDetails, errorCode: errCode });
    case 404: {
      const resource = errCode === "action-not-found"
        ? "action"
        : errCode === "schema-not-found"
          ? "schema"
          : errCode === "instance-not-found"
            ? "instance"
            : "node";
      throw new OntologyNotFoundError(resource, errMessage, { ...errDetails, errorCode: errCode });
    }
    case 409:
      throw new OntologyRequestError(errMessage, { ...errDetails, errorCode: errCode });
    case 502:
      throw new OntologyUpstreamError(errMessage, { ...errDetails, errorCode: errCode });
    case 500:
      throw new OntologyServerError(errMessage, { ...errDetails, errorCode: errCode });
    default:
      if (response.status >= 400 && response.status < 500) {
        throw new OntologyRequestError(errMessage, { ...errDetails, errorCode: errCode });
      }
      throw new OntologyServerError(errMessage, { ...errDetails, errorCode: errCode });
  }
}

function isErrorEnvelope(v: unknown): v is { error?: string; message?: string; details?: unknown } {
  return typeof v === "object" && v !== null && ("error" in v || "message" in v);
}
