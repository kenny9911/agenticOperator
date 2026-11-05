import { describe, it, expect } from 'vitest';
import { applyRecoveries, parseOkRow } from './recovery';
import type { DepFailure, DepSuccess } from './types';

const at = (iso: string) => new Date(`2026-11-05T${iso}Z`);

function fail(over: Partial<DepFailure>): DepFailure {
  return {
    provider: 'robohire',
    op: 'matchResume',
    reason: 'server',
    domain: '招聘-v1',
    runId: null,
    ts: at('10:00:00'),
    ...over,
  };
}
const ok = (over: Partial<DepSuccess>): DepSuccess => ({
  provider: 'robohire',
  domain: '招聘-v1',
  ts: at('10:05:00'),
  ...over,
});

describe('applyRecoveries', () => {
  it('drops failures at/before the latest success of the same provider+domain', () => {
    const fs = [fail({ ts: at('10:00:00') }), fail({ ts: at('10:05:00') }), fail({ ts: at('10:06:00') })];
    const out = applyRecoveries(fs, [ok({ ts: at('10:05:00') })]);
    expect(out.map((f) => f.ts.toISOString())).toEqual([at('10:06:00').toISOString()]);
  });
  it('a success clears the whole outage (→ no verdict → alert resolves)', () => {
    const fs = [fail({}), fail({ ts: at('10:01:00') }), fail({ ts: at('10:02:00') })];
    expect(applyRecoveries(fs, [ok({})])).toEqual([]);
  });
  it('is scoped per provider and per domain', () => {
    const fs = [fail({ provider: 'llm' }), fail({ domain: 'other-v1' }), fail({})];
    const out = applyRecoveries(fs, [ok({})]);
    expect(out).toHaveLength(2);
    expect(out.some((f) => f.provider === 'llm')).toBe(true);
    expect(out.some((f) => f.domain === 'other-v1')).toBe(true);
  });
  it('no successes → unchanged', () => {
    const fs = [fail({})];
    expect(applyRecoveries(fs, [])).toBe(fs);
  });
});

describe('parseOkRow', () => {
  it('parses provider + domain, defaulting the domain', () => {
    expect(parseOkRow({ ts: at('10:00:00'), payloadJson: JSON.stringify({ provider: 'llm', domain: 'x' }) })).toEqual({
      provider: 'llm',
      domain: 'x',
      ts: at('10:00:00'),
    });
    expect(parseOkRow({ ts: at('10:00:00'), payloadJson: JSON.stringify({ provider: 'robohire' }) })?.domain).toBeTruthy();
  });
  it('rejects malformed rows', () => {
    expect(parseOkRow({ ts: at('10:00:00'), payloadJson: null })).toBeNull();
    expect(parseOkRow({ ts: at('10:00:00'), payloadJson: '{bad' })).toBeNull();
    expect(parseOkRow({ ts: at('10:00:00'), payloadJson: JSON.stringify({ provider: 'nope' }) })).toBeNull();
  });
});
