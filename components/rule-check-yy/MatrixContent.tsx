"use client";
/**
 * /rule-check matrix landing — rules × candidates pass/fail grid.
 *
 * Top KPI strip (5 metrics derived from cells) + matrix grid below.
 * Empty state when zero cells: instruction + link to /dev/rule-check.
 *
 * Server component parent fetches via `listMatrixCells` + `listActiveRules`
 * and passes data as props; this client component handles Shell context
 * (useApp / navigation chrome).
 */

import Link from "next/link";
import { Metric } from "@/components/shared/atoms";
import { useApp } from "@/lib/i18n";
import { MatrixGrid } from "./atoms/MatrixGrid";
import type { MatrixCell } from "@/app/rule-check/actions";
import type { FetchedRuleClassified, RuleDecision } from "@/lib/rule-check";

export interface MatrixContentProps {
  cells: MatrixCell[];
  rules: FetchedRuleClassified[];
  candidates: string[];
  /** Free-text label of the current scope, rendered in sub-header. */
  scopeLabel: string;
}

export function MatrixContent({
  cells,
  rules,
  candidates,
  scopeLabel,
}: MatrixContentProps) {
  const { t } = useApp();
  const total = cells.length;
  const countBy = (d: RuleDecision) =>
    cells.filter((c) => c.decision === d).length;
  const passed = countBy("passed");
  const blocked = countBy("blocked");
  const pending = countBy("pending_human");
  const notStarted = countBy("not_started");
  const pct = (n: number) =>
    total === 0 ? "—" : `${Math.round((n / total) * 100)}%`;

  return (
    <div className="flex flex-col h-full min-h-0 gap-4 p-6 overflow-y-auto">
      <header className="flex items-end justify-between flex-shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-ink-1">
            {t("rc_matrix_title")}
          </h1>
          <p className="mt-1 text-[12px] text-ink-3">{scopeLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/rule-check"
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] text-ink-1 hover:bg-panel"
          >
            {t("rc_runs")} →
          </Link>
          <Link
            href="/dev/rule-check"
            className="rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] text-ink-1 hover:bg-panel"
          >
            ↻ run new batch
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 rounded-lg border border-line bg-surface p-4">
        <Metric label="total" value={String(total)} />
        <Metric label="passed" value={pct(passed)} sub={String(passed)} />
        <Metric label="blocked" value={pct(blocked)} sub={String(blocked)} />
        <Metric label="pending" value={pct(pending)} sub={String(pending)} />
        <Metric label="not_started" value={pct(notStarted)} sub={String(notStarted)} />
      </div>

      {cells.length === 0 || rules.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-surface p-8 text-center">
          <div className="text-[14px] text-ink-2">{t("rc_matrix_empty")}</div>
          <div className="mt-2 text-[11.5px] text-ink-3">
            Trigger one from{" "}
            <Link href="/dev/rule-check" className="text-accent hover:underline">
              /dev/rule-check
            </Link>{" "}
            then refresh this page.
          </div>
        </div>
      ) : (
        <MatrixGrid cells={cells} rules={rules} candidates={candidates} />
      )}
    </div>
  );
}
