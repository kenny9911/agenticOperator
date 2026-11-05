import { describe, it, expect, vi } from 'vitest';
import { NonRetriableError } from 'inngest';
import {
  reportDependencyDegraded,
  recordDependencySignal,
  isRecoverableReason,
  recordDependencyOk,
  __resetDependencyOkThrottle,
  DEP_OK_THROTTLE_MS,
} from './report';
import type { DepOutcome } from './types';

function degraded(over: Partial<Extract<DepOutcome, { ok: false }>>): Extract<DepOutcome, { ok: false }> {
  return { ok: false, provider: 'robohire', op: 'parseResume', reason: 'quota', detail: 'no funds', ...over };
}

describe('reportDependencyDegraded', () => {
  it('writes one dependency_degraded signal carrying the structured payload, then throws', async () => {
    const writes: any[] = [];
    const fakeRecord = async (input: any) => {
      writes.push(input);
    };

    await expect(
      reportDependencyDegraded(
        degraded({ reason: 'quota' }),
        { agent: 'ResumeParser', runId: 'run_1', domain: '招聘-v1', anchors: { candidate_id: 'c1' } },
        { recordLogEvent: fakeRecord },
      ),
    ).rejects.toBeInstanceOf(Error);

    expect(writes).toHaveLength(1);
    expect(writes[0].type).toBe('dependency_degraded');
    expect(writes[0].agent).toBe('ResumeParser');
    expect(writes[0].runId).toBe('run_1');
    const payload = JSON.parse(writes[0].payloadJson);
    expect(payload).toMatchObject({
      provider: 'robohire',
      op: 'parseResume',
      reason: 'quota',
      domain: '招聘-v1',
      anchors: { candidate_id: 'c1' },
    });
  });

  it('recoverable reasons (quota/rate_limit/network/server) throw a RETRIABLE error (parks + retries)', async () => {
    const noop = async () => {};
    for (const reason of ['quota', 'rate_limit', 'network', 'server'] as const) {
      const err = await reportDependencyDegraded(degraded({ reason }), { domain: '招聘-v1' }, { recordLogEvent: noop }).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(NonRetriableError);
    }
  });

  it('non-recoverable reasons (auth) throw NonRetriableError (hard fail, no retry)', async () => {
    const noop = async () => {};
    const err = await reportDependencyDegraded(degraded({ reason: 'auth' }), { domain: '招聘-v1' }, { recordLogEvent: noop }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(NonRetriableError);
  });

  it('writes the signal BEFORE throwing (await ordering)', async () => {
    let wrote = false;
    const slowRecord = async () => {
      await Promise.resolve();
      wrote = true;
    };
    await reportDependencyDegraded(degraded({}), { domain: '招聘-v1' }, { recordLogEvent: slowRecord }).catch(() => {});
    expect(wrote).toBe(true);
  });
});

describe('recordDependencySignal', () => {
  it('writes the signal and does NOT throw (caller owns the throw/park)', async () => {
    const writes: any[] = [];
    await recordDependencySignal(
      degraded({ provider: 'llm', op: 'ruleCheck', reason: 'quota' }),
      { agent: 'RuleCheck', runId: 'run_9', domain: '招聘-v1' },
      { recordLogEvent: async (i) => void writes.push(i) },
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].type).toBe('dependency_degraded');
    expect(JSON.parse(writes[0].payloadJson)).toMatchObject({ provider: 'llm', reason: 'quota' });
  });
});

describe('isRecoverableReason', () => {
  it('quota/rate_limit/network/server are recoverable; auth/empty are not', () => {
    expect(isRecoverableReason('quota')).toBe(true);
    expect(isRecoverableReason('rate_limit')).toBe(true);
    expect(isRecoverableReason('network')).toBe(true);
    expect(isRecoverableReason('server')).toBe(true);
    expect(isRecoverableReason('auth')).toBe(false);
    expect(isRecoverableReason('empty')).toBe(false);
  });
});

describe('recordDependencyOk', () => {
  const ctx = { agent: 'Matcher', runId: 'r1', domain: '招聘-v1' };

  it('writes a dependency_ok heartbeat with provider/op/domain', async () => {
    __resetDependencyOkThrottle();
    const record = vi.fn().mockResolvedValue(undefined);
    await recordDependencyOk('robohire', 'matchResume', ctx, { recordLogEvent: record, now: () => 1_000 });
    expect(record).toHaveBeenCalledTimes(1);
    const arg = record.mock.calls[0][0];
    expect(arg.type).toBe('dependency_ok');
    expect(JSON.parse(arg.payloadJson)).toEqual({ provider: 'robohire', op: 'matchResume', domain: '招聘-v1' });
  });

  it('is throttled per provider+domain', async () => {
    __resetDependencyOkThrottle();
    const record = vi.fn().mockResolvedValue(undefined);
    await recordDependencyOk('robohire', 'matchResume', ctx, { recordLogEvent: record, now: () => 1_000 });
    await recordDependencyOk('robohire', 'parseResume', ctx, { recordLogEvent: record, now: () => 2_000 });
    await recordDependencyOk('llm', 'ruleCheck', ctx, { recordLogEvent: record, now: () => 2_000 });
    expect(record).toHaveBeenCalledTimes(2);
    await recordDependencyOk('robohire', 'matchResume', ctx, {
      recordLogEvent: record,
      now: () => 1_000 + DEP_OK_THROTTLE_MS,
    });
    expect(record).toHaveBeenCalledTimes(3);
  });

  it('never throws', async () => {
    __resetDependencyOkThrottle();
    const record = vi.fn().mockRejectedValue(new Error('db down'));
    await expect(recordDependencyOk('llm', 'ruleCheck', ctx, { recordLogEvent: record })).resolves.toBeUndefined();
  });
});
