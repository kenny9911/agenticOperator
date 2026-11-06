import { describe, it, expect } from 'vitest';
import { dependencyMonitor, judgeDependency } from './dependency';
import { DEFAULT_THRESHOLDS, type MonitorReadPort } from './monitor-types';
import type { DepFailure } from '../dependency-health/types';

const T = DEFAULT_THRESHOLDS;

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

function fakePort(failures: DepFailure[]): MonitorReadPort {
  return {
    inflightRuns: async () => [],
    stepTimings: async () => [],
    recentRuns: async () => [],
    tokenUsageByRun: async () => ({}),
    toolStepCounts: async () => ({}),
    errorWindow: async () => ({ total: 0, byAgent: {} }),
    dependencyFailures: async () => failures,
    staleNeedsHuman: async () => [],
  };
}

describe('judgeDependency', () => {
  it('any quota signal → out_of_funds / critical, even at N=1', () => {
    expect(judgeDependency([dep({ reason: 'quota' })], T)).toEqual({ label: 'out_of_funds', level: 'critical' });
  });
  it('pure server/network, N≥min → fault / critical; below min → null', () => {
    const two = [dep({ reason: 'server' }), dep({ reason: 'network' })];
    expect(judgeDependency(two, T)).toEqual({ label: 'fault', level: 'critical' });
    expect(judgeDependency([dep({ reason: 'server' })], T)).toBeNull();
  });
  it('ambiguous (auth/empty/rate_limit) → unknown / warn; escalates to critical when persistent', () => {
    const few = Array.from({ length: T.depFailMinCount }, () => dep({ reason: 'empty' }));
    expect(judgeDependency(few, T)).toEqual({ label: 'unknown', level: 'warn' });
    const many = Array.from({ length: T.depUnknownEscalateCount }, () => dep({ reason: 'rate_limit' }));
    expect(judgeDependency(many, T)).toEqual({ label: 'unknown', level: 'critical' });
  });
  it('a stray ambiguous signal below threshold does not fire', () => {
    expect(judgeDependency([dep({ reason: 'empty' })], T)).toBeNull();
  });
  it('mixed clean-fault + ambiguous → unknown (honest, not a confident fault)', () => {
    const mixed = [dep({ reason: 'server' }), dep({ reason: 'empty' })];
    expect(judgeDependency(mixed, T)).toMatchObject({ label: 'unknown' });
  });
});

describe('dependencyMonitor', () => {
  it('fires one deduped finding per (provider, domain) and lists its key as active', async () => {
    const r = await dependencyMonitor(fakePort([dep({ reason: 'quota' }), dep({ reason: 'quota' })]), T);
    expect(r.prefix).toBe('dep_down.');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].dedupeHint).toBe('dep_down.robohire.招聘-v1');
    expect(r.findings[0].level).toBe('critical');
    expect(r.findings[0].category).toBe('system');
    expect(r.activeKeys).toEqual(['dep_down.robohire.招聘-v1']);
  });

  it('separates providers and domains into distinct alerts', async () => {
    const r = await dependencyMonitor(
      fakePort([
        dep({ provider: 'robohire', domain: '招聘-v1', reason: 'quota' }),
        dep({ provider: 'llm', op: 'ruleCheck', domain: '招聘-v1', reason: 'quota' }),
      ]),
      T,
    );
    expect(r.findings).toHaveLength(2);
    expect(new Set(r.activeKeys)).toEqual(
      new Set(['dep_down.robohire.招聘-v1', 'dep_down.llm.招聘-v1']),
    );
  });

  it('writes business-language copy — no raw codes, names the affected op', async () => {
    const r = await dependencyMonitor(fakePort([dep({ reason: 'quota', op: 'parseResume' })]), T);
    const body = r.findings[0].message;
    expect(body).not.toMatch(/402|QUOTA_EXHAUSTED|quota/);
    expect(body).toContain('简历解析');
    expect(body).toContain('额度');
  });

  it('produces no findings when there are no degraded signals', async () => {
    const r = await dependencyMonitor(fakePort([]), T);
    expect(r.findings).toHaveLength(0);
    expect(r.activeKeys).toHaveLength(0);
  });
});
