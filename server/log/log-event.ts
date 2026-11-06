// LogEvent — the unified, queryable audit log. Every AgentActivity write is
// mirrored here (fire-and-forget) with a normalized (level, category) and the
// correlation keys (runId, agent), so /api/log-events can answer "show me everything
// for this run / agent / severity / time window" across all agents — the
// "审计日志全可查" requirement. Writing never throws (audit must not break work).

import { prisma } from '@/server/db';
import { recordNotification } from '@/server/notifications/ingest';
import {
  classifyFailure,
  enrichPayloadJsonWithFailure,
  messageWithFailureSummary,
} from './failure-classifier';

export type LogLevel = 'debug' | 'info' | 'notice' | 'warn' | 'error' | 'critical';

export interface LevelCategory {
  level: LogLevel;
  category: string;
}

// Maps an AgentActivity `type` string (server/agent-logger.ts) to a normalized
// (level, category). Pure + total — unknown types default to info/info.
export function levelCategoryFor(type: string): LevelCategory {
  switch (type) {
    case 'agent_error':
      return { level: 'error', category: 'error' };
    case 'dependency_degraded':
      // External paid dependency (RoboHire / LLM gateway) returned an error or
      // an empty-200. Its own `dependency` category is the queryable lane the
      // monitor reads (lib/monitor/dependency.ts). See the dep-health spec.
      return { level: 'warn', category: 'dependency' };
    case 'dependency_reset':
      // Operator "I topped up" marker — degraded-call signals at/before it are
      // ignored. Its own category so the read port can find it. See reset.ts.
      return { level: 'info', category: 'dependency_reset' };
    case 'domain_drift':
      // The recruitment Allmeta domain id no longer matches any live domain
      // (renamed/removed in Studio) so ontology reads fell back to the constant.
      // Shares the 'dependency' queryable lane (provider-less → safely dropped by
      // the dep-health parser). See lib/domain-resolve.ts + /api/domains.
      return { level: 'warn', category: 'dependency' };
    case 'step.failed':
      return { level: 'error', category: 'step' };
    case 'anomaly':
      return { level: 'warn', category: 'anomaly' };
    case 'tool':
      return { level: 'info', category: 'tool' };
    case 'decision':
      return { level: 'info', category: 'decision' };
    case 'event_received':
    case 'event_emitted':
      return { level: 'info', category: 'event' };
    case 'manage_action':
      // 运维写操作(暂停/恢复/重放/改配置)— writeManageAudit 镜像进来,
      // 让统一审计日志一处可查(2026-05-22 spec 欠的账,2026-06-11 补)。
      return { level: 'info', category: 'manage' };
    case 'agent_start':
    case 'agent_complete':
      return { level: 'info', category: 'lifecycle' };
    case 'hitl':
      return { level: 'notice', category: 'hitl' };
    case 'step.started':
    case 'step.completed':
    case 'step.retrying':
      return { level: 'info', category: 'step' };
    default:
      return { level: 'info', category: 'info' };
  }
}

// Maps a JSONL file-logger `kind` (lib/agent-logger) to the canonical
// AgentActivity type understood by levelCategoryFor. Pure + total.
export function typeForFileKind(kind: string): string {
  if (kind === 'handler.start') return 'agent_start';
  if (kind === 'handler.done') return 'agent_complete';
  if (kind === 'handler.error') return 'agent_error';
  if (kind === 'handler.raw_input') return 'event_received';
  if (kind.startsWith('emit.')) return 'event_emitted';
  if (kind.startsWith('api.')) return 'tool';
  if (kind === 'step.start') return 'step.started';
  if (kind === 'step.end') return 'step.completed';
  if (kind === 'step.error') return 'step.failed';
  if (kind.endsWith('.failed')) return 'anomaly';
  if (kind.endsWith('.error')) return 'agent_error';
  return 'info';
}

// File-logger ctx.agent (AGENT_NAME constants) → canonical AGENT_MAP short, so
// the AgentActivity rows the bridge writes group correctly in /monitor
// (overview rollup, agent pages, run-detail trail). Pure + total.
const FILE_AGENT_TO_SHORT: Record<string, string> = {
  ruleCheck: 'RuleCheck',
  createJD: 'JDGenerator',
  matchResume: 'Matcher',
  resumeParser: 'ResumeParser',
  interviewInviter: 'InterviewInviter',
};
export function canonicalShortForFileAgent(name: string): string {
  return FILE_AGENT_TO_SHORT[name] ?? name;
}

// Verbose, low-signal kinds we keep in the audit log (LogEvent) but DON'T
// mirror into AgentActivity, to keep the /monitor run timeline readable.
const ACTIVITY_SKIP_KINDS = new Set(['step.start', 'step.end', 'handler.raw_input']);

