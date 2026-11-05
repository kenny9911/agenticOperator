import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/server/db', () => ({
  prisma: {
    notification: { findMany: vi.fn() },
    logEvent: { findMany: vi.fn() },
  },
}));

import { GET } from './route';
import { prisma } from '@/server/db';

const ts = new Date('2026-06-05T10:00:00Z');
const since = new Date('2026-06-05T09:30:00Z');

describe('GET /api/dependency-health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.notification.findMany as any).mockResolvedValue([]);
    (prisma.logEvent.findMany as any).mockResolvedValue([]);
  });

  it('returns both providers healthy with partial=false when nothing is degraded', async () => {
    const res = await GET();
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.partial).toBe(false);
    expect(j.windowMinutes).toBeGreaterThan(0);
    expect(j.providers.map((p: any) => p.provider).sort()).toEqual(['llm', 'robohire']);
    expect(j.providers.every((p: any) => p.label === 'healthy' && p.notificationId === null)).toBe(true);
  });

  it('a firing dep_down alert is authoritative and enriched by the window', async () => {
    (prisma.notification.findMany as any).mockResolvedValue([
      {
        id: 'n1',
        dedupeKey: 'dep_down.robohire.招聘-v1',
        severity: 'critical',
        count: 23,
        firstSeenAt: since,
        anchorsJson: JSON.stringify({ dep_label: 'out_of_funds', candidate_id: 'c1' }),
      },
    ]);
    // dependencyFailures reads three lanes — degraded signals, reset markers,
    // and success heartbeats (dependency_ok).
    (prisma.logEvent.findMany as any).mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.category === 'dependency'
          ? [{ runId: 'r1', ts, payloadJson: JSON.stringify({ provider: 'robohire', op: 'parseResume', reason: 'quota', domain: '招聘-v1' }) }]
          : [],
      ),
    );

    const res = await GET();
    const j = await res.json();
    const robo = j.providers.find((p: any) => p.provider === 'robohire');
    expect(robo).toMatchObject({
      label: 'out_of_funds',
      severity: 'critical',
      failureCount: 1, // actual degraded calls in the window (not the alarm dedupe count)
      notificationId: 'n1',
      sinceTs: since.toISOString(), // since = alarm start, from the alert
    });
    expect(robo.affectedOps).toContain('parseResume');
    expect(j.providers.find((p: any) => p.provider === 'llm')).toMatchObject({ label: 'healthy', notificationId: null });
  });

  it('degrades to partial=true (all healthy) when a read throws', async () => {
    (prisma.notification.findMany as any).mockRejectedValue(new Error('db down'));
    const res = await GET();
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.partial).toBe(true);
    expect(j.providers).toHaveLength(2);
  });

  it('a successful call after the failures clears them (recovered dependency is not stuck on 故障)', async () => {
    const fail = (min: number) => ({
      runId: 'r1',
      ts: new Date(`2026-06-05T10:0${min}:00Z`),
      payloadJson: JSON.stringify({ provider: 'robohire', op: 'matchResume', reason: 'server', domain: '招聘-v1' }),
    });
    (prisma.logEvent.findMany as any).mockImplementation((args: any) => {
      const c = args?.where?.category;
      if (c === 'dependency') return Promise.resolve([fail(0), fail(1), fail(2), fail(3), fail(4), fail(5)]);
      if (c === 'dependency_ok')
        return Promise.resolve([
          { ts: new Date('2026-06-05T10:06:00Z'), payloadJson: JSON.stringify({ provider: 'robohire', op: 'matchResume', domain: '招聘-v1' }) },
        ]);
      return Promise.resolve([]);
    });
    const res = await GET();
    const robo = (await res.json()).providers.find((p: any) => p.provider === 'robohire');
    expect(robo).toMatchObject({ label: 'healthy', failureCount: 0 });
  });

  it('shows 故障恢复 when a recent recovery message exists and nothing is failing', async () => {
    (prisma.notification.findMany as any).mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.kind === 'message'
          ? [{ id: 'rec1', ts, anchorsJson: JSON.stringify({ dep_recovered: 'robohire', dep_domain: '招聘-v1' }) }]
          : [],
      ),
    );
    const res = await GET();
    const robo = (await res.json()).providers.find((p: any) => p.provider === 'robohire');
    expect(robo).toMatchObject({ label: 'recovered', severity: 'ok', notificationId: 'rec1' });
  });
});
