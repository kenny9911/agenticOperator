import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseResumeDirect,
  matchResumeDirect,
  generateJdDirect,
  inviteCandidateDirect,
  RobohireApiError,
} from './robohire-client';

const env = {
  ROBOHIRE_API_BASE_URL: 'https://api.robohire.io',
  ROBOHIRE_API_KEY: 'rh_test_key',
  ROBOHIRE_TIMEOUT_MS: '120000',
};

beforeEach(() => {
  Object.assign(process.env, env);
  vi.restoreAllMocks();
});

describe('parseResumeDirect', () => {
  it('returns parsed data on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { name: 'John', skills: ['React'] },
          cached: false,
          requestId: 'req_abc',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await parseResumeDirect(Buffer.from('%PDF-1.4'), 'r.pdf');
    expect(r.data.name).toBe('John');
    expect(r.requestId).toBe('req_abc');
    expect(r.cached).toBe(false);
  });

  it('throws RobohireApiError with CLIENT code on 400', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: 'PDF required', requestId: 'req_xyz' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(parseResumeDirect(Buffer.from(''), 'r.pdf')).rejects.toMatchObject({
      httpStatus: 400,
      code: 'CLIENT',
      requestId: 'req_xyz',
    });
  });

  it('throws RobohireApiError with RATE_LIMITED on 429', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'rate limited' }), { status: 429 }),
    );
    await expect(parseResumeDirect(Buffer.from('%PDF'), 'r.pdf')).rejects.toMatchObject({
      httpStatus: 429,
      code: 'RATE_LIMITED',
    });
  });

  it('throws QUOTA_EXHAUSTED on 402', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'quota exhausted' }), { status: 402 }),
    );
    await expect(parseResumeDirect(Buffer.from('%PDF'), 'r.pdf')).rejects.toMatchObject({
      code: 'QUOTA_EXHAUSTED',
    });
  });

  it('passes X-Trace-Id header when opts.traceId set', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: {}, cached: true, requestId: 'r' })));
    await parseResumeDirect(Buffer.from('%PDF'), 'r.pdf', { traceId: 'trace-123' });
    const init = (fetchSpy.mock.calls[0][1] ?? {}) as RequestInit;
    expect((init.headers as Record<string, string>)['X-Trace-Id']).toBe('trace-123');
  });

  // A scanned/image-only/corrupt PDF: RoboHire is healthy and tells us, in plain
  // words, that THIS document has no extractable text. That is a document-content
  // problem, not a vendor outage — it must NOT be coded SERVER (which the
  // dependency-health classifier treats as a recoverable RoboHire degradation).
  it('throws UNPARSEABLE when RoboHire reports no extractable text (200 success:false)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: 'PDF extraction failed: no text could be extracted by any method',
          requestId: 'req_np',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(parseResumeDirect(Buffer.from('%PDF'), 'scan.pdf')).rejects.toMatchObject({
      code: 'UNPARSEABLE',
      requestId: 'req_np',
    });
  });

  it('also detects an unparseable-document message delivered as a 5xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: 'document is corrupt and unparseable' }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(parseResumeDirect(Buffer.from('%PDF'), 'r.pdf')).rejects.toMatchObject({
      code: 'UNPARSEABLE',
    });
  });

  it('keeps a generic success:false as SERVER (genuine vendor problem, not a document one)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: 'internal pipeline crashed' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(parseResumeDirect(Buffer.from('%PDF'), 'r.pdf')).rejects.toMatchObject({
      code: 'SERVER',
    });
  });
});

describe('matchResumeDirect', () => {
  it('returns match data on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { matchScore: 87, recommendation: 'STRONG_MATCH', summary: 'good' },
          requestId: 'req_match_123',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await matchResumeDirect({ resume: 'resume text', jd: 'jd text' });
    expect(r.data.matchScore).toBe(87);
    expect(r.data.recommendation).toBe('STRONG_MATCH');
  });

  it('serializes resume + jd as JSON body and defaults locale to zh', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: { matchScore: 50, recommendation: 'PARTIAL_MATCH' }, requestId: 'r' })));
    await matchResumeDirect({ resume: 'R', jd: 'J' });
    const body = JSON.parse(((fetchSpy.mock.calls[0][1]?.body as string) ?? '{}'));
    expect(body).toEqual({ resume: 'R', jd: 'J', locale: 'zh' });
  });

  it('honors an explicit locale override', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: { matchScore: 50, recommendation: 'PARTIAL_MATCH' }, requestId: 'r' })));
    await matchResumeDirect({ resume: 'R', jd: 'J', locale: 'en' });
    const body = JSON.parse(((fetchSpy.mock.calls[0][1]?.body as string) ?? '{}'));
    expect(body.locale).toBe('en');
  });
});

