// GET /api/dependency-health — per-provider health for the Dependency Health
// card. Merges the live degraded-call window (affected ops/domains) with the
// firing 消息通知 alerts (authoritative headline: label / count / since), so the
// card never disagrees with the alert center. Never 500s the fleet page: on any
// read failure it returns all providers healthy with a `partial` flag.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { createPgReadPort } from '@/lib/monitor/pg-read-port';
import { DEFAULT_THRESHOLDS } from '@/lib/monitor/monitor-types';
import { buildDependencyHealth, parseFiringDepAlert } from '@/lib/dependency-health/build';
import type { DependencyHealthResponse, DependencyHealthRow } from '@/lib/dependency-health/contract';
import type { DepProvider } from '@/lib/dependency-health/types';

export async function GET(): Promise<Response> {
  const windowMs = DEFAULT_THRESHOLDS.depFailWindowMs;
  const windowMinutes = Math.round(windowMs / 60_000);

  try {
    const port = createPgReadPort();
    const [failures, firingRows] = await Promise.all([
      port.dependencyFailures(windowMs),
      prisma.notification.findMany({
        where: { status: 'firing', dedupeKey: { startsWith: 'dep_down.' } },
        select: { id: true, dedupeKey: true, severity: true, count: true, firstSeenAt: true, anchorsJson: true },
      }),
    ]);

    const firing = firingRows.map(parseFiringDepAlert).filter((a): a is NonNullable<typeof a> => a !== null);
    const providers = buildDependencyHealth(failures, firing, DEFAULT_THRESHOLDS);

    const body: DependencyHealthResponse = {
      providers,
      windowMinutes,
      generatedAt: new Date().toISOString(),
      partial: false,
    };
    return NextResponse.json(body);
  } catch (e) {
    // Degrade gracefully — the fleet page must never break because this read failed.
    console.warn(`[dependency-health] read failed: ${(e as Error).message}`);
    const healthy: DependencyHealthRow[] = (['robohire', 'llm'] as DepProvider[]).map((provider) => ({
      provider,
      label: 'healthy',
      severity: 'ok',
      failureCount: 0,
      sinceTs: null,
      lastFailureTs: null,
      lastReason: null,
      affectedOps: [],
      affectedDomains: [],
      notificationId: null,
    }));
    const body: DependencyHealthResponse = {
      providers: healthy,
      windowMinutes,
      generatedAt: new Date().toISOString(),
      partial: true,
    };
    return NextResponse.json(body);
  }
}
