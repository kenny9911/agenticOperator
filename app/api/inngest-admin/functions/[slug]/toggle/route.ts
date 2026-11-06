// POST /api/inngest-admin/functions/[slug]/toggle  body { paused: boolean }
// → enable/disable an agent.
//
// Inngest dev server has no pause API, so we use AgentConfig.enabled in
// Prisma. The agent itself must check this flag at the top of its handler
// (we'll wire that next).

import { NextResponse } from 'next/server';
import { prisma } from '@/server/db';
import {
  invalidateAgentPauseCache,
  invalidatePausedSetCache,
} from '@/lib/agent-pause-guard';
import { invalidateHandlerCache } from '@/app/api/inngest/route';
import { invalidateRegistryCache } from '@/lib/inngest-registry';
import { writeManageAudit } from '@/lib/manage/audit';
import { isRaasV1FunctionSlug } from '@/lib/raas-v1-inngest';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  try {
    if (!isRaasV1FunctionSlug(slug)) {
      return NextResponse.json(
        {
          error: 'unsupported-function-scope',
          message: `${slug} is not one of the six RAAS-v1 functions served by agentic-operator-main`,
        },
        { status: 400 },
      );
    }

    const body = (await req.json()) as { paused?: boolean };
    const paused = Boolean(body.paused);
    const prev = await prisma.agentConfig.findUnique({ where: { id: slug } });
    await prisma.agentConfig.upsert({
      where: { id: slug },
      update: { enabled: !paused },
      create: {
        id: slug,
        enabled: !paused,
        description: `Inngest function ${slug}`,
      },
    });
    // 2026-05-27 — 启用/停用 agent 也是运维操作,写审计.
    // 用专用 action(disable/enable)让审计页一眼看出"哪个 agent 上线/下线",
    // 不再用泛化的 config/throttle. reason 带 agent slug 全名(不截断).
    await writeManageAudit({
      action: paused ? 'manage.agent.disable' : 'manage.agent.enable',
      traceId: slug,
      reason: paused ? `下线 agent: ${slug}` : `上线 agent: ${slug}`,
      before: { agent: slug, enabled: prev?.enabled ?? null },
      after: { agent: slug, enabled: !paused },
    });
    // ★ Invalidate caches so the next request reflects new state immediately:
    //   1. agent-pause-guard 5s cache(used by in-handler short-circuit fallback)
    //   2. paused-slug set cache(used by /api/inngest filter)
    //   3. serve handler cache(rebuild Inngest registration without paused fn)
    //   4. live registry cache (Fleet's /api/agents reads it; without this,
    //      a paused→online toggle briefly renders the agent as 'unbuilt'
    //      because stale liveFns + fresh AgentConfig diverge)
    invalidateAgentPauseCache(slug);
    invalidatePausedSetCache();
    invalidateHandlerCache();
    invalidateRegistryCache();

    // ★ Trigger Inngest dev server to re-introspect AO main so it sees the
    //   reduced function set immediately. Without this, Inngest holds the old
    //   registration until its next scheduled sync (can be minutes), and the
    //   paused agent keeps showing up as live in the fleet UI until then.
    //
    //   The "where can AO reach its own SDK endpoint?" URL is the same value
    //   that .env.example documents as INNGEST_SERVE_ORIGIN (the address
    //   Inngest uses to call back to us). Keep INNGEST_SERVE_HOST as a
    //   legacy alias for old local env files.
    try {
      const origin =
        process.env.INNGEST_SERVE_ORIGIN ??
        process.env.INNGEST_SERVE_HOST ??
        'http://localhost:3002';
      const res = await fetch(`${origin}/api/inngest`, { method: 'PUT' });
      if (!res.ok) {
        console.warn(
          `[toggle] Inngest re-introspect PUT ${origin}/api/inngest → ${res.status}; ` +
            `Inngest may keep paused agent in its registration until next sync. ` +
            `Check that INNGEST_SERVE_ORIGIN is set to a URL the AO process can reach itself at.`,
        );
      }
    } catch (e) {
      // Soft fail — the in-handler assertNotPaused guard still works as
      // belt+suspenders. Log so a misconfigured INNGEST_SERVE_ORIGIN is visible.
      console.warn(
        `[toggle] Inngest re-introspect failed: ${(e as Error).message}. ` +
          `Set INNGEST_SERVE_ORIGIN in .env.local to a URL the AO process can reach itself at.`,
      );
    }

    return NextResponse.json({ ok: true, slug, paused });
  } catch (err) {
    return NextResponse.json(
      { error: 'toggle-failed', message: (err as Error).message },
      { status: 500 },
    );
  }
}
