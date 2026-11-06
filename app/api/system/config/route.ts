// GET /api/system/config — runtime configuration snapshot.
// Used by <InngestPill /> + <SystemConfigModal /> to show ops which
// Inngest server + Allmeta state + RaaS endpoints are currently wired.
//
// Per spec 2026-05-24 §4.1.

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import { getInngestUrlWithSource, getRaasInngestUrl, type InngestUrlSource } from '@/lib/inngest-url';
import { listApps, listFunctions, type InngestApp } from '@/lib/inngest-admin-client';
import {
  applyRuntimeConfigToEnv,
  getRuntimeConfigState,
  saveRuntimeConfig,
  type RuntimeConfigSaveTarget,
  type RuntimeConfigState,
} from '@/server/ops/runtime-config';
import { closeDriver as closeNeo4jDriver } from '@/server/em/clients/neo4j';

export const dynamic = 'force-dynamic';

export type SystemConfigResponse = {
  inngest: {
    url: string;
    sourceEnv: InngestUrlSource;
    altEnvs: Record<string, string | null>;
    registeredFunctionCount: number;
    runsLast24h: number | null;
    healthy: boolean;
    appErrors: Array<{ name: string; url: string | null; error: string }>;
    serveEndpointUrl: string;
    lastProbeAt: string;
  };
  eventEngine: {
    lastSyncAt: string | null;
    syncedEventCount: number;
    staleSeconds: number | null;
    staleness: 'fresh' | 'stale' | 'never';
    lastError: string | null;
  };
  raas: {
    apiUrl: string | null;
    inngestUrl: string;
    inngestSharedWithLocal: boolean;
    apiHealthy: boolean | null;
  };
  runtimeConfig: RuntimeConfigState;
  generatedAt: string;
};

export type SystemConfigUpdateResponse =
  | {
      ok: true;
      target: RuntimeConfigSaveTarget;
      changedKeys: string[];
      restartRequiredKeys: string[];
      config: SystemConfigResponse;
    }
  | { ok: false; error: string };

const STALENESS_THRESHOLD_MS = 5 * 60 * 1000;
const MAIN_APP_ID = 'agentic-operator-main';

function joinUrl(origin: string, path: string): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${cleanOrigin}${cleanPath}`;
}

function resolveServeEndpointUrl(apps: InngestApp[]): string {
  const servePath = process.env.INNGEST_SERVE_PATH ?? '/api/inngest';
  const serveHost = process.env.INNGEST_SERVE_ORIGIN ?? process.env.INNGEST_SERVE_HOST;
  if (serveHost) return joinUrl(serveHost, servePath);

  const mainUrl = apps.find((a) => a.name === MAIN_APP_ID)?.url;
  if (mainUrl) return mainUrl;

  const host = process.env.AO_LAN_IP ?? 'host.docker.internal';
  const port = process.env.AO_PORT ?? '3002';
  return joinUrl(`http://${host}:${port}`, servePath);
}

