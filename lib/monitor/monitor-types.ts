// Shared types + helpers for the deterministic monitor backbone (P1).
//
// Each monitor is a pure async function (port, thresholds) -> MonitorResult.
// It reads the Postgres Inngest archive through MonitorReadPort (so tests inject
// a fake port, no DB) and returns CaptureInput[] for the existing
// recordNotification pipeline. NO LLM, NO direct DB writes here.

import type { CaptureInput } from '@/server/notifications/derive';
import type { DepFailure } from '../dependency-health/types';
import {
  ENERGY_DOMAIN_ID,
  ENERGY_EVENT_NS,
  COST_CONTROL_DOMAIN_ID,
  COST_CONTROL_EVENT_NS,
  RECRUITMENT_DOMAIN_ID,
} from '../domain-ids';

export type { DepFailure } from '../dependency-health/types';

/** A running run + its latest step time (the liveness heartbeat). */
export interface RunHeartbeat {
  runId: string;
  functionSlug: string;
  eventName: string | null;
  startedAt: Date | null;
  lastStepAt: Date | null;
}

/** One completed step's timing, for SLA percentiles (grouped by functionSlug). */
export interface StepTiming {
  runId: string;
  functionSlug: string;
  eventName: string | null;
  durationMs: number;
}

/** A run reference within a window (for cost token/tool aggregation). */
export interface RunRef {
  runId: string;
  functionSlug: string;
  eventName: string | null;
}

/** Error-rate denominator + per-agent breakdown over a window. */
export interface ErrorWindow {
  total: number;
  byAgent: Record<string, { errors: number; total: number; eventName: string | null }>;
}

/** Archive read surface the monitors depend on (Postgres impl in pg-read-port.ts). */
export interface MonitorReadPort {
  inflightRuns(): Promise<RunHeartbeat[]>;
  stepTimings(sinceMs: number): Promise<StepTiming[]>;
  recentRuns(sinceMs: number): Promise<RunRef[]>;
  tokenUsageByRun(runIds: string[]): Promise<Record<string, number>>;
  toolStepCounts(runIds: string[]): Promise<Record<string, number>>;
  errorWindow(windowMs: number): Promise<ErrorWindow>;
  /** Degraded external-dependency signals (LogEvent category 'dependency') in the window. */
  dependencyFailures(windowMs: number): Promise<DepFailure[]>;
  /** 超龄人工待办:firing 且 needs_human、首次出现早于 cutoff 的告警(催办用)。 */
  staleNeedsHuman(olderThanMs: number): Promise<StaleHumanItem[]>;
}

/** 一条超龄人工待办(hitl 催办监视器的输入)。 */
export interface StaleHumanItem {
  dedupeKey: string | null;
  title: string;
  ageMs: number;
}

/**
 * What one monitor produces in a sweep:
 *  - findings    : CaptureInput[] to record (threshold breaches)
 *  - activeKeys  : every dedupeKey this monitor considers currently firing
 *                  (used by resolve.ts to close stale firing alerts)
 *  - prefix      : the dedupeKey namespace this monitor owns (for resolve scoping)
 */
export interface MonitorResult {
  prefix: string;
  findings: CaptureInput[];
  activeKeys: string[];
}

export interface MonitorThresholds {
  stallMs: number; // health: a run with no new step for this long is stalled
  slaP95Ms: number; // sla: p95 step duration over this is a breach
  budgetTokens: number; // cost: per-domain window token budget
  toolLoop: number; // cost: per-run tool-step count over this is runaway
  errorRatePct: number; // error-rate: errors/total over this pct is a breach
  minVolume: number; // error-rate: suppress below this sample size
  depFailWindowMs: number; // dependency: lookback window for degraded-call signals
  depFailMinCount: number; // dependency: min failures before a fault/unknown fires (quota fires at 1)
  depUnknownEscalateCount: number; // dependency: 'unknown' warn → critical at/above this count
  hitlStaleMs: number; // hitl: a needs_human alert older than this triggers the 催办 digest
}

export const DEFAULT_THRESHOLDS: MonitorThresholds = {
  stallMs: 5 * 60_000,
  slaP95Ms: 60_000,
  budgetTokens: 2_000_000,
  toolLoop: 40,
  errorRatePct: 30,
  minVolume: 5,
  depFailWindowMs: 15 * 60_000,
  depFailMinCount: 2,
  depUnknownEscalateCount: 6,
  hitlStaleMs: 48 * 3600_000,
};

/**
 * Map an archived run to its business domain by event/function namespace.
 * Energy events are `energy/*`, cost-control `feikong/*`; everything else is
 * recruitment (the default domain). Pure + tolerant of a missing eventName.
 */
export function domainForRun(run: {
  functionSlug: string;
  eventName: string | null | undefined;
}): string {
  const hay = (run.eventName || run.functionSlug || '').toLowerCase();
  if (hay.startsWith(`${ENERGY_EVENT_NS}/`)) return ENERGY_DOMAIN_ID;
  if (hay.startsWith(`${COST_CONTROL_EVENT_NS}/`)) return COST_CONTROL_DOMAIN_ID;
  return RECRUITMENT_DOMAIN_ID;
}
