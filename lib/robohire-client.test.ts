// @vitest-environment node

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseResumeDirect,
  matchResumeDirect,
  generateJdDirect,
  inviteCandidateDirect,
  RobohireApiError,
} from './robohire-client';
import type { AgentLogger } from './agent-logger';
import { SYNTHETIC_JPEG, SYNTHETIC_PNG } from './resume-convert/image-test-fixtures';

const logApiCall = vi.hoisted(() => vi.fn());
vi.mock('./external-api-log', () => ({ logApiCall }));

const env = {
  ROBOHIRE_API_BASE_URL: 'https://api.robohire.io',
  ROBOHIRE_API_KEY: 'rh_test_key',
  ROBOHIRE_TIMEOUT_MS: '120000',
};
function classicPdf(): Buffer {
  const body = Buffer.from(
    '%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n',
    'ascii',
  );
  const xref = Buffer.from(
    'xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n' +
      'trailer\n<< /Size 2 /Root 1 0 R >>\n',
    'ascii',
  );
  return Buffer.concat([
    body,
    xref,
    Buffer.from(`startxref\n${body.length}\n%%EOF\n`, 'ascii'),
  ]);
}

const VALID_PDF = classicPdf();
const REAL_DOCX = readFileSync(
  join(process.cwd(), 'lib', 'resume-convert', 'fixtures', 'synthetic-resume.docx'),
);

function capturingLogger(apiCall: AgentLogger['apiCall']): AgentLogger {
  return {
    ctx: { agent: 'test', runId: 'run-test', traceId: 'trace-test' },
    step: async <T>(_stepId: string, fn: () => Promise<T>) => fn(),
    event: vi.fn(),
    apiCall,
    currentLogFile: () => 'test.log',
  };
}

