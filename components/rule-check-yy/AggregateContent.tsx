"use client";
/**
 * /rule-check — Runs aggregate page (Path C v3: row = batch).
 *
 * 3-region layout:
 *   Top:    Header (title + scope + actions: Matrix link, Run new batch)
 *           + Batch metrics strip (per-batch counts + short-circuit count)
 *   Bottom: Batch list (left) + BatchPreview (right)
 *           Equal-height; each column scrolls independently.
 *
 * 1 row = 1 batch ("运行"). Click row → preview updates.
 * Preview's [打开运行详情 →] navigates to /rule-check/batches/<batchId>.
 */

import Link from "next/link";
import { useState } from "react";
import { Card, CardHead, Badge } from "@/components/shared/atoms";
import { DecisionBadge } from "./atoms/DecisionBadge";
import { BatchPreview } from "./atoms/BatchPreview";
import { useApp } from "@/lib/i18n";
import type { BatchRow, BatchAggregateMetrics } from "@/app/rule-check/actions";

export interface AggregateContentProps {
  rows: BatchRow[];
  aggregate: BatchAggregateMetrics;
  scopeLabel: string;
}

export function AggregateContent({
  rows,
  aggregate,
  scopeLabel,
}: AggregateContentProps) {
  const { t } = useApp();
  const [selectedBatchId, setSelectedBatchId] = useState<string | undefined>(
    rows[0]?.batchId,
  );

  return (
    <div className="flex flex-col h-full min-h-0 gap-4 p-6">
      <header className="flex items-end justify-between flex-shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-ink-1">
            {t("rc_aggregate_title")}
          </h1>
          <p className="mt-1 text-[12px] text-ink-3">
            {scopeLabel} · {aggregate.totalBatches} {t("rc_runs_count")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/rule-check/matrix"
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] text-ink-1 hover:bg-panel"
          >
            {t("rc_matrix_link")} →
          </Link>
          <Link
            href="/dev/rule-check"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-accent bg-accent px-3 py-1.5 text-[12px] text-white hover:opacity-90"
          >
            ↻ {t("rc_run_new_batch")}
          </Link>
        </div>
      </header>

      <div className="flex-shrink-0">
        <BatchMetricsStrip aggregate={aggregate} />
      </div>

      <div
        className="grid gap-4 flex-1 min-h-0"
        style={{ gridTemplateColumns: "minmax(420px, 1fr) minmax(0, 1.5fr)" }}
      >
        <div className="min-w-0 min-h-0 overflow-y-auto">
          <BatchList
            rows={rows}
            selectedBatchId={selectedBatchId}
            onSelect={setSelectedBatchId}
          />
        </div>
        <div className="min-w-0 min-h-0 overflow-y-auto">
          <BatchPreview batchId={selectedBatchId} />
        </div>
      </div>
    </div>
  );
}

function BatchMetricsStrip({ aggregate }: { aggregate: BatchAggregateMetrics }) {
  const total = aggregate.totalBatches;
  const pct = (n: number) => (total === 0 ? "—" : `${Math.round((n / total) * 100)}%`);
  const max7 = Math.max(...aggregate.batchesPerDay, 1);
  return (
    <Card>
      <div className="p-3 grid grid-cols-2 sm:grid-cols-6 gap-3 text-[11.5px]">
        <Metric label="total" value={String(total)} />
        <Metric label="passed" value={pct(aggregate.passed)} sub={String(aggregate.passed)} />
        <Metric label="blocked" value={pct(aggregate.blocked)} sub={String(aggregate.blocked)} />
        <Metric label="pending" value={pct(aggregate.pending)} sub={String(aggregate.pending)} />
        <Metric label="short-circuit" value={String(aggregate.shortCircuited)} />
        <div className="flex items-end gap-0.5 col-span-2 sm:col-span-1">
          <div className="text-[10px] text-ink-3 mr-1.5 mb-0.5">runs/day(7d)</div>
          {aggregate.batchesPerDay.map((v, i) => (
            <div
              key={i}
              className="w-1.5 bg-accent rounded-sm"
              style={{ height: `${(v / max7) * 18 + 2}px`, opacity: v > 0 ? 1 : 0.2 }}
              title={`day -${6 - i}: ${v}`}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-ink-3">{label}</span>
      <span className="text-[14px] font-semibold text-ink-1">{value}</span>
      {sub && <span className="text-[10px] text-ink-4">{sub}</span>}
    </div>
  );
}

interface BatchListProps {
  rows: BatchRow[];
  selectedBatchId: string | undefined;
  onSelect: (batchId: string) => void;
}

function BatchList({ rows, selectedBatchId, onSelect }: BatchListProps) {
  if (rows.length === 0) {
    return (
      <Card>
        <div className="p-8 text-center text-[12px] text-ink-3">
          No runs in this scope.
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <CardHead>
        <span className="text-[11px] font-medium text-ink-2">TIME · CAND · JOB</span>
        <span className="ml-auto text-[11px] text-ink-3">verdict · steps · ↯</span>
      </CardHead>
      <div className="flex flex-col">
        {rows.map((r) => (
          <BatchRowItem
            key={r.batchId}
            row={r}
            active={r.batchId === selectedBatchId}
            onClick={() => onSelect(r.batchId)}
          />
        ))}
      </div>
    </Card>
  );
}

function BatchRowItem({
  row,
  active,
  onClick,
}: {
  row: BatchRow;
  active: boolean;
  onClick: () => void;
}) {
  // Build 4 step dots for steps 1..4. Maps stepOrder → status.
  const stepStatus = new Map(row.stepProgress.map((s) => [s.stepOrder, s.status]));
  const dots = [1, 2, 3, 4].map((order) => {
    const status = stepStatus.get(order);
    if (status === "ok") return "●";
    if (status === "skipped") return "○";
    return "·"; // step not present in this batch (e.g. step_4 tool-only)
  });
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full px-3 py-2 text-left border-t border-line first:border-t-0 hover:bg-panel ${
        active ? "bg-panel" : "bg-surface"
      }`}
    >
      <div className="flex items-center gap-3 text-[11.5px]">
        <span className="font-mono text-ink-3 w-[124px] flex-shrink-0">
          {formatShortTimestamp(row.timestamp)}
        </span>
        <span className="font-mono text-ink-1 truncate w-[110px] flex-shrink-0">
          {row.candidateId}
        </span>
        <span className="font-mono text-ink-2 truncate flex-1 min-w-0">
          {row.jobRef ?? "—"}
        </span>
        <DecisionBadge value={row.decision} size="sm" />
        <span className="font-mono text-ink-2 text-[10px] w-[34px] text-center" title={`step status: ${dots.join("")}`}>
          {dots.join("")}
        </span>
        <span className="w-[36px] text-[10px] text-warn text-right">
          {row.terminal ? `↯${row.terminalAtStep ?? ""}` : ""}
        </span>
      </div>
    </button>
  );
}

function formatShortTimestamp(ts: string): string {
  // ts is "YYYY-MM-DDTHH:mm:ss+08:00"; show "MM-DD HH:mm".
  const m = /^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(ts);
  if (!m) return ts;
  return `${m[1]}-${m[2]} ${m[3]}:${m[4]}`;
}
