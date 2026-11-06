// Per-provider rollup for the Dependency Health UI surface. Pure over a window
// of DepFailure signals — reuses the SAME judgment the monitor fires on, so the
// card and the 消息通知 alert never disagree. Drives off the degraded-call
// window (not the notification table), so it recovers for free as failures age
// out of the window.

import { judgeDependency } from '../monitor/dependency';
import type { MonitorThresholds } from '../monitor/monitor-types';
import type { DepFailure, DepLabel, DepProvider, DepReason } from './types';

const KNOWN_PROVIDERS: DepProvider[] = ['robohire', 'llm'];

export type ProviderSeverity = 'ok' | 'info' | 'warn' | 'critical';

export interface ProviderHealth {
  provider: DepProvider;
  /** 'healthy' (no failures) | 'watching' (sub-threshold) | judged verdict. */
  label: DepLabel | 'healthy' | 'watching';
  severity: ProviderSeverity;
  /** Count of actual degraded calls in the window (NOT the alarm dedupe count). */
  failureCount: number;
  /** ISO timestamp of the earliest failure in the window (null when healthy). */
  sinceTs: string | null;
  /** ISO timestamp of the most recent failure — "last failed N ago" (null when healthy). */
  lastFailureTs: string | null;
  lastReason: DepReason | null;
  affectedOps: string[];
  affectedDomains: string[];
}

export function summarizeDependencyHealth(
  failures: DepFailure[],
  t: MonitorThresholds,
): ProviderHealth[] {
  const byProvider = new Map<DepProvider, DepFailure[]>();
  for (const f of failures) {
    (byProvider.get(f.provider) ?? byProvider.set(f.provider, []).get(f.provider)!).push(f);
  }

  return KNOWN_PROVIDERS.map((provider) => {
    const fs = byProvider.get(provider) ?? [];
    if (fs.length === 0) {
      return {
        provider,
        label: 'healthy' as const,
        severity: 'ok' as const,
        failureCount: 0,
        sinceTs: null,
        lastFailureTs: null,
        lastReason: null,
        affectedOps: [],
        affectedDomains: [],
      };
    }
    const verdict = judgeDependency(fs, t);
    const sorted = [...fs].sort((a, b) => a.ts.getTime() - b.ts.getTime());
    return {
      provider,
      label: verdict ? verdict.label : 'watching',
      severity: verdict ? verdict.level : 'info',
      failureCount: fs.length,
      sinceTs: sorted[0].ts.toISOString(),
      lastFailureTs: sorted[sorted.length - 1].ts.toISOString(),
      lastReason: sorted[sorted.length - 1].reason,
      affectedOps: [...new Set(fs.map((f) => f.op))],
      affectedDomains: [...new Set(fs.map((f) => f.domain))],
    };
  });
}
