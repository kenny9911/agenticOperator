// dependency monitor — the AO-side judge of "is a paid external dependency
// dead, and if so: 没钱了 / 故障了 / 说不准?". Reads the degraded-call signals the
// agents emitted (LogEvent category 'dependency'), groups them per
// (provider, domain), and fires ONE deduped alert per group that the sweeper's
// resolveStale auto-closes once the failures stop (i.e. after a top-up/recovery).
//
// Pure over MonitorReadPort (tested against a fake port). The judgment uses
// direct signal first (a quota code is decisive), then persistence/scope:
// clean infra errors alone → 故障; any ambiguous signal (auth / empty-200 / 429)
// in the mix → 说不准 (we don't pretend to know). See the dep-health spec §6.

import type { CaptureInput } from '@/server/notifications/derive';
import type { DepFailure, DepLabel } from '../dependency-health/types';
import {
  type MonitorReadPort,
  type MonitorResult,
  type MonitorThresholds,
} from './monitor-types';
import { friendlyDomainName } from '../domain-ids';

const PREFIX = 'dep_down.';

/** Clean infra faults — unambiguous "their service is broken" signals. */
const CLEAN_FAULT = new Set<DepFailure['reason']>(['server', 'network']);

type Judgment = { label: DepLabel; level: 'critical' | 'warn' } | null;

/** Render the windowed 没钱/故障/说不准 verdict for one (provider, domain) group. */
export function judgeDependency(failures: DepFailure[], t: MonitorThresholds): Judgment {
  if (failures.length === 0) return null;
  const reasons = failures.map((f) => f.reason);

  // 1. Direct money signal is decisive — fire immediately.
  if (reasons.includes('quota')) return { label: 'out_of_funds', level: 'critical' };

  const count = failures.length;
  // 2. Only clean infra faults (5xx / timeout / unreachable) → 故障, once it's
  //    more than a one-off blip.
  if (reasons.every((r) => CLEAN_FAULT.has(r))) {
    return count >= t.depFailMinCount ? { label: 'fault', level: 'critical' } : null;
  }

  // 3. Anything ambiguous in the mix (auth / empty-200 / rate-limit) → 说不准.
  //    Warn first; escalate to critical when it persists.
  if (count < t.depFailMinCount) return null;
  return { label: 'unknown', level: count >= t.depUnknownEscalateCount ? 'critical' : 'warn' };
}

const PROVIDER_LABEL: Record<DepFailure['provider'], string> = {
  robohire: 'RoboHire',
  llm: 'AI 网关',
  rmhr: '简历锁定 (RMHR)',
};
// Source must match server/notifications/derive.ts INFRA_SOURCES so the alert is
// routed to the always-visible 系统 lane (an infra outage shouldn't hide behind a
// business-domain tab).
const PROVIDER_SOURCE: Record<DepFailure['provider'], string> = {
  robohire: 'RoboHire',
  llm: 'LLM 网关',
  rmhr: 'RMHR',
};
const OP_LABEL: Record<string, string> = {
  parseResume: '简历解析',
  matchResume: '简历匹配',
  generateJd: 'JD 生成',
  inviteCandidate: '面试邀约',
  ruleCheck: '规则校验',
};

function friendlyOps(failures: DepFailure[]): string {
  const seen = new Set<string>();
  for (const f of failures) seen.add(OP_LABEL[f.op] ?? f.op);
  return [...seen].join('、');
}

function bodyFor(label: DepLabel, provider: DepFailure['provider'], failures: DepFailure[], windowMin: number): string {
  const name = PROVIDER_LABEL[provider];
  const ops = friendlyOps(failures);
  const n = failures.length;
  const dom = friendlyDomainName(failures[0].domain);
  switch (label) {
    case 'out_of_funds':
      return `${name} 额度不足 — 近 ${windowMin} 分钟 ${ops} 共 ${n} 次调用失败,判定为额度耗尽(没钱了)。影响:${dom}域。建议:充值后受影响任务将自动续跑。`;
    case 'fault':
      return `${name} 疑似故障 — 近 ${windowMin} 分钟 ${ops} 共 ${n} 次服务端错误/超时,判定为厂商故障(通常自愈)。影响:${dom}域。建议:持续未恢复请联系厂商;任务排队重试中。`;
    case 'unknown':
      return `${name} 持续异常 — 近 ${windowMin} 分钟 ${ops} 共 ${n} 次返回异常/空结果,无法区分欠费还是故障(说不准)。影响:${dom}域。建议:人工核查账户余额与服务状态。`;
  }
}

function latestAnchors(failures: DepFailure[]): Record<string, string> | undefined {
  for (let i = failures.length - 1; i >= 0; i--) {
    const a = failures[i].anchors;
    if (a && Object.keys(a).length > 0) return a;
  }
  return undefined;
}

export async function dependencyMonitor(
  port: MonitorReadPort,
  t: MonitorThresholds,
): Promise<MonitorResult> {
  const failures = await port.dependencyFailures(t.depFailWindowMs);
  const windowMin = Math.round(t.depFailWindowMs / 60_000);

  // Group by (provider, domain).
  const groups = new Map<string, DepFailure[]>();
  for (const f of failures) {
    const key = `${f.provider}::${f.domain}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }

  const findings: CaptureInput[] = [];
  const activeKeys: string[] = [];

  for (const [key, group] of groups) {
    const verdict = judgeDependency(group, t);
    if (!verdict) continue;
    const [provider, domain] = key.split('::') as [DepFailure['provider'], string];
    const dedupeKey = `${PREFIX}${provider}.${domain}`;
    activeKeys.push(dedupeKey);
    const latestRunId = [...group].reverse().find((f) => f.runId)?.runId ?? null;
    findings.push({
      level: verdict.level,
      category: 'system', // always-visible infra lane
      source: PROVIDER_SOURCE[provider],
      message: bodyFor(verdict.label, provider, group, windowMin),
      dedupeHint: dedupeKey,
      domain,
      runId: latestRunId,
      // Stamp the structured verdict + provider into the alert so the
      // Dependency Health card can read the authoritative label straight off the
      // firing notification (the deduped, auto-resolving source of truth) — even
      // after the degraded-call window has aged out but before the sweep resolves.
      anchors: { ...(latestAnchors(group) ?? {}), dep_label: verdict.label, dep_provider: provider },
    });
  }

  return { prefix: PREFIX, findings, activeKeys };
}
