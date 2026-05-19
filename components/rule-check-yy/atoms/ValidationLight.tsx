"use client";
/**
 * Validation light board — 4 cells showing the deterministic check state:
 *   1. rule_id exists
 *   2. evidence grounded
 *   3. schema valid
 *   4. block-semantic check (ok / warning / skipped)
 *
 * `variant="mini"` renders as 4 colored dots (for table rows). `variant="full"`
 * renders as 4 labeled cells (for the run-detail Layer 4 board).
 */
import React from "react";
import type { ValidationReport } from "@/lib/rule-check";
import { useApp } from "@/lib/i18n";

export interface ValidationLightProps {
  report: ValidationReport;
  variant?: "full" | "mini";
}

type CellState = "ok" | "err" | "warn" | "skip";

function cellColor(state: CellState): string {
  return state === "ok"
    ? "var(--c-ok)"
    : state === "err"
      ? "var(--c-err)"
      : state === "warn"
        ? "var(--c-warn)"
        : "var(--c-ink-4)";
}

function blockSemState(s: ValidationReport["blockSemanticCheck"]): CellState {
  if (s === "ok") return "ok";
  if (s === "warning") return "warn";
  return "skip";
}

export function ValidationLight({ report, variant = "full" }: ValidationLightProps) {
  const { t } = useApp();
  const cells: Array<{ label: string; state: CellState }> = [
    { label: t("rc_v_rule_exists"), state: report.ruleIdExists ? "ok" : "err" },
    { label: t("rc_v_evidence_grounded"), state: report.evidenceGrounded ? "ok" : "err" },
    { label: t("rc_v_schema"), state: report.schemaValid ? "ok" : "err" },
    { label: t("rc_v_block_semantic"), state: blockSemState(report.blockSemanticCheck) },
  ];

  if (variant === "mini") {
    return (
      <span className="inline-flex items-center gap-0.5" title={cells.map((c) => `${c.label}=${c.state}`).join(" ")}>
        {cells.map((c, i) => (
          <span
            key={i}
            className="inline-block w-2 h-2 rounded-full"
            style={{ background: cellColor(c.state) }}
          />
        ))}
      </span>
    );
  }

  return (
    <div className="grid grid-cols-4 gap-2">
      {cells.map((c, i) => (
        <div
          key={i}
          className="rounded border border-line bg-surface px-2 py-1.5 flex flex-col items-center gap-1"
        >
          <span
            className="inline-block w-3 h-3 rounded-full"
            style={{ background: cellColor(c.state) }}
          />
          <span className="text-[10px] text-ink-3 text-center">{c.label}</span>
        </div>
      ))}
    </div>
  );
}
