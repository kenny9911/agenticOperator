import { describe, it, expect } from 'vitest';
import { parseFiringDepAlert, buildDependencyHealth } from './build';
import { DEFAULT_THRESHOLDS } from '../monitor/monitor-types';
import type { DepFailure } from './types';

const T = DEFAULT_THRESHOLDS;
const firstSeen = new Date('2026-06-05T09:30:00Z');

function dep(over: Partial<DepFailure>): DepFailure {
  return {
    provider: 'robohire',
    op: 'parseResume',
    reason: 'quota',
    domain: '招聘-v1',
    runId: null,
    ts: new Date('2026-06-05T10:00:00Z'),
    ...over,
  };
}

describe('parseFiringDepAlert', () => {
  it('parses provider/domain/label/severity/count from a firing dep_down notification', () => {
    const a = parseFiringDepAlert({
      id: 'n1',
      dedupeKey: 'dep_down.robohire.招聘-v1',
      severity: 'critical',
      count: 23,
      firstSeenAt: firstSeen,
      anchorsJson: JSON.stringify({ dep_label: 'out_of_funds', candidate_id: 'c1' }),
    });
    expect(a).toEqual({
      provider: 'robohire',
      domain: '招聘-v1',
      label: 'out_of_funds',
      severity: 'critical',
      count: 23,
      sinceTs: firstSeen.toISOString(),
      notificationId: 'n1',
    });
  });

  it('falls back to a severity-derived label when anchors omit dep_label', () => {
    const a = parseFiringDepAlert({
      id: 'n2',
      dedupeKey: 'dep_down.llm.招聘-v1',
      severity: 'warning',
      count: 4,
      firstSeenAt: firstSeen,
      anchorsJson: null,
    });
    expect(a).toMatchObject({ provider: 'llm', label: 'watching', severity: 'warn' });
  });

  it('returns null for a malformed / non-dependency key', () => {
    expect(parseFiringDepAlert({ id: 'x', dedupeKey: 'error_rate.Matcher', severity: 'warning', count: 1, firstSeenAt: firstSeen, anchorsJson: null })).toBeNull();
    expect(parseFiringDepAlert({ id: 'x', dedupeKey: 'dep_down.bogus.招聘-v1', severity: 'warning', count: 1, firstSeenAt: firstSeen, anchorsJson: null })).toBeNull();
    expect(parseFiringDepAlert({ id: 'x', dedupeKey: null, severity: 'warning', count: 1, firstSeenAt: firstSeen, anchorsJson: null })).toBeNull();
  });
});

describe('buildDependencyHealth', () => {
  it('a firing alert is AUTHORITATIVE — no "healthy" row while an alert is firing', () => {
    // Window is empty (failures aged out) but the alert is still firing.
    const rows = buildDependencyHealth(
      [],
      [{ provider: 'robohire', domain: '招聘-v1', label: 'out_of_funds', severity: 'critical', count: 23, sinceTs: firstSeen.toISOString(), notificationId: 'n1' }],
      T,
    );
    const robo = rows.find((r) => r.provider === 'robohire')!;
    expect(robo.label).toBe('out_of_funds');
    expect(robo.severity).toBe('critical');
    expect(robo.failureCount).toBe(0); // window aged out → actual recent failures = 0
    expect(robo.sinceTs).toBe(firstSeen.toISOString()); // since = alarm start, from the alert
    expect(robo.notificationId).toBe('n1');
  });

  it('enriches the firing row with affected ops/domains from the live window', () => {
    const rows = buildDependencyHealth(
      [dep({ op: 'parseResume' }), dep({ op: 'matchResume' })],
      [{ provider: 'robohire', domain: '招聘-v1', label: 'out_of_funds', severity: 'critical', count: 23, sinceTs: firstSeen.toISOString(), notificationId: 'n1' }],
      T,
    );
    const robo = rows.find((r) => r.provider === 'robohire')!;
    expect(robo.affectedOps.sort()).toEqual(['matchResume', 'parseResume']);
    expect(robo.failureCount).toBe(2); // actual degraded calls in the window
    expect(robo.notificationId).toBe('n1');
  });

  it('keeps window-derived state (watching) when there is no firing alert', () => {
    const rows = buildDependencyHealth([dep({ reason: 'empty' })], [], T);
    const robo = rows.find((r) => r.provider === 'robohire')!;
    expect(robo.label).toBe('watching');
    expect(robo.notificationId).toBeNull();
  });

  it('healthy provider with neither window failures nor an alert', () => {
    const rows = buildDependencyHealth([], [], T);
    expect(rows.find((r) => r.provider === 'llm')!).toMatchObject({ label: 'healthy', notificationId: null, failureCount: 0 });
  });
});
