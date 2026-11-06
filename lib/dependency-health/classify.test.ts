import { describe, it, expect } from 'vitest';
import { RobohireApiError } from '../robohire-client';
import { classifyRobohire, classifyLlm } from './classify';

describe('classifyRobohire — structured errors', () => {
  it('maps QUOTA_EXHAUSTED (402) → quota', () => {
    const e = new RobohireApiError(402, 'QUOTA_EXHAUSTED', 'no funds');
    const oc = classifyRobohire('parseResume', e);
    expect(oc).toMatchObject({ ok: false, provider: 'robohire', op: 'parseResume', reason: 'quota' });
  });
  it('maps RATE_LIMITED (429) → rate_limit', () => {
    expect(classifyRobohire('matchResume', new RobohireApiError(429, 'RATE_LIMITED', 'slow down')))
      .toMatchObject({ ok: false, reason: 'rate_limit' });
  });
  it('maps NETWORK (0) → network', () => {
    expect(classifyRobohire('matchResume', new RobohireApiError(0, 'NETWORK', 'econnreset')))
      .toMatchObject({ ok: false, reason: 'network' });
  });
  it('maps SERVER (5xx) → server', () => {
    expect(classifyRobohire('generateJd', new RobohireApiError(503, 'SERVER', 'down')))
      .toMatchObject({ ok: false, reason: 'server' });
  });
  it('maps 401/403 CLIENT → auth', () => {
    expect(classifyRobohire('parseResume', new RobohireApiError(401, 'CLIENT', 'unauthorized')))
      .toMatchObject({ ok: false, reason: 'auth' });
    expect(classifyRobohire('parseResume', new RobohireApiError(403, 'CLIENT', 'forbidden')))
      .toMatchObject({ ok: false, reason: 'auth' });
  });
  it('maps other 4xx CLIENT → auth (caller treats as non-retriable bad-input)', () => {
    expect(classifyRobohire('parseResume', new RobohireApiError(400, 'CLIENT', 'bad pdf')))
      .toMatchObject({ ok: false, reason: 'auth' });
  });
});

