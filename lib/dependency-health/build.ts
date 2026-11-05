// Merge the live degraded-call window with the firing 消息通知 alerts into the
// coherent per-provider view the Dependency Health card renders. The firing
// alert is AUTHORITATIVE for the headline (it's the deduped, auto-resolving
// source of truth) — so we never show a provider as "healthy" while its alert is
// still firing — while the window enriches it with the affected ops/domains.
// Pure: the route just feeds it prisma rows.

import { summarizeDependencyHealth, type ProviderSeverity } from './summarize';
import type { MonitorThresholds } from '../monitor/monitor-types';
import type { DepFailure, DepLabel, DepProvider } from './types';
import type { DependencyHealthRow } from './contract';

const PROVIDERS: ReadonlySet<string> = new Set<DepProvider>(['robohire', 'llm']);
const LABELS: ReadonlySet<string> = new Set<DepLabel | 'healthy' | 'watching'>([
  'out_of_funds',
  'fault_warning',
  'fault',
  'unknown',
  'healthy',
  'watching',
]);

/** A firing dep_down alert, normalized from a Notification row. */
export interface FiringDepAlert {
  provider: DepProvider;
  domain: string;
  label: DepLabel | 'watching';
  severity: ProviderSeverity;
  count: number;
  sinceTs: string;
  notificationId: string;
}

/** Minimal Notification shape the parser needs (matches the prisma select). */
export interface FiringNotificationRow {
  id: string;
  dedupeKey: string | null;
  severity: string; // "critical" | "warning" | "info"
  count: number;
  firstSeenAt: Date;
  anchorsJson: string | null;
}

function severityToProvider(sev: string): ProviderSeverity {
  if (sev === 'critical') return 'critical';
  if (sev === 'warning') return 'warn';
  return 'info';
}

/** Reconstruct a FiringDepAlert from a firing `dep_down.*` notification, or null. */
export function parseFiringDepAlert(row: FiringNotificationRow): FiringDepAlert | null {
  const key = row.dedupeKey;
  if (!key || !key.startsWith('dep_down.')) return null;
  // dep_down.<provider>.<domain> — domain may itself contain dots, so split on
  // the first two segments and keep the remainder as the domain.
  const rest = key.slice('dep_down.'.length);
  const dot = rest.indexOf('.');
  if (dot < 0) return null;
  const provider = rest.slice(0, dot);
  const domain = rest.slice(dot + 1);
  if (!PROVIDERS.has(provider) || !domain) return null;

  const severity = severityToProvider(row.severity);
  // Prefer the structured label the monitor stamped into anchors; else derive a
  // coarse label from the alert severity (older alerts before the stamp).
  let label: DepLabel | 'watching' = severity === 'critical' ? 'unknown' : 'watching';
  if (row.anchorsJson) {
    try {
      const a = JSON.parse(row.anchorsJson) as Record<string, unknown>;
      if (typeof a.dep_label === 'string' && LABELS.has(a.dep_label) && a.dep_label !== 'healthy') {
        label = a.dep_label as DepLabel | 'watching';
      }
    } catch {
      /* ignore malformed anchors */
    }
  }

  return {
    provider: provider as DepProvider,
    domain,
    label,
    severity,
    count: row.count,
    sinceTs: row.firstSeenAt.toISOString(),
    notificationId: row.id,
  };
}

/** A recent 故障恢复 message (posted when a dep_down alert was resolved). */
export interface RecentRecovery {
  provider: DepProvider;
  ts: string;
  notificationId: string;
}

/** Minimal Notification shape for a 故障恢复 message (matches the prisma select). */
export interface RecoveryNotificationRow {
  id: string;
  ts: Date;
  anchorsJson: string | null;
}

/** Reconstruct a RecentRecovery from a 故障恢复 message row, or null. */
export function parseRecoveryRow(row: RecoveryNotificationRow): RecentRecovery | null {
  if (!row.anchorsJson) return null;
  try {
    const a = JSON.parse(row.anchorsJson) as Record<string, unknown>;
    const provider = a.dep_recovered;
    if (typeof provider !== 'string' || !PROVIDERS.has(provider)) return null;
    return { provider: provider as DepProvider, ts: row.ts.toISOString(), notificationId: row.id };
  } catch {
    return null;
  }
}

/**
 * Build the per-provider rows: window-derived, overridden by any firing alert.
 * A provider with no failures, no firing alert, but a recent 故障恢复 message is
 * shown as 'recovered' (green) so operators see "it was down, now it's back".
 */
export function buildDependencyHealth(
  failures: DepFailure[],
  firing: FiringDepAlert[],
  t: MonitorThresholds,
  recoveries: RecentRecovery[] = [],
): DependencyHealthRow[] {
  const latestRecovery = new Map<DepProvider, RecentRecovery>();
  for (const r of recoveries) {
    const prev = latestRecovery.get(r.provider);
    if (!prev || r.ts > prev.ts) latestRecovery.set(r.provider, r);
  }
  const firstByProvider = new Map<DepProvider, FiringDepAlert>();
  for (const a of firing) {
    if (!firstByProvider.has(a.provider)) firstByProvider.set(a.provider, a);
  }

  return summarizeDependencyHealth(failures, t).map((base) => {
    const alert = firstByProvider.get(base.provider);
    if (!alert) {
      const rec = latestRecovery.get(base.provider);
      if (rec && base.label === 'healthy') {
        return { ...base, label: 'recovered' as const, severity: 'ok' as const, sinceTs: rec.ts, notificationId: rec.notificationId };
      }
      return { ...base, notificationId: null };
    }
    // Firing alert wins the headline (label/severity) and owns "since" (when the
    // alarm started). The failure COUNT and last-failure time stay window-derived
    // so "N 次失败" means actual degraded calls, not how many sweeps re-fired.
    return {
      ...base,
      label: alert.label,
      severity: alert.severity,
      sinceTs: alert.sinceTs,
      notificationId: alert.notificationId,
    };
  });
}