describe('generateJdDirect', () => {
  it('returns generate-jd data on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            title: 'Senior FE',
            description: '...',
            qualifications: '...',
            hardRequirements: '...',
            salaryMin: '30',
            salaryMax: '50',
            salaryText: '30-50K',
          },
          meta: { stages: { parse: 'success', generate: 'success' } },
          requestId: 'req_jd_xyz',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await generateJdDirect({ prompt: 'Senior Frontend, React, 5 years, Shenzhen' });
    expect(r.data.title).toBe('Senior FE');
    expect(r.meta?.stages?.parse).toBe('success');
    expect(r.requestId).toBe('req_jd_xyz');
  });

  it('throws RobohireApiError on 400', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'prompt too short', requestId: 'req_x' }), { status: 400 }),
    );
    await expect(generateJdDirect({ prompt: 'x' })).rejects.toMatchObject({ httpStatus: 400, code: 'CLIENT' });
  });

  it('does NOT throw when meta.stages.generate="failed" — stages are non-fatal; the transport client returns the response and the caller (classifyRobohire) judges content', async () => {
    // Gohire contract: generate-jd always returns 200 / success:true; a failed
    // generate stage still returns the response (with meta.stages). The transport
    // client must NOT throw on stage status — emptiness/usability is judged downstream
    // by classifyRobohire (single source of truth), which fails the run on empty content.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { title: 'Untitled', qualifications: '', hardRequirements: '', description: '', evaluationRules: '' },
          meta: { stages: { parse: 'success', generate: 'failed' } },
          requestId: 'req_jd_degraded',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await generateJdDirect({ prompt: 'a valid prompt long enough to pass' });
    expect(r.requestId).toBe('req_jd_degraded');
    expect(r.meta?.stages?.generate).toBe('failed');
  });

  it('does NOT throw when meta.stages.parse="failed" but generate produced usable content — returns the salvageable JD (this used to be discarded)', async () => {
    // The headline bug: parse-fail + generate-ok is a fully usable JD. The client
    // must return it (raw-prompt title and all) so the agent can salvage it.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { title: 'raw prompt echoed as title', description: 'real body from generate', qualifications: 'real quals' },
          meta: { stages: { parse: 'failed', generate: 'success' } },
          requestId: 'req_jd_parsefail',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await generateJdDirect({ prompt: 'a valid prompt long enough to pass' });
    expect(r.data.description).toBe('real body from generate');
    expect(r.meta?.stages?.parse).toBe('failed');
  });

  it('does NOT throw on a fully-successful generate-jd (both stages success)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { title: 'Untitled', description: 'real body', qualifications: 'real quals' },
          meta: { stages: { parse: 'success', generate: 'success' } },
          requestId: 'req_ok',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await generateJdDirect({ prompt: 'a valid prompt long enough to pass' });
    expect(r.requestId).toBe('req_ok');
  });

  it('does NOT throw when meta is absent (older response shape)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ success: true, data: { description: 'body' }, requestId: 'req_nometa' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await generateJdDirect({ prompt: 'a valid prompt long enough to pass' });
    expect(r.requestId).toBe('req_nometa');
  });

  it('passes X-Trace-Id header', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: {}, requestId: 'r' }),
        ),
      );
    await generateJdDirect({ prompt: 'test prompt that is long enough to be valid' }, { traceId: 'trace-jd' });
    const init = (fetchSpy.mock.calls[0][1] ?? {}) as RequestInit;
    expect((init.headers as Record<string, string>)['X-Trace-Id']).toBe('trace-jd');
  });
});

