import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockListFunctions = vi.fn();
const mockListApps = vi.fn();
vi.mock('@/lib/inngest-admin-client', () => ({
  listFunctions: () => mockListFunctions(),
  listApps: () => mockListApps(),
}));

const mockEmFindUnique = vi.fn();
const mockEventDefCount = vi.fn();
const mockAgentActivityCount = vi.fn();
vi.mock('@/server/db', () => ({
  prisma: {
    emSystemStatus: { findUnique: () => mockEmFindUnique() },
    eventDefinition: { count: () => mockEventDefCount() },
    agentActivity: { count: () => mockAgentActivityCount() },
  },
}));

describe('GET /api/system/config', () => {
  beforeEach(() => {
    mockListFunctions.mockReset();
    mockListApps.mockReset();
    mockEmFindUnique.mockReset();
    mockEventDefCount.mockReset();
    mockAgentActivityCount.mockReset();
    delete process.env.INNGEST_SERVE_HOST;
    delete process.env.INNGEST_SERVE_ORIGIN;
    delete process.env.INNGEST_SERVE_PATH;
    delete process.env.AO_LAN_IP;
    delete process.env.AO_PORT;
    vi.resetModules();
  });

  it('returns inngest.url + sourceEnv + counts', async () => {
    process.env.INNGEST_BASE_URL = 'http://test-host:8288';
    mockListFunctions.mockResolvedValue([
      { id: 'a', slug: 's-a', name: 'A', triggers: [] },
      { id: 'b', slug: 's-b', name: 'B', triggers: [] },
    ]);
    mockListApps.mockResolvedValue([{ name: 'agentic-operator-main', url: 'http://x/api/inngest', error: null, connected: true, functionCount: 2, sdkVersion: 'v4.3.0' }]);
    mockEmFindUnique.mockResolvedValue({ neo4jLastSyncAt: new Date(), neo4jLastError: null });
    mockEventDefCount.mockResolvedValue(28);
    mockAgentActivityCount.mockResolvedValue(0);
    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.inngest.url).toBe('http://test-host:8288');
    expect(j.inngest.sourceEnv).toBe('INNGEST_BASE_URL');
    expect(j.inngest.registeredFunctionCount).toBe(2);
    expect(j.inngest.healthy).toBe(true);
    expect(j.inngest.serveEndpointUrl).toBe('http://x/api/inngest');
  });

  it('uses INNGEST_SERVE_ORIGIN + INNGEST_SERVE_PATH for the sync-app default URL', async () => {
    process.env.INNGEST_BASE_URL = 'http://test-host:8288';
    process.env.INNGEST_SERVE_ORIGIN = 'http://host.docker.internal:3002/';
    process.env.INNGEST_SERVE_PATH = 'api/inngest';
    mockListFunctions.mockResolvedValue([]);
    mockListApps.mockResolvedValue([]);
    mockEmFindUnique.mockResolvedValue(null);
    mockEventDefCount.mockResolvedValue(0);
    mockAgentActivityCount.mockResolvedValue(0);
    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.inngest.serveEndpointUrl).toBe('http://host.docker.internal:3002/api/inngest');
    expect(j.inngest.altEnvs.INNGEST_SERVE_ORIGIN).toBe('http://host.docker.internal:3002/');
    expect(j.inngest.altEnvs.INNGEST_SERVE_PATH).toBe('api/inngest');
  });

  it('returns eventEngine.syncedEventCount + staleness', async () => {
    process.env.INNGEST_BASE_URL = 'http://x:8288';
    mockListFunctions.mockResolvedValue([]);
    mockListApps.mockResolvedValue([]);
    mockEmFindUnique.mockResolvedValue({ neo4jLastSyncAt: new Date(), neo4jLastError: null });
    mockEventDefCount.mockResolvedValue(28);
    mockAgentActivityCount.mockResolvedValue(0);
    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.eventEngine.syncedEventCount).toBe(28);
    expect(j.eventEngine.staleness).toMatch(/fresh|stale|never/);
  });

  it('returns staleness=never when lastSyncAt is null', async () => {
    process.env.INNGEST_BASE_URL = 'http://x:8288';
    mockEmFindUnique.mockResolvedValue(null);
    mockEventDefCount.mockResolvedValue(0);
    mockListFunctions.mockResolvedValue([]);
    mockListApps.mockResolvedValue([]);
    mockAgentActivityCount.mockResolvedValue(0);
    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.eventEngine.staleness).toBe('never');
    expect(j.eventEngine.lastSyncAt).toBeNull();
  });

  it('returns healthy=false when Inngest list throws', async () => {
    process.env.INNGEST_BASE_URL = 'http://x:8288';
    mockListFunctions.mockRejectedValue(new Error('down'));
    mockListApps.mockResolvedValue([]);
    mockEmFindUnique.mockResolvedValue(null);
    mockEventDefCount.mockResolvedValue(0);
    mockAgentActivityCount.mockResolvedValue(0);
    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.inngest.healthy).toBe(false);
    expect(j.inngest.registeredFunctionCount).toBe(0);
  });

  it('returns healthy=false when a monitored Inngest app has a sync error', async () => {
    process.env.INNGEST_BASE_URL = 'http://x:8288';
    mockListFunctions.mockResolvedValue([{ id: 'a', slug: 'agentic-operator-main-a', name: 'A', triggers: [] }]);
    mockListApps.mockResolvedValue([
      {
        name: 'agentic-operator-main',
        url: 'http://host.docker.internal:3002/api/inngest',
        error: 'internal_server_error',
        connected: false,
        functionCount: 1,
        sdkVersion: 'v4.3.0',
      },
    ]);
    mockEmFindUnique.mockResolvedValue(null);
    mockEventDefCount.mockResolvedValue(0);
    mockAgentActivityCount.mockResolvedValue(0);
    const { GET } = await import('./route');
    const r = await GET();
    const j = await r.json();
    expect(j.inngest.healthy).toBe(false);
    expect(j.inngest.registeredFunctionCount).toBe(1);
    expect(j.inngest.appErrors).toEqual([
      {
        name: 'agentic-operator-main',
        url: 'http://host.docker.internal:3002/api/inngest',
        error: 'internal_server_error',
      },
    ]);
  });
});
