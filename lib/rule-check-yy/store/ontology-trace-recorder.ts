/**
 * Ontology API trace recorder — wraps `getJson` so every HTTP exchange
 * lands in an `OntologyApiTraceEntry[]` accumulator that becomes part of the
 * persisted `RuleCheckRunAudited.ontologyApiTrace`.
 *
 * Passed explicitly via context (not AsyncLocalStorage) — simpler, no globals.
 */

import { getJson, type ClientCallOptions } from "../../ontology-gen/client";
import { rcDebug, rcWarn } from "../debug";
import type { OntologyApiTraceEntry } from "../types-audited";

export interface TraceCtx {
  /** Accumulator the orchestrator owns. Recorder pushes entries here. */
  trace: OntologyApiTraceEntry[];
}

/**
 * Drop-in replacement for `getJson` that records the exchange when a
 * `traceCtx` is supplied. When `traceCtx` is omitted (e.g. from a unit test),
 * behaves identically to `getJson`.
 */
export async function tracedGetJson(
  opts: ClientCallOptions,
  traceCtx?: TraceCtx,
): Promise<unknown> {
  const start = Date.now();
  const url = `${opts.apiBase.replace(/\/+$/, "")}${opts.path}`;
  // Headers we know we'll send (mirrored from client.ts, which doesn't expose them).
  const requestHeaders: Record<string, string> = {
    Authorization: "Bearer ***",  // redact token from the audit trace
    Accept: "application/json",
  };

  let response: unknown;
  let responseStatus = 0;
  let errorOccurred: unknown;

  try {
    response = await getJson(opts);
    responseStatus = 200;  // getJson throws on non-2xx, so reaching here means OK
  } catch (err) {
    errorOccurred = err;
    // Best-effort status extraction; getJson's errors carry statusCode for most cases.
    const e = err as { statusCode?: number; message?: string };
    responseStatus = e.statusCode ?? 0;
  }

  const latencyMs = Date.now() - start;
  const itemCount = countListItems(response);
  if (errorOccurred) {
    rcWarn("ontology", "GET failed", {
      url,
      status: responseStatus,
      latencyMs,
      error: (errorOccurred as Error).message,
    });
  } else {
    rcDebug("ontology", "GET", {
      url,
      status: responseStatus,
      latencyMs,
      items: itemCount,
    });
  }

  if (traceCtx) {
    traceCtx.trace.push({
      requestUrl: url,
      requestMethod: "GET",
      requestHeaders,
      responseStatus,
      responseBody: errorOccurred
        ? { error: (errorOccurred as Error).message }
        : response,
      latencyMs,
      timestamp: new Date().toISOString(),
    });
  }

  if (errorOccurred) throw errorOccurred;
  return response;
}

function countListItems(raw: unknown): number | undefined {
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  for (const key of ["items", "data", "results"]) {
    if (Array.isArray(r[key])) return (r[key] as unknown[]).length;
  }
  return undefined;
}
