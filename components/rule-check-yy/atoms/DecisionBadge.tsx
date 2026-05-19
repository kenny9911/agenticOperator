"use client";
/**
 * Decision badge — 4-value: not_started / passed / blocked / pending_human.
 * Maps to OKLCH tokens already defined in `app/globals.css`:
 *   passed         → --c-ok / --c-ok-bg
 *   blocked        → --c-err / --c-err-bg
 *   pending_human  → --c-warn / --c-warn-bg
 *   not_started    → --c-ink-4 / panel
 *
 * `overridden` shows an extra dot indicating system forced this decision
 * (e.g. validation failure flipped LLM's `blocked` to `pending_human`).
 */
import React from "react";
import type { RuleDecision } from "@/lib/rule-check";

export interface DecisionBadgeProps {
  value: RuleDecision;
  size?: "sm" | "md" | "xl";
  overridden?: boolean;
}

const LABEL: Record<RuleDecision, string> = {
  passed: "PASSED",
  blocked: "BLOCKED",
  pending_human: "PENDING HUMAN",
  not_started: "NOT STARTED",
};

const STYLE: Record<
  RuleDecision,
  { bg: string; fg: string; border: string }
> = {
  passed: {
    bg: "var(--c-ok-bg)",
    fg: "var(--c-ok)",
    border: "color-mix(in oklab, var(--c-ok) 30%, transparent)",
  },
  blocked: {
    bg: "var(--c-err-bg)",
    fg: "var(--c-err)",
    border: "color-mix(in oklab, var(--c-err) 30%, transparent)",
  },
  pending_human: {
    bg: "var(--c-warn-bg)",
    fg: "oklch(0.5 0.14 75)",
    border: "color-mix(in oklab, var(--c-warn) 40%, transparent)",
  },
  not_started: {
    bg: "var(--c-panel)",
    fg: "var(--c-ink-3)",
    border: "var(--c-line)",
  },
};

export function DecisionBadge({
  value,
  size = "md",
  overridden,
}: DecisionBadgeProps) {
  const s = STYLE[value];
  const sizing =
    size === "xl"
      ? "h-9 px-4 text-[13px]"
      : size === "sm"
        ? "h-5 px-1.5 text-[10px]"
        : "h-7 px-3 text-[12px]";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md font-bold uppercase tracking-wide ${sizing}`}
      style={{
        background: s.bg,
        color: s.fg,
        border: `1px solid ${s.border}`,
      }}
    >
      {overridden && (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ background: "currentColor", opacity: 0.6 }}
          title="System-overridden"
        />
      )}
      <span>{LABEL[value]}</span>
    </span>
  );
}
