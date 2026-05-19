"use client";
/**
 * Top KPI strip for the Runs aggregate page.
 *
 * Pure statistical projection of `AggregateMetrics` from the filesystem
 * index (SPEC §9.3 D3). NO trend lines, NO anomaly callouts. Each run is
 * independent — these are just counts/averages.
 */

import { Metric, Spark } from "@/components/shared/atoms";
import type { AggregateMetrics } from "@/app/rule-check/actions";

export interface RunsDashboardProps {
  aggregate: AggregateMetrics;
}

export function RunsDashboard({ aggregate }: RunsDashboardProps) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4 flex flex-wrap items-end gap-6">
      <Metric label="total" value={String(aggregate.total)} />
      <Metric label="passed" value={`${aggregate.passedPct}%`} />
      <Metric label="blocked" value={`${aggregate.blockedPct}%`} />
      <Metric label="pending" value={`${aggregate.pendingPct}%`} />
      <Metric
        label="avg latency"
        value={
          aggregate.avgLatencyMs === null
            ? "—"
            : `${Math.round(aggregate.avgLatencyMs)}ms`
        }
      />
      <div className="flex flex-col gap-1">
        <div className="text-[11px] text-ink-3">runs / day (7d)</div>
        <div className="w-32">
          <Spark values={aggregate.runsPerDay} accent="var(--c-accent)" height={28} />
        </div>
      </div>
    </div>
  );
}
