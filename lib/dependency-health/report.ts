// External Dependency Health — the report helpers.
//
// Two entry points:
//   recordDependencySignal(o, ctx)    — write ONE structured signal into the
//       unified audit log (LogEvent, category 'dependency') for the monitor to
//       read. Never throws. Use when the caller handles the throw/park itself
//       (e.g. rule-check already parks on infra failure).
//   reportDependencyDegraded(o, ctx)  — recordDependencySignal + throw, so the
//       run stops being a false "success". Recoverable reasons (out-of-funds /
//       throttle / transient infra) throw a RETRIABLE error (the run parks and
//       auto-resumes once you top up / the vendor recovers); bad credentials /
//       empty payloads are NonRetriable (no point retrying).
//
// isRecoverableReason lets agents that emit a terminal business _FAILED event
// gate it: a recoverable degrade parks (no terminal event — we haven't given
// up), a non-recoverable one emits _FAILED (we have).

import { NonRetriableError } from 'inngest';
import { recordLogEvent as realRecordLogEvent } from '@/server/log/log-event';
import type { DepOutcome, DepReason } from './types';

type Degraded = Extract<DepOutcome, { ok: false }>;

export interface ReportContext {
  agent?: string;
  runId?: string | null;
  traceId?: string | null;
  /** Allmeta business-domain id the affected agent belongs to. */
  domain: string;
  anchors?: Record<string, string | null | undefined>;
}

interface ReportDeps {
  recordLogEvent?: typeof realRecordLogEvent;
}

const RECOVERABLE: ReadonlySet<DepReason> = new Set<DepReason>(['quota', 'rate_limit', 'network', 'server']);

/**
 * Recoverable = topping up / the vendor coming back fixes it, so it's worth
 * parking + retrying. auth (bad/expired key) and empty (degenerate payload) are
 * not — retrying yields the same result.
 */
export function isRecoverableReason(reason: DepReason): boolean {
  return RECOVERABLE.has(reason);
}

function friendlyProvider(provider: Degraded['provider']): string {
  return provider === 'llm' ? 'LLM 网关' : 'RoboHire';
}

function cleanAnchors(anchors?: Record<string, string | null | undefined>): Record<string, string> | undefined {
  if (!anchors) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(anchors)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Write the degraded-dependency signal into the audit log. Never throws. */
export async function recordDependencySignal(
  o: Degraded,
  ctx: ReportContext,
  deps: ReportDeps = {},
): Promise<void> {
  const record = deps.recordLogEvent ?? realRecordLogEvent;
  await record({
    type: 'dependency_degraded',
    message: `${friendlyProvider(o.provider)} ${o.op} 退化:${o.reason} — ${o.detail}`,
    source: o.provider === 'llm' ? 'LLM 网关' : 'RoboHire',
    agent: ctx.agent ?? null,
    runId: ctx.runId ?? null,
    traceId: ctx.traceId ?? null,
    payloadJson: JSON.stringify({
      provider: o.provider,
      op: o.op,
      reason: o.reason,
      detail: o.detail,
      domain: ctx.domain,
      anchors: cleanAnchors(ctx.anchors),
      inngestRunId: ctx.runId ?? null,
    }),
  });
}

/** Record the signal and throw to fail the run. Never returns. */
export async function reportDependencyDegraded(
  o: Degraded,
  ctx: ReportContext,
  deps: ReportDeps = {},
): Promise<never> {
  await recordDependencySignal(o, ctx, deps);
  const msg = `external dependency degraded — ${o.provider}/${o.op} ${o.reason}: ${o.detail}`;
  if (isRecoverableReason(o.reason)) throw new Error(msg);
  throw new NonRetriableError(msg);
}
