"use client";
/**
 * MatrixGrid — rules × candidates pass/fail grid (Matrix landing).
 *
 * Layout: CSS Grid with sticky first column (rule label) + sticky header
 * row (candidate id). Cells are 56×56 min, color-coded by decision. Click
 * a cell → navigate to /rule-check/runs/<runId>.
 *
 * Rule rows are grouped by `step.order` with a sticky step header. Empty
 * cells (no run for that pair) render as dashed transparent borders.
 *
 * Per SPEC §9.3 D4: each cell = latest run per `(ruleId, candidateId)`
 * pair. Computed in the server action; this component only renders.
 */

import { useRouter } from "next/navigation";
import type { MatrixCell } from "@/app/rule-check/actions";
import type {
  FetchedRuleClassified,
  RuleDecision,
} from "@/lib/rule-check";

export interface MatrixGridProps {
  cells: MatrixCell[];
  rules: FetchedRuleClassified[];
  candidates: string[];
}

const CELL_COLOR: Record<RuleDecision, string> = {
  passed: "var(--c-ok)",
  blocked: "var(--c-err)",
  pending_human: "var(--c-warn)",
  not_started: "var(--c-ink-3)",
};

export function MatrixGrid({ cells, rules, candidates }: MatrixGridProps) {
  const router = useRouter();

  // Index cells by (ruleId, candidateId)
  const cellMap = new Map<string, MatrixCell>();
  for (const c of cells) {
    cellMap.set(`${c.ruleId}${c.candidateId}`, c);
  }

  // Group rules by stepOrder
  const grouped = new Map<number, FetchedRuleClassified[]>();
  for (const r of rules) {
    const arr = grouped.get(r.stepOrder) ?? [];
    arr.push(r);
    grouped.set(r.stepOrder, arr);
  }
  const stepOrders = Array.from(grouped.keys()).sort((a, b) => a - b);

  const gridTemplateColumns = `200px repeat(${candidates.length}, minmax(56px, 1fr))`;

  return (
    <div className="w-full overflow-x-auto rounded-lg border border-line bg-surface">
      <div className="min-w-fit">
        {/* Header row */}
        <div
          className="grid sticky top-0 z-10 bg-surface border-b border-line"
          style={{ gridTemplateColumns }}
        >
          <div className="sticky left-0 z-20 bg-surface border-r border-line px-3 py-2 text-[10.5px] uppercase tracking-wide text-ink-3">
            Rule
          </div>
          {candidates.map((cid) => (
            <div
              key={cid}
              className="px-2 py-2 text-[10.5px] font-mono text-ink-3 truncate text-center"
              title={cid}
            >
              {cid}
            </div>
          ))}
        </div>

        {/* Step groups */}
        {stepOrders.map((step) => {
          const stepRules = grouped.get(step) ?? [];
          return (
            <div key={step}>
              <div
                className="grid sticky top-[33px] z-[9] bg-panel border-b border-line"
                style={{ gridTemplateColumns }}
              >
                <div className="sticky left-0 z-[10] bg-panel border-r border-line px-3 py-1 text-[10.5px] uppercase tracking-wide text-ink-2 font-semibold">
                  Step {step}
                </div>
                {candidates.map((cid) => (
                  <div
                    key={cid}
                    className="border-l border-line"
                    style={{ background: "var(--c-panel)" }}
                  />
                ))}
              </div>
              {stepRules.map((rule) => (
                <div
                  key={rule.id}
                  className="grid hover:bg-panel/40 border-b border-line"
                  style={{ gridTemplateColumns }}
                >
                  <div className="sticky left-0 z-[5] bg-surface border-r border-line px-3 py-2 flex flex-col gap-0.5">
                    <span className="font-mono text-[11px] text-ink-1">
                      {rule.id}
                    </span>
                    <span
                      className="text-[10.5px] text-ink-3 truncate"
                      title={rule.name}
                    >
                      {rule.name}
                    </span>
                  </div>
                  {candidates.map((cid) => {
                    const cell = cellMap.get(`${rule.id}${cid}`);
                    return (
                      <button
                        key={cid}
                        type="button"
                        disabled={!cell}
                        className="border-l border-line h-14 transition-opacity hover:opacity-70 disabled:cursor-default"
                        title={
                          cell
                            ? `${cell.runId.slice(0, 8)}… · ${cell.decision} · ${cell.timestamp}`
                            : "no run"
                        }
                        style={{
                          background: cell ? CELL_COLOR[cell.decision] : "transparent",
                          borderTopWidth: cell ? 0 : 1,
                          borderTopStyle: cell ? undefined : "dashed",
                          borderTopColor: cell ? undefined : "var(--c-line)",
                          opacity: cell ? 0.85 : 1,
                        }}
                        onClick={() => {
                          if (cell) router.push(`/rule-check/runs/${cell.runId}`);
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