describe('inviteCandidateDirect', () => {
  it('returns fresh invite data on 200', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            email: 'cand@example.com',
            name: 'Zhang San',
            login_url: 'https://gohire.top/i/abc',
            qrcode_url: 'https://gohire.top/qr/abc.png',
            user_id: 1234,
            request_introduction_id: 'rii_xyz',
            company_name: 'AcmeCorp',
            job_title: 'Senior FE',
            job_interview_duration: 30,
            gohire_job_id: 'gh_job_42',
          },
          requestId: 'req_invite_1',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await inviteCandidateDirect({
      resume: 'resume text',
      jd: 'jd text',
      candidate_email: 'cand@example.com',
    });
    expect(r.data.login_url).toBe('https://gohire.top/i/abc');
    expect(r.data.user_id).toBe(1234);
    expect(r.data.gohire_job_id).toBe('gh_job_42');
    expect(r.requestId).toBe('req_invite_1');
  });

  it('returns dedup-hit data with reused:true', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            reused: true,
            email: 'cand@example.com',
            name: 'Zhang San',
            login_url: 'https://gohire.top/i/abc',
            qrcode_url: 'https://gohire.top/qr/abc.png',
            user_id: 'usr_old',
          },
          requestId: 'req_invite_dup',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await inviteCandidateDirect({
      resume_id: 'rsm_existing',
      job_id: 'job_existing',
    });
    expect(r.data.reused).toBe(true);
    expect(r.data.user_id).toBe('usr_old');
  });

  it('throws CLIENT err synchronously when neither resume nor resume_id given', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      inviteCandidateDirect({ jd: 'jd text' } as any),
    ).rejects.toMatchObject({ code: 'CLIENT' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws CLIENT err synchronously when neither jd nor job_id given', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      inviteCandidateDirect({ resume: 'resume text' } as any),
    ).rejects.toMatchObject({ code: 'CLIENT' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws RobohireApiError 402 → QUOTA_EXHAUSTED', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'interview quota exhausted' }), {
        status: 402,
      }),
    );
    await expect(
      inviteCandidateDirect({ resume: 'r', jd: 'j' }),
    ).rejects.toMatchObject({ httpStatus: 402, code: 'QUOTA_EXHAUSTED' });
  });

  it('throws RobohireApiError 4xx with gohire_invitation_failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: 'gohire_invitation_failed',
          code: 'gohire_invitation_failed',
          requestId: 'req_gohire_fail',
        }),
        { status: 422 },
      ),
    );
    await expect(
      inviteCandidateDirect({ resume: 'r', jd: 'j' }),
    ).rejects.toMatchObject({ httpStatus: 422, code: 'CLIENT', requestId: 'req_gohire_fail' });
  });

  it('serializes the full input as JSON + passes Bearer auth + X-Trace-Id', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: { login_url: 'https://x', user_id: 1 },
            requestId: 'r',
          }),
        ),
      );
    await inviteCandidateDirect(
      {
        resume: 'R',
        jd: 'J',
        candidate_email: 'c@e.com',
        recruiter_email: 'rec@e.com',
        interview_language: 'zh',
        interview_duration: 45,
        interview_mode: 'ai_video',
        passing_score: 70,
      },
      { traceId: 'trace-invite' },
    );
    const init = (fetchSpy.mock.calls[0][1] ?? {}) as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer rh_test_key');
    expect((init.headers as Record<string, string>)['X-Trace-Id']).toBe('trace-invite');
    const body = JSON.parse((init.body as string) ?? '{}');
    expect(body).toMatchObject({
      resume: 'R',
      jd: 'J',
      candidate_email: 'c@e.com',
      interview_language: 'zh',
      interview_duration: 45,
      interview_mode: 'ai_video',
      passing_score: 70,
    });
  });

  it('hits the correct endpoint path', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ success: true, data: { login_url: 'https://x' }, requestId: 'r' }),
        ),
      );
    await inviteCandidateDirect({ resume: 'R', jd: 'J' });
    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toBe('https://api.robohire.io/api/v1/invite-candidate');
  });
});

describe('RobohireApiError', () => {
  it('isClientError true for 4xx (excluding 429)', () => {
    expect(new RobohireApiError(400, 'CLIENT', 'x').isClientError).toBe(true);
    expect(new RobohireApiError(429, 'RATE_LIMITED', 'x').isClientError).toBe(false);
    expect(new RobohireApiError(500, 'SERVER', 'x').isClientError).toBe(false);
  });

  it('isBadRequest true for our-fault 4xx (400/422) — NOT 401/403 auth, NOT 5xx', () => {
    // 400/422 = 我们发的入参有问题(prompt 太长/格式非法) → AO 侧 bug,不是厂商健康问题。
    expect(new RobohireApiError(400, 'CLIENT', 'bad prompt').isBadRequest).toBe(true);
    expect(new RobohireApiError(422, 'CLIENT', 'unprocessable').isBadRequest).toBe(true);
    // 401/403 = 密钥失效/被吊销 → 真·厂商/凭证问题,不算 bad request。
    expect(new RobohireApiError(401, 'CLIENT', 'unauthorized').isBadRequest).toBe(false);
    expect(new RobohireApiError(403, 'CLIENT', 'forbidden').isBadRequest).toBe(false);
    // 429 / 5xx / network 都不是 bad request。
    expect(new RobohireApiError(429, 'RATE_LIMITED', 'x').isBadRequest).toBe(false);
    expect(new RobohireApiError(500, 'SERVER', 'x').isBadRequest).toBe(false);
    expect(new RobohireApiError(0, 'NETWORK', 'x').isBadRequest).toBe(false);
  });
});
