import { describe, it, expect, vi } from 'vitest';

// Mock the Inngest client so importing the agent module doesn't register a real fn.
vi.mock('@/server/inngest/client', () => ({
  inngest: { createFunction: vi.fn(() => ({ id: 'rule-check-candidate-identity-agent' })) },
}));

import { candidateIdentityHandler } from './candidate-identity-agent';
import type { CandidateRecord } from '@/lib/rule-check/candidate-match/types';
import type { AiFieldJudge } from '@/lib/rule-check/candidate-match/field-equivalence';

const mkStep = () => {
  const ran: string[] = [];
  return { ran, run: async (id: string, fn: () => unknown) => { ran.push(id); return fn(); } };
};

const newCand = {
  candidate_id: 'cand_new',
  candidate: { name: '张三', mobile: '13800138000', email: 'z@s.com', gender: '男' },
  resume: { education_history: [{ institution: '清华大学', field: 'CS', degree: '本科', graduationYear: '2020' }] },
};

const judgeYes: AiFieldJudge = async () => ({ equivalent: true, confidence: 0.95, reason: 'ok' });

describe('candidateIdentityHandler', () => {
  it('no-ops when the feature flag is disabled (no persist, no engine)', async () => {
    const persist = vi.fn();
    const repo = { findComparisonCandidates: vi.fn() };
    const r = await candidateIdentityHandler(
      { event: { data: newCand }, step: mkStep() },
      { enabled: false, persist, repo, judge: judgeYes },
    );
    expect(r.skipped).toBe('disabled');
    expect(persist).not.toHaveBeenCalled();
    expect(repo.findComparisonCandidates).not.toHaveBeenCalled();
  });

  it('phone-duplicate found → persists candidate-identity audit, samePerson via rule 1', async () => {
    const persist = vi.fn(async () => ({ id: 'orc_x' }));
    const existing: CandidateRecord = { candidate_id: 'cand_old', name: '不同', phone: '13800138000', email: 'x@y.com' };
    const repo = { findComparisonCandidates: vi.fn(async () => [existing]) };
    const r = await candidateIdentityHandler(
      { event: { data: newCand }, step: mkStep(), runId: 'run_1' },
      { enabled: true, persist, repo, judge: judgeYes },
    );
    expect(r.skipped).toBe(false);
    expect(r.samePerson).toBe(true);
    expect(r.matchedRule).toBe('IDENTITY-1');
    expect(persist).toHaveBeenCalledOnce();
    const args = persist.mock.calls[0][0];
    expect(args.agentSlug).toBe('rule-check-candidate-identity');
    expect(args.stage).toBe('候选人入库');
    expect(args.check.decision).toBe('VALIDATED');
  });

  it('empty comparison pool → persists a clean "no duplicate" audit', async () => {
    const persist = vi.fn(async () => ({ id: 'orc_y' }));
    const repo = { findComparisonCandidates: vi.fn(async () => []) };
    const r = await candidateIdentityHandler(
      { event: { data: newCand }, step: mkStep() },
      { enabled: true, persist, repo, judge: judgeYes },
    );
    expect(r.samePerson).toBe(false);
    expect(persist).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0][0].check.decision).toBe('VALIDATED');
  });

  it('weak rule-3 duplicate → needsHumanReview, audit decision VIOLATED', async () => {
    const persist = vi.fn(async () => ({ id: 'orc_z' }));
    // shares the 6 fields (school/major/degree fuzzy via judge) but NOT phone/email.
    const existing: CandidateRecord = {
      candidate_id: 'cand_old', name: '张三', phone: '13900139000', email: 'other@x.com',
      gender: '男', school: '清华', major: '计算机', degree: '学士', graduationYear: '2020',
    };
    const repo = { findComparisonCandidates: vi.fn(async () => [existing]) };
    const r = await candidateIdentityHandler(
      { event: { data: newCand }, step: mkStep() },
      { enabled: true, persist, repo, judge: judgeYes },
    );
    expect(r.matchedRule).toBe('IDENTITY-3');
    expect(r.needsHumanReview).toBe(true);
    expect(persist.mock.calls[0][0].check.decision).toBe('VIOLATED');
  });

  it('strong dup → captures matchedCandidateId + dedupAction=auto-merged (return + audit)', async () => {
    const persist = vi.fn(async () => ({ id: 'orc_m' }));
    const existing: CandidateRecord = { candidate_id: 'cand_old', name: '不同', phone: '13800138000', email: 'x@y.com' };
    const repo = { findComparisonCandidates: vi.fn(async () => [existing]) };
    const r = await candidateIdentityHandler(
      { event: { data: newCand }, step: mkStep(), runId: 'run_m' },
      { enabled: true, persist, repo, judge: judgeYes },
    );
    // return surfaces the matched candidate — the SOURCE of same_as_candidate_id for storage.
    expect(r.matchedCandidateId).toBe('cand_old');
    expect(r.dedupAction).toBe('auto-merged');
    expect(r.sameAsCandidateId).toBe('cand_old');
    // audit selectionNote carries it for /rule-check display.
    const note = persist.mock.calls[0][0].selectionNote as Record<string, unknown>;
    expect(note.matchedCandidateId).toBe('cand_old');
    expect(note.dedupAction).toBe('auto-merged');
  });

  it('weak rule-3 dup → dedupAction=pending-review, knows who but does NOT auto-merge', async () => {
    const persist = vi.fn(async () => ({ id: 'orc_p' }));
    const existing: CandidateRecord = {
      candidate_id: 'cand_old', name: '张三', phone: '13900139000', email: 'other@x.com',
      gender: '男', school: '清华', major: '计算机', degree: '学士', graduationYear: '2020',
    };
    const repo = { findComparisonCandidates: vi.fn(async () => [existing]) };
    const r = await candidateIdentityHandler(
      { event: { data: newCand }, step: mkStep() },
      { enabled: true, persist, repo, judge: judgeYes },
    );
    expect(r.matchedCandidateId).toBe('cand_old'); // we DO know the suspected dup
    expect(r.dedupAction).toBe('pending-review');
    expect(r.sameAsCandidateId).toBeNull();         // but never auto-merge a weak signal
  });

  it('no dup → dedupAction=new-candidate, matchedCandidateId null', async () => {
    const persist = vi.fn(async () => ({ id: 'orc_n' }));
    const repo = { findComparisonCandidates: vi.fn(async () => []) };
    const r = await candidateIdentityHandler(
      { event: { data: newCand }, step: mkStep() },
      { enabled: true, persist, repo, judge: judgeYes },
    );
    expect(r.matchedCandidateId).toBeNull();
    expect(r.dedupAction).toBe('new-candidate');
    expect(r.sameAsCandidateId).toBeNull();
  });

  it('retries instead of returning a decision when its audit cannot persist', async () => {
    const persist = vi.fn(async () => { throw new Error('db down'); });
    const repo = { findComparisonCandidates: vi.fn(async () => []) };
    await expect(candidateIdentityHandler(
      { event: { data: newCand }, step: mkStep() },
      { enabled: true, persist, repo, judge: judgeYes },
    )).rejects.toThrow(/RULE_AUDIT_PERSISTENCE_FAILED.*db down/);
  });
});
