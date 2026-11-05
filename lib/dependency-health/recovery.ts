// Automatic recovery: a successful call (`dependency_ok` LogEvent, written by
// recordDependencyOk) proves the dependency works again, so every degraded
// signal at/before it — for the same (provider, domain) — is dropped. The
// monitor then stops reporting the group, the sweeper resolves the alert and
// posts a 故障恢复 message. Mirrors reset.ts (operator "I topped up"), but
// driven by real traffic and scoped per domain. Pure.

import { RECRUITMENT_DOMAIN_ID } from '../domain-ids';
import type { DepFailure, DepProvider, DepSuccess } from './types';

const PROVIDERS: ReadonlySet<string> = new Set<DepProvider>(['robohire', 'llm', 'rmhr']);

export function parseOkRow(row: { ts: Date; payloadJson: string | null }): DepSuccess | null {
  if (!row.payloadJson) return null;
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(row.payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof p.provider !== 'string' || !PROVIDERS.has(p.provider)) return null;
  const domain = typeof p.domain === 'string' && p.domain.length > 0 ? p.domain : RECRUITMENT_DOMAIN_ID;
  return { provider: p.provider as DepProvider, domain, ts: row.ts };
}

/** Drop failures at/before the latest success for their (provider, domain). */
export function applyRecoveries(failures: DepFailure[], successes: DepSuccess[]): DepFailure[] {
  if (successes.length === 0) return failures;
  const latest = new Map<string, number>();
  for (const s of successes) {
    const key = `${s.provider}::${s.domain}`;
    const ms = s.ts.getTime();
    const prev = latest.get(key);
    if (prev === undefined || ms > prev) latest.set(key, ms);
  }
  return failures.filter((f) => {
    const cutoff = latest.get(`${f.provider}::${f.domain}`);
    return cutoff === undefined || f.ts.getTime() > cutoff;
  });
}