export interface RecordLogEventInput {
  type: string;
  message: string;
  source?: string;
  agent?: string | null;
  runId?: string | null;
  traceId?: string | null;
  eventName?: string | null;
  rawKind?: string | null;
  anchorsJson?: string | null;
  payloadJson?: string | null;
  durationMs?: number | null;
}

/** Fire-and-forget write into the unified audit log. Never throws.
 *  注意:不能加全局 VITEST 保护 — reset 路由等测试 mock 掉 prisma 后会断言
 *  本函数的真实写入;测试污染问题在污染源头按 DI 注 noop(见 interview-
 *  inviter-agent.test.ts 的 dependency-health mock)。 */
export async function recordLogEvent(input: RecordLogEventInput): Promise<void> {
  const { level, category } = levelCategoryFor(input.type);
  const failure = classifyFailure({
    type: input.type,
    level,
    category,
    source: input.source ?? 'agent',
    agent: input.agent ?? null,
    eventName: input.eventName ?? null,
    message: input.message,
    payloadJson: input.payloadJson ?? null,
  });
  const payloadJson = failure
    ? enrichPayloadJsonWithFailure(input.payloadJson ?? null, failure, Number.MAX_SAFE_INTEGER)
    : input.payloadJson ?? null;
  const message = messageWithFailureSummary(input.message, input.type, failure).slice(0, 2000);
  try {
    await prisma.logEvent.create({
      data: {
        level,
        category,
        source: input.source ?? 'agent',
        agent: input.agent ?? null,
        runId: input.runId ?? null,
        traceId: input.traceId ?? null,
        eventName: input.eventName ?? null,
        rawKind: input.rawKind ?? null,
        anchorsJson: input.anchorsJson ?? null,
        message,
        payloadJson,
        durationMs: input.durationMs ?? null,
      },
    });
  } catch (e) {
    console.warn(`[log-event] recordLogEvent failed (${input.type}): ${(e as Error).message}`);
  }
}

export interface MirrorFileLogInput {
  agent: string;
  runId?: string | null;
  traceId?: string | null;
  anchors?: Record<string, string | null | undefined>;
  kind: string;
  payload?: unknown;
}

/**
 * Bridge: mirror one JSONL file-logger entry (lib/agent-logger) into the unified
 * audit log, and route unrecoverable errors to the notification center. This is
 * what makes the REAL agents (which log to files, not the DB) show up in
 * /api/log-events and 消息通知. Fire-and-forget — never throws.
 */
export async function mirrorAgentFileLog(input: MirrorFileLogInput): Promise<void> {
  // Hermetic tests: agent handler unit tests exercise the file logger directly
  // (candidate-identity/ownership 等) — they must not write LogEvent /
  // AgentActivity / Notification rows into the dev DB.
  if (process.env.VITEST) return;
  const type = typeForFileKind(input.kind);
  let payloadJson: string | null = null;
  if (input.payload !== undefined) {
    try {
      payloadJson = JSON.stringify(input.payload);
    } catch {
      payloadJson = null;
    }
  }
  const failure = classifyFailure({
    type,
    source: 'agent',
    agent: input.agent,
    message: input.kind,
    payloadJson,
  });
  const enrichedPayloadJson = failure
    ? enrichPayloadJsonWithFailure(payloadJson, failure, Number.MAX_SAFE_INTEGER)
    : payloadJson;
  const narrative = messageWithFailureSummary(input.kind, type, failure);
  await recordLogEvent({
    type,
    message: narrative,
    source: 'agent',
    agent: input.agent,
    runId: input.runId ?? null,
    traceId: input.traceId ?? null,
    rawKind: input.kind,
    anchorsJson: input.anchors ? safeJson(input.anchors) : null,
    payloadJson: enrichedPayloadJson,
  });
  // Also mirror into AgentActivity (name-aligned) so the existing /monitor
  // views (run-detail timeline, overview rollup, per-agent pages) — which read
  // AgentActivity — surface the real agent narrative. Skip the verbose kinds.
  if (!ACTIVITY_SKIP_KINDS.has(input.kind)) {
    try {
      await prisma.agentActivity.create({
        data: {
          runId: input.runId ?? null,
          nodeId: input.agent,
          agentName: canonicalShortForFileAgent(input.agent),
          type,
          narrative,
          metadata: enrichedPayloadJson,
        },
      });
    } catch (e) {
      console.warn(`[log-event] AgentActivity mirror failed (${input.kind}): ${(e as Error).message}`);
    }
  }
  if (type === 'agent_error') {
    void recordNotification({
      level: 'error',
      category: 'agent_error',
      source: input.agent,
      agent: input.agent,
      runId: input.runId ?? null,
      traceId: input.traceId ?? null,
      message: failure
        ? `${input.agent} 运行异常:${failure.summary}`
        : `${input.agent} 运行异常:${input.kind}`,
      dedupeHint: `agent_error.${input.agent}`,
    }).catch(() => {});
  }
}

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
