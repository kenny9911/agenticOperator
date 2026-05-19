"use client";
/**
 * Root cause timeline — Layer 2 of the Prove page.
 *
 * Renders the LLM's four-section rootCauseSections (规则要求 / 数据观察 /
 * 对照推理 / 结论) as a vertical timeline with colored bands.
 */
import React from "react";
import type { RootCauseSections } from "@/lib/rule-check";

export interface RootCauseTimelineProps {
  sections: RootCauseSections;
  /** Optional rendered override per section. When provided for a key, the
   * ReactNode replaces the plain-text rendering — used by RunDetailContent
   * to inject clickable chips into 数据观察 per SPEC §9.3 D5. */
  renderedSections?: Partial<
    Record<keyof RootCauseSections, React.ReactNode>
  >;
}

// `ruleRequirement` band removed 2026-05-13 — RootCauseSections is now
// three-segment (dataObservation / contrastReasoning / conclusion).
const BANDS = [
  {
    key: "dataObservation" as const,
    title: "【数据观察】",
    color: "var(--c-ink-2)",
    bg: "var(--c-panel)",
  },
  {
    key: "contrastReasoning" as const,
    title: "【对照推理】",
    color: "var(--c-warn)",
    bg: "var(--c-warn-bg)",
  },
  {
    key: "conclusion" as const,
    title: "【结论】",
    color: "var(--c-ok)",
    bg: "var(--c-ok-bg)",
  },
];

export function RootCauseTimeline({
  sections,
  renderedSections,
}: RootCauseTimelineProps) {
  return (
    <div className="flex flex-col gap-2">
      {BANDS.map((b) => {
        const overridden = renderedSections?.[b.key];
        const body =
          overridden !== undefined ? (
            overridden
          ) : sections[b.key] ? (
            sections[b.key]
          ) : (
            <span className="text-ink-3 italic">—</span>
          );
        return (
          <div
            key={b.key}
            className="rounded-md border p-3"
            style={{
              background: b.bg,
              borderColor: `color-mix(in oklab, ${b.color} 25%, transparent)`,
            }}
          >
            <div
              className="text-[11px] font-semibold uppercase tracking-wide mb-1"
              style={{ color: b.color }}
            >
              {b.title}
            </div>
            <div className="text-[13px] text-ink-1 leading-relaxed">{body}</div>
          </div>
        );
      })}
    </div>
  );
}
