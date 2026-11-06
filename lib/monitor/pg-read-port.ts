// Postgres-backed MonitorReadPort + resolve deps — the only DB-touching part of
// the monitor backbone. Reads the Inngest archive (Postgres-first), writes
// nothing except alert resolution. Thin wiring; the monitors' logic is unit-
// tested against a fake port, so this file is verified by typecheck.

import { prisma } from '../../server/db';
import { getRunTokenUsage } from './run-token-usage';
import type {
  DepFailure,
  ErrorWindow,
  MonitorReadPort,
  RunHeartbeat,
  RunRef,
  StepTiming,
} from './monitor-types';
import { parseDependencyRow } from '../dependency-health/parse-signal';
import { parseResetRow, applyResets, type DepReset } from '../dependency-health/reset';
import { notifyResolvedExternally } from '../../server/notifications/resolve';
import type { ResolveDeps } from './resolve';

export function createPgReadPort(): MonitorReadPort {
  return {
    async inflightRuns(): Promise<RunHeartbeat[]> {
      const runs = await prisma.inngestRunArchive.findMany({
        where: { status: 'Running' },
        select: {
          runId: true,
          functionSlug: true,
          eventName: true,
          startedAt: true,
          steps: { select: { startedAt: true, endedAt: true } },
        },
      });
      return runs.map((r) => {
        let last: Date | null = null;
        for (const s of r.steps) {
          const ts = s.endedAt ?? s.startedAt;
          if (ts && (!last || ts > last)) last = ts;
        }
        return {
          runId: r.runId,
          functionSlug: r.functionSlug,
          eventName: r.eventName,
          startedAt: r.startedAt,
          lastStepAt: last,
        };
      });
    },

    async stepTimings(sinceMs: number): Promise<StepTiming[]> {
      const cutoff = new Date(Date.now() - sinceMs);
      const runs = await prisma.inngestRunArchive.findMany({
        where: { startedAt: { gte: cutoff } },
        select: {
          runId: true,
          functionSlug: true,
          eventName: true,
          steps: { select: { durationMs: true } },
        },
      });
      const out: StepTiming[] = [];
      for (const r of runs) {
        for (const s of r.steps) {
          if (s.durationMs != null) {
            out.push({
              runId: r.runId,
              functionSlug: r.functionSlug,
              eventName: r.eventName,
              durationMs: s.durationMs,
            });
          }
        }
      }
      return out;
    },

    async recentRuns(sinceMs: number): Promise<RunRef[]> {
      const cutoff = new Date(Date.now() - sinceMs);
      const rows = await prisma.inngestRunArchive.findMany({
        where: { startedAt: { gte: cutoff } },
        select: { runId: true, functionSlug: true, eventName: true },
      });
      return rows.map((r) => ({
        runId: r.runId,
        functionSlug: r.functionSlug,
        eventName: r.eventName,
      }));
    },

    async tokenUsageByRun(runIds: string[]): Promise<Record<string, number>> {
      if (runIds.length === 0) return {};
      const usage = await getRunTokenUsage(runIds);
      const out: Record<string, number> = {};
      for (const [runId, u] of Object.entries(usage)) out[runId] = u.total;
      return out;
    },

    async toolStepCounts(runIds: string[]): Promise<Record<string, number>> {
      if (runIds.length === 0) return {};
      const grouped = await prisma.inngestStepArchive.groupBy({
        by: ['runId'],
        where: { runId: { in: runIds } },
        _count: { _all: true },
      });
      const out: Record<string, number> = {};
      for (const g of grouped) out[g.runId] = g._count._all;
      return out;
    },

    async errorWindow(windowMs: number): Promise<ErrorWindow> {
      const cutoff = new Date(Date.now() - windowMs);
      const rows = await prisma.inngestRunArchive.findMany({
        where: { startedAt: { gte: cutoff } },
        select: { functionSlug: true, status: true, eventName: true },
      });
      const byAgent: ErrorWindow['byAgent'] = {};
      for (const r of rows) {
        const a =
          byAgent[r.functionSlug] ??
          (byAgent[r.functionSlug] = { errors: 0, total: 0, eventName: r.eventName });
        a.total++;
        if (r.status === 'Failed') a.errors++;
      }
      return { total: rows.length, byAgent };
    },

    async dependencyFailures(windowMs: number): Promise<DepFailure[]> {
      const cutoff = new Date(Date.now() - windowMs);
      const [failRows, resetRows] = await Promise.all([
        prisma.logEvent.findMany({
          where: { category: 'dependency', ts: { gte: cutoff } },
          select: { runId: true, ts: true, payloadJson: true },
          orderBy: { ts: 'asc' },
        }),
        prisma.logEvent.findMany({
          where: { category: 'dependency_reset', ts: { gte: cutoff } },
          select: { ts: true, payloadJson: true },
          orderBy: { ts: 'asc' },
        }),
      ]);
      const failures: DepFailure[] = [];
      for (const r of failRows) {
        const f = parseDependencyRow(r);
        if (f) failures.push(f);
      }
      const resets: DepReset[] = [];
      for (const r of resetRows) {
        const reset = parseResetRow(r);
        if (reset) resets.push(reset);
      }
      // Drop signals the operator already reset away ("I topped up").
      return applyResets(failures, resets);
    },
    async staleNeedsHuman(olderThanMs: number) {
      const cutoff = new Date(Date.now() - olderThanMs);
      const rows = await prisma.notification.findMany({
        where: {
          status: 'firing',
          disposition: 'needs_human',
          firstSeenAt: { lt: cutoff },
          // 催办 digest 自己不算待办(它是 warning/info_only),防御性排除前缀。
          NOT: { dedupeKey: { startsWith: 'hitl_stale.' } },
        },
        select: { dedupeKey: true, title: true, firstSeenAt: true },
        orderBy: { firstSeenAt: 'asc' },
      });
      const now = Date.now();
      return rows.map((r) => ({
        dedupeKey: r.dedupeKey,
        title: r.title,
        ageMs: now - r.firstSeenAt.getTime(),
      }));
    },
  };
}