beforeEach(() => {
  Object.assign(process.env, env);
  delete process.env.DOCUMENT_CONVERTER_URL;
  logApiCall.mockClear();
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
    const r = await parseResumeDirect(VALID_PDF, 'r.pdf');
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
    await expect(parseResumeDirect(VALID_PDF, 'r.pdf')).rejects.toMatchObject({
      httpStatus: 400,
      code: 'CLIENT',
      requestId: 'req_xyz',
    });
  });

  it('throws RobohireApiError with RATE_LIMITED on 429', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'rate limited' }), { status: 429 }),
    );
    await expect(parseResumeDirect(VALID_PDF, 'r.pdf')).rejects.toMatchObject({
      httpStatus: 429,
      code: 'RATE_LIMITED',
    });
  });

  it('throws QUOTA_EXHAUSTED on 402', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'quota exhausted' }), { status: 402 }),
    );
    await expect(parseResumeDirect(VALID_PDF, 'r.pdf')).rejects.toMatchObject({
      code: 'QUOTA_EXHAUSTED',
    });
  });

  it('passes X-Trace-Id header when opts.traceId set', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ success: true, data: {}, cached: true, requestId: 'r' })));
    await parseResumeDirect(VALID_PDF, 'r.pdf', { traceId: 'trace-123' });
    const init = (fetchSpy.mock.calls[0][1] ?? {}) as RequestInit;
    expect((init.headers as Record<string, string>)['X-Trace-Id']).toBe('trace-123');
  });

  // A scanned/image-only/corrupt PDF: RoboHire is healthy and tells us, in plain
  // words, that THIS document has no extractable text. That is a document-content
  // problem, not a vendor outage — it must NOT be coded SERVER (which the
  // dependency-health classifier treats as a recoverable RoboHire degradation).
  it('throws UNPARSEABLE when RoboHire reports no extractable text (200 success:false)', async () => {
    const vendorError =
      'PDF extraction failed: no text for 张三候选人.pdf / 19999990001 / private resume body';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: vendorError,
          requestId: 'req_np',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const error = await parseResumeDirect(VALID_PDF, 'scan.pdf').catch((caught) => caught);
    expect(error).toMatchObject({
      code: 'UNPARSEABLE',
      requestId: 'req_np',
      message: 'parse-resume returned success=false (UNPARSEABLE)',
    });
    expect(JSON.stringify(logApiCall.mock.calls)).not.toContain(vendorError);
    expect(logApiCall.mock.calls.at(-1)?.[0]?.response).toMatchObject({
      error_category: 'UNPARSEABLE',
    });
  });

  it('also detects an unparseable-document message delivered as a 5xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, error: 'document is corrupt and unparseable' }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(parseResumeDirect(VALID_PDF, 'r.pdf')).rejects.toMatchObject({
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
    await expect(parseResumeDirect(VALID_PDF, 'r.pdf')).rejects.toMatchObject({
      code: 'SERVER',
    });
  });

  it('converts DOCX first and sends only the verified PDF bytes to RoboHire', async () => {
    process.env.DOCUMENT_CONVERTER_URL = 'http://gotenberg:3000';
    const convertedPdf = VALID_PDF;
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array(convertedPdf), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: { name: 'Converted Candidate' },
        cached: false,
        requestId: 'req_converted',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await parseResumeDirect(REAL_DOCX, 'candidate.docx');

    expect(result.requestId).toBe('req_converted');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://gotenberg:3000/forms/libreoffice/convert');
    const robohireBody = fetchSpy.mock.calls[1][1]?.body as FormData;
    const uploadedPdf = robohireBody.get('file') as File;
    expect(uploadedPdf.name).toBe('resume.pdf');
    expect(uploadedPdf.type).toBe('application/pdf');
    expect(Buffer.from(await uploadedPdf.arrayBuffer())).toEqual(convertedPdf);
  });

  it('converts an image first and never sends or logs the original image bytes/filename to RoboHire', async () => {
    process.env.DOCUMENT_CONVERTER_URL = 'http://gotenberg:3000';
    const convertedPdf = VALID_PDF;
    const apiCall = vi.fn<AgentLogger['apiCall']>();
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array(convertedPdf), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          name: 'Image Candidate',
          email: 'image.candidate@example.invalid',
          phone: '19999990001',
          rawText: 'PRIVATE SYNTHETIC RESUME BODY',
          experience: [{ company: 'Private Example Company' }],
          education: [{ institution: 'Private Example University' }],
          skills: { technical: ['TypeScript', 'Testing'] },
        },
        cached: false,
        requestId: 'req_image_converted',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const result = await parseResumeDirect(SYNTHETIC_JPEG, '张三候选人.JPG', {
      logger: capturingLogger(apiCall),
    });

    expect(result.requestId).toBe('req_image_converted');
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const converterBody = fetchSpy.mock.calls[0][1]?.body as FormData;
    const converterImage = converterBody.get('files') as File;
    expect(converterImage.name).toBe('resume.jpeg');
    expect(converterImage.type).toBe('image/jpeg');
    expect(Buffer.from(await converterImage.arrayBuffer())).toEqual(SYNTHETIC_JPEG);

    const robohireBody = fetchSpy.mock.calls[1][1]?.body as FormData;
    const uploadedPdf = robohireBody.get('file') as File;
    const uploadedBytes = Buffer.from(await uploadedPdf.arrayBuffer());
    expect(uploadedPdf.name).toBe('resume.pdf');
    expect(uploadedPdf.type).toBe('application/pdf');
    expect(uploadedBytes).toEqual(convertedPdf);
    expect(uploadedBytes).not.toEqual(SYNTHETIC_JPEG);

    const parseCall = apiCall.mock.calls.find(([label]) => label === 'RoboHire.parseResume');
    expect(parseCall?.[1]?.request).toMatchObject({
      filename: 'resume.pdf',
      source_format: 'jpeg',
      converted: true,
    });
    expect(parseCall?.[1]?.response).toEqual({
      http_status: 200,
      success: true,
      cached: false,
      request_id: 'req_image_converted',
      data_present: true,
      data_field_count: 7,
      experience_count: 1,
      education_count: 1,
      skill_count: 2,
      error_category: null,
    });

    const durableCall = logApiCall.mock.calls.find(([entry]) =>
      entry?.label === 'RoboHire.parseResume');
    expect(durableCall?.[0]?.response).toEqual(parseCall?.[1]?.response);
    const auditJson = JSON.stringify({ parseCall, durableCall });
    for (const forbidden of [
      '张三候选人',
      'Image Candidate',
      'image.candidate@example.invalid',
      '19999990001',
      'PRIVATE SYNTHETIC RESUME BODY',
      'Private Example Company',
      'Private Example University',
    ]) {
      expect(auditJson).not.toContain(forbidden);
    }
  });

  it('keeps image-only converted PDFs UNPARSEABLE when RoboHire extracts no text', async () => {
    process.env.DOCUMENT_CONVERTER_URL = 'http://gotenberg:3000';
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array(VALID_PDF), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        error: 'PDF extraction failed: no text could be extracted by any method',
        requestId: 'req_image_no_text',
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

    await expect(parseResumeDirect(SYNTHETIC_PNG, 'scan.png')).rejects.toMatchObject({
      code: 'UNPARSEABLE',
      requestId: 'req_image_no_text',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('never calls RoboHire when Office conversion fails', async () => {
    process.env.DOCUMENT_CONVERTER_URL = 'http://gotenberg:3000';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('converter unavailable', { status: 503 }),
    );

    await expect(parseResumeDirect(REAL_DOCX, 'candidate.docx')).rejects.toMatchObject({
      code: 'CONVERTER_UNAVAILABLE',
      category: 'dependency',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects non-PDF/non-Office bytes before any external request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(parseResumeDirect(Buffer.from('not a document'), 'candidate.pdf')).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      category: 'document',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
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

  it.each([
    ['parse failed', { stages: { parse: 'failed', generate: 'success' } }, 'parse=failed generate=success'],
    ['generate failed', { stages: { parse: 'success', generate: 'failed' } }, 'parse=success generate=failed'],
    ['stage skipped/unknown', { stages: { parse: 'skipped', generate: 'unknown' } }, 'parse=skipped generate=unknown'],
    ['wrong casing', { stages: { parse: 'SUCCESS', generate: 'success' } }, 'parse=SUCCESS generate=success'],
    ['missing generate', { stages: { parse: 'success' } }, 'parse=success generate=missing'],
    ['missing stages', undefined, 'parse=missing generate=missing'],
  ])('rejects a 200 response when %s', async (_label, meta, expectedDetail) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { title: 'Looks usable', description: 'real body from a partial pipeline' },
          ...(meta === undefined ? {} : { meta }),
          requestId: 'req_jd_stage_gate',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(
      generateJdDirect({ prompt: 'a valid prompt long enough to pass' }),
    ).rejects.toMatchObject({
      httpStatus: 502,
      code: 'SERVER',
      requestId: 'req_jd_stage_gate',
      message: expect.stringContaining(expectedDetail),
    });
  });

  it('accepts a fully-successful generate-jd (both stages strictly equal success)', async () => {
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

  it('passes X-Trace-Id header', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            data: {},
            meta: { stages: { parse: 'success', generate: 'success' } },
            requestId: 'r',
          }),
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