async function buildResponse(): Promise<SystemConfigResponse> {
  await applyRuntimeConfigToEnv();
  const probeStart = new Date();
  const { url: inngestUrl, sourceEnv } = getInngestUrlWithSource();

  const altEnvs: Record<string, string | null> = {
    INNGEST_BASE_URL: process.env.INNGEST_BASE_URL ?? null,
    INNGEST_DEV: process.env.INNGEST_DEV ?? null,
    INNGEST_LOCAL_URL: process.env.INNGEST_LOCAL_URL ?? null,
    INNGEST_ADMIN_URL: process.env.INNGEST_ADMIN_URL ?? null,
    INNGEST_SERVE_ORIGIN: process.env.INNGEST_SERVE_ORIGIN ?? null,
    INNGEST_SERVE_HOST: process.env.INNGEST_SERVE_HOST ?? null,
    INNGEST_SERVE_PATH: process.env.INNGEST_SERVE_PATH ?? null,
    AO_LAN_IP: process.env.AO_LAN_IP ?? null,
    AO_PORT: process.env.AO_PORT ?? null,
  };

  let fnCount = 0;
  let inngestHealthy = false;
  let appErrors: Array<{ name: string; url: string | null; error: string }> = [];
  let apps: InngestApp[] = [];
  try {
    const [fns, listedApps] = await Promise.all([listFunctions(), listApps()]);
    apps = listedApps;
    fnCount = fns.length;
    appErrors = apps
      .filter((a) => typeof a.error === 'string' && a.error.length > 0)
      .map((a) => ({ name: a.name, url: a.url ?? null, error: a.error! }));
    inngestHealthy = appErrors.length === 0;
  } catch {
    inngestHealthy = false;
  }

  // runs24h best-effort. We use AgentActivity (always present) as a proxy
  // for "Inngest run activity in the last 24h". If the audit LogEvent table
  // from spec 2026-05-22 ships first, swap to it for accuracy.
  let runs24h: number | null = null;
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    runs24h = await prisma.agentActivity.count({
      where: { createdAt: { gte: since } },
    });
  } catch {
    runs24h = null;
  }

  const status = await prisma.emSystemStatus.findUnique({ where: { id: 'singleton' } }).catch(() => null);
  const lastSyncAt = status?.neo4jLastSyncAt ?? null;
  const staleSeconds = lastSyncAt ? Math.floor((Date.now() - new Date(lastSyncAt).getTime()) / 1000) : null;
  const staleness: 'fresh' | 'stale' | 'never' = !lastSyncAt
    ? 'never'
    : Date.now() - new Date(lastSyncAt).getTime() < STALENESS_THRESHOLD_MS
      ? 'fresh'
      : 'stale';
  const syncedEventCount = await prisma.eventDefinition
    .count({ where: { source: 'neo4j' } })
    .catch(() => 0);

  const raasInngestUrl = getRaasInngestUrl();
  return {
    inngest: {
      url: inngestUrl,
      sourceEnv,
      altEnvs,
      registeredFunctionCount: fnCount,
      runsLast24h: runs24h,
      healthy: inngestHealthy,
      appErrors,
      serveEndpointUrl: resolveServeEndpointUrl(apps),
      lastProbeAt: probeStart.toISOString(),
    },
    eventEngine: {
      lastSyncAt: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
      syncedEventCount,
      staleSeconds,
      staleness,
      lastError: status?.neo4jLastError ?? null,
    },
    raas: {
      apiUrl: process.env.RAAS_API_BASE_URL ?? null,
      inngestUrl: raasInngestUrl,
      inngestSharedWithLocal: raasInngestUrl === inngestUrl,
      apiHealthy: null,
    },
    runtimeConfig: await getRuntimeConfigState(),
    generatedAt: new Date().toISOString(),
  };
}

export async function GET(): Promise<Response> {
  const body = await buildResponse();
  return NextResponse.json(body);
}

export async function PATCH(req: Request): Promise<Response> {
  let values: unknown;
  let target: RuntimeConfigSaveTarget | undefined;
  try {
    const payload = (await req.json()) as { values?: unknown; target?: unknown };
    values = payload.values;
    target = payload.target === 'runtime' ? 'runtime' : 'env_local';
  } catch {
    return NextResponse.json<SystemConfigUpdateResponse>({ ok: false, error: 'INVALID_JSON' }, { status: 400 });
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    return NextResponse.json<SystemConfigUpdateResponse>({ ok: false, error: 'INVALID_VALUES' }, { status: 400 });
  }

  try {
    const result = await saveRuntimeConfig(values as Record<string, unknown>, { target });
    if (result.changedKeys.some((k) => k.startsWith('NEO4J_'))) {
      await closeNeo4jDriver().catch(() => undefined);
    }
    return NextResponse.json<SystemConfigUpdateResponse>({
      ok: true,
      target: result.target,
      changedKeys: result.changedKeys,
      restartRequiredKeys: result.restartRequiredKeys,
      config: await buildResponse(),
    });
  } catch (e) {
    return NextResponse.json<SystemConfigUpdateResponse>(
      { ok: false, error: (e as Error).message },
      { status: 400 },
    );
  }
}
