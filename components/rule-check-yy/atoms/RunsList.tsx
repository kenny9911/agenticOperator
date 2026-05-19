"use client";
/**
 * Plain `<table>` list of runs for the aggregate page. ~300 rows fits
 * comfortably without virtualization; revisit if index size exceeds 2000.
 *
 * Click a row → updates parent's selected runId state (no navigation;
 * navigation happens via the preview panel's "Open full detail" button).
 */

import { StatusDot } from "@/components/shared/atoms";
import type { AggregateRow } from "@/app/rule-check/actions";
import type { RuleDecision } from "@/lib/rule-check";

export interface RunsListProps {
  rows: AggregateRow[];
  selectedRunId?: string;
  onSelect: (runId: string) => void;
}

const DOT_KIND: Record<RuleDecision, "ok" | "err" | "warn" | "idle"> = {
  passed: "ok",
  blocked: "err",
  pending_human: "warn",
  not_started: "idle",
};

export function RunsList({ rows, selectedRunId, onSelect }: RunsListProps) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-line bg-surface p-6 text-center text-[12px] text-ink-3">
        No runs in this scope.
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-line bg-surface overflow-hidden">
      <div className="max-h-[70vh] overflow-y-auto">
        <table className="w-full text-[11.5px]">
          <thead className="sticky top-0 bg-panel text-[10px] uppercase tracking-wide text-ink-3">
            <tr>
              <th className="text-left px-2 py-2 font-medium">timestamp</th>
              <th className="text-left px-2 py-2 font-medium">decision</th>
              <th className="text-left px-2 py-2 font-medium">rule</th>
              <th className="text-left px-2 py-2 font-medium">candidate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const selected = r.runId === selectedRunId;
              return (
                <tr
                  key={r.runId}
                  onClick={() => onSelect(r.runId)}
                  className={`cursor-pointer border-t border-line hover:bg-panel ${
                    selected ? "bg-panel" : ""
                  }`}
                >
                  <td className="px-2 py-1.5 font-mono text-[10.5px] text-ink-2 whitespace-nowrap">
                    {formatTimestamp(r.timestamp)}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="inline-flex items-center gap-1.5">
                      <StatusDot kind={DOT_KIND[r.decision]} />
                      <span className="text-ink-2">{r.decision}</span>
                    </span>
                  </td>
                  <td className="px-2 py-1.5 font-mono text-ink-1">{r.ruleId}</td>
                  <td className="px-2 py-1.5 font-mono text-ink-2">
                    {r.candidateId}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  // Compact: YYYY-MM-DD HH:MM
  if (!iso) return "—";
  return iso.replace("T", " ").slice(0, 16);
}