/** Postgres impl of the resolve deps (close firing alerts whose condition cleared). */
export function createPgResolveDeps(): ResolveDeps {
  return {
    async findFiring(prefix: string): Promise<string[]> {
      const rows = await prisma.notification.findMany({
        where: { status: 'firing', dedupeKey: { startsWith: prefix } },
        select: { dedupeKey: true },
      });
      const keys = new Set<string>();
      for (const r of rows) if (r.dedupeKey) keys.add(r.dedupeKey);
      return [...keys];
    },
    async markResolved(keys: string[]): Promise<void> {
      if (keys.length === 0) return;
      // Delete any prior resolved row for these keys first, so flipping firing→
      // resolved can't collide on the @@unique([dedupeKey, status]) constraint.
      const firing = await prisma.notification.findMany({
        where: { status: 'firing', dedupeKey: { in: keys } },
        select: { dedupeKey: true, title: true, severity: true },
      });
      await prisma.notification.deleteMany({
        where: { status: 'resolved', dedupeKey: { in: keys } },
      });
      // 已解除的告警不再需要关注 → 顺手标已读,否则 resolved 行一直撑大未读
      // 红点(2026-06-11 审计)。先补 readAt 再翻状态,只动未读行。
      await prisma.notification.updateMany({
        where: { status: 'firing', dedupeKey: { in: keys }, readAt: null },
        data: { readAt: new Date() },
      });
      const r = await prisma.notification.updateMany({
        where: { status: 'firing', dedupeKey: { in: keys } },
        data: { status: 'resolved' },
      });
      // 报警也报平安:critical 解除推一条企微恢复消息(通道侧把关)。
      if (r.count > 0) notifyResolvedExternally(firing);
    },
  };
}
