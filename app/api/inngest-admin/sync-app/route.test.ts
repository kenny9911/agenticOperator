import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POST } from './route';

const originalFetch = global.fetch;

function makeReq(body: unknown): Request {
  return new Request('http://localhost/api/inngest-admin/sync-app', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/inngest-admin/sync-app', () => {
  beforeEach(() => {
    vi.stubEnv('INNGEST_BASE_URL', 'http://test-inngest:8288');
    global.fetch = originalFetch;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    global.fetch = originalFetch;
  });

  it('400 when body is invalid JSON', async () => {
    const r = await POST(new Request('http://x/api/inngest-admin/sync-app', {
      method: 'POST',
      body: 'not json',
    }));
    expect(r.status).toBe(400);
  });

  it('400 when url field missing', async () => {
    const r = await POST(makeReq({}));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toMatch(/url/i);
  });

  it('400 when url is malformed', async () => {
    const r = await POST(makeReq({ url: 'not-a-url' }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toMatch(/Invalid URL/);
  });

  it('400 when url points at a per-domain endpoint', async () => {
    const r = await POST(makeReq({ url: 'http://app:3002/api/inngest/能源调度-v1' }));
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toMatch(/RAAS-v1 main endpoint/);
  });

  it('400 in production when url host is not an allowed AO serve origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INNGEST_SERVE_ORIGIN', 'http://allowed-app:3002');

    const r = await POST(makeReq({ url: 'http://other-app:3002/api/inngest' }));

    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/not allowed in production/);
  });

  it('allows INNGEST_SERVE_ORIGIN in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('INNGEST_SERVE_ORIGIN', 'http://allowed-app:3002/');
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, modified: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: { apps: [{ name: 'agentic-operator-main', functionCount: 6 }] },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const r = await POST(makeReq({ url: 'http://allowed-app:3002/api/inngest' }));

    expect(r.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('PUTs the main SDK endpoint and verifies function count on success', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, modified: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          data: { apps: [{ name: 'agentic-operator-main', functionCount: 6 }] },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    global.fetch = fetchSpy as unknown as typeof fetch;

    const r = await POST(makeReq({ url: 'http://app:3002/api/inngest' }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    expect(j.appUrl).toBe('http://app:3002/api/inngest');
    expect(j.inngestUrl).toBe('http://test-inngest:8288');
    expect(j.functionsRegistered).toBe(6);
    expect(j.expectedFunctions).toBe(6);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(calledUrl).toBe('http://app:3002/api/inngest');
    expect((calledInit as RequestInit).method).toBe('PUT');
  });

  it('502 when Inngest fetch throws', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')) as unknown as typeof fetch;
    const r = await POST(makeReq({ url: 'http://app:3002/api/inngest' }));
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/ECONNREFUSED/);
  });

  it('502 when Inngest returns non-2xx', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'unreachable callback' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const r = await POST(makeReq({ url: 'http://app:3002/api/inngest' }));
    expect(r.status).toBe(502);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.status).toBe(400);
    expect(j.error).toMatch(/unreachable/);
  });
});