describe('classifyRobohire — empty-200 predicates', () => {
  it('parseResume: empty data → empty; any usable field → ok', () => {
    expect(classifyRobohire('parseResume', { data: {} })).toMatchObject({ ok: false, reason: 'empty' });
    expect(classifyRobohire('parseResume', { data: { name: '陈昊' } })).toEqual({ ok: true });
  });
  it('matchResume: no numeric score → empty; score 0 is valid → ok', () => {
    expect(classifyRobohire('matchResume', { data: {} })).toMatchObject({ ok: false, reason: 'empty' });
    expect(classifyRobohire('matchResume', { data: { matchScore: 0 } })).toEqual({ ok: true });
    expect(classifyRobohire('matchResume', { data: { matchScore: 0.7 } })).toEqual({ ok: true });
  });
  it("matchResume: RoboHire's REAL shape (matchScore=null, real score at overallMatchScore.score / top-level score) → ok", () => {
    // Regression: run 01KV4RMAKD7R3QJSKCJ9MV0R4M scored 82 (grade B+) yet was
    // flagged "empty" → spurious MATCH_FAILED, because matchScore is always null.
    expect(
      classifyRobohire('matchResume', {
        data: { matchScore: null, score: 82, overallMatchScore: { score: 82, grade: 'B+' } },
      }),
    ).toEqual({ ok: true });
    // Score only nested under overallMatchScore (no top-level mirror) → still ok.
    expect(
      classifyRobohire('matchResume', { data: { matchScore: null, overallMatchScore: { score: 0 } } }),
    ).toEqual({ ok: true });
    // Genuinely empty (no score anywhere) → still classified empty.
    expect(
      classifyRobohire('matchResume', { data: { matchScore: null, resumeAnalysis: {} } }),
    ).toMatchObject({ ok: false, reason: 'empty' });
  });
  it('generateJd: no title/description → empty; description present → ok', () => {
    expect(classifyRobohire('generateJd', { data: {} })).toMatchObject({ ok: false, reason: 'empty' });
    expect(classifyRobohire('generateJd', { data: { description: 'We are hiring…' } })).toEqual({ ok: true });
  });
  it('generateJd: 仅 benefits / interviewRequirements 有内容 → ok(判空口径必须与 assembleJdContent 一致)', () => {
    // Regression: assembleJdContent 消费 benefits + interviewRequirements,但旧
    // 判空白名单只认 5 个字段,导致这类"薄但可用"的 JD 被误判空 → false FAILED。
    expect(classifyRobohire('generateJd', { data: { benefits: '五险一金 + 年度期权' } })).toEqual({ ok: true });
    expect(
      classifyRobohire('generateJd', { data: { interviewRequirements: '两轮技术面 + 一轮 HR 面' } }),
    ).toEqual({ ok: true });
  });
  it('generateJd: placeholder title "Untitled" with empty content → empty (title is "Untitled" on success too, so it is never a content signal)', () => {
    // Real RoboHire failure payload (meta.stages.generate="failed"): every content
    // field is "" yet title is the placeholder "Untitled". The old check keyed on
    // `data.title` truthiness → spurious "ok". A title alone is never a usable JD.
    expect(
      classifyRobohire('generateJd', {
        data: {
          title: 'Untitled',
          description: '',
          qualifications: '',
          hardRequirements: '',
          niceToHave: '',
          evaluationRules: '',
        },
      }),
    ).toMatchObject({ ok: false, reason: 'empty' });
  });
  it('generateJd: meta.stages.generate="failed" → server (recoverable) even when title="Untitled" looks present', () => {
    // RoboHire's authoritative failure signal. parse succeeded (input was readable)
    // so a generate failure is a transient vendor-side fault → recoverable.
    expect(
      classifyRobohire('generateJd', {
        data: { title: 'Untitled', qualifications: '', hardRequirements: '', description: '' },
        meta: { stages: { parse: 'success', generate: 'failed' } },
      }),
    ).toMatchObject({ ok: false, reason: 'server' });
  });
  it('generateJd: both stages success + real content → ok', () => {
    expect(
      classifyRobohire('generateJd', {
        data: {
          title: 'Untitled',
          description: '加入腾讯 PCG…',
          qualifications: '## 教育背景…',
          hardRequirements: '1. 全日制本科…',
        },
        meta: { stages: { parse: 'success', generate: 'success' } },
      }),
    ).toEqual({ ok: true });
  });
  it('generateJd: parse="failed" but generate="success" with real content → ok (stages are NON-FATAL; content decides — Gohire contract)', () => {
    // THE bug being fixed: a parse-stage failure still yields a usable JD — generate
    // ran off the raw prompt and produced real body content. The old classifier gated
    // on stage STATUS and folded this to `server` → create-jd discarded a good JD and
    // failed the run. Per the Gohire contract ("each stage is non-fatal; check
    // meta.stages to see which succeeded"), CONTENT decides usability, not stage status.
    expect(
      classifyRobohire('generateJd', {
        data: { description: '岗位职责:负责……', qualifications: '任职要求:本科……' },
        meta: { stages: { parse: 'failed', generate: 'success' } },
      }),
    ).toEqual({ ok: true });
  });
  it('generateJd: parse="failed" + empty content → server (recoverable; a retry may recover the degraded stage)', () => {
    expect(
      classifyRobohire('generateJd', {
        data: {},
        meta: { stages: { parse: 'failed', generate: 'skipped' } },
      }),
    ).toMatchObject({ ok: false, reason: 'server' });
  });
  it('inviteCandidate: no entry fields → empty; login_url/reused present → ok', () => {
    expect(classifyRobohire('inviteCandidate', { data: {} })).toMatchObject({ ok: false, reason: 'empty' });
    expect(classifyRobohire('inviteCandidate', { data: { login_url: 'https://x' } })).toEqual({ ok: true });
    expect(classifyRobohire('inviteCandidate', { data: { reused: true } })).toEqual({ ok: true });
  });
});

describe('classifyLlm', () => {
  it('insufficient_quota / billing keywords → quota', () => {
    expect(classifyLlm('ruleCheck', new Error('insufficient_quota: add credits')))
      .toMatchObject({ ok: false, provider: 'llm', reason: 'quota' });
    expect(classifyLlm('ruleCheck', new Error('billing hard limit reached')))
      .toMatchObject({ ok: false, reason: 'quota' });
  });
  it('timeout / network errors → network', () => {
    expect(classifyLlm('ruleCheck', new Error('llm-timeout'))).toMatchObject({ ok: false, reason: 'network' });
    expect(classifyLlm('ruleCheck', new Error('ECONNREFUSED'))).toMatchObject({ ok: false, reason: 'network' });
  });
  it('429 message → rate_limit; 401/403 → auth; 5xx → server', () => {
    expect(classifyLlm('ruleCheck', new Error('429 Too Many Requests'))).toMatchObject({ reason: 'rate_limit' });
    expect(classifyLlm('ruleCheck', new Error('401 Unauthorized'))).toMatchObject({ reason: 'auth' });
    expect(classifyLlm('ruleCheck', new Error('500 Internal Server Error'))).toMatchObject({ reason: 'server' });
  });
  it('empty / whitespace completion text → empty; real text → ok', () => {
    expect(classifyLlm('ruleCheck', '')).toMatchObject({ ok: false, reason: 'empty' });
    expect(classifyLlm('ruleCheck', '   \n  ')).toMatchObject({ ok: false, reason: 'empty' });
    expect(classifyLlm('ruleCheck', 'decision: PASS')).toEqual({ ok: true });
  });
});
