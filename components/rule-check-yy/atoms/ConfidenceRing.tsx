"use client";
/**
 * Confidence ring — radial gauge for [0, 1]. Hover surfaces breakdown
 * (composite_full or composite_degraded with per-factor contributions).
 */
import React from "react";
import type { CompositeConfidenceBreakdown } from "@/lib/rule-check";

export interface ConfidenceRingProps {
  value: number;
  size?: number;
  label?: string;
  breakdown?: CompositeConfidenceBreakdown;
}

export function ConfidenceRing({
  value,
  size = 80,
  label,
  breakdown,
}: ConfidenceRingProps) {
  const clamped = Math.max(0, Math.min(1, value));
  const pct = Math.round(clamped * 100);
  const radius = (size - 8) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped);

  const color =
    clamped >= 0.8 ? "var(--c-ok)" : clamped >= 0.5 ? "var(--c-warn)" : "var(--c-err)";

  const tooltip = breakdown
    ? [
        `source: ${breakdown.source}`,
        `evidence: ${breakdown.evidenceCountFactor.toFixed(2)}`,
        `consistency: ${breakdown.consistencyFactor.toFixed(2)}`,
        `logprob: ${breakdown.logprobScore?.toFixed(2) ?? "n/a"}`,
      ].join("  ·  ")
    : undefined;

  return (
    <div className="flex flex-col items-center gap-1" title={tooltip}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--c-panel)"
          strokeWidth={6}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          className="font-mono"
          style={{ fontSize: size / 4, fill: "var(--c-ink-1)", fontWeight: 600 }}
        >
          {pct}%
        </text>
      </svg>
      {label && <div className="text-[10px] text-ink-3">{label}</div>}
      {breakdown?.source === "composite_degraded" && (
        <div className="text-[9px] text-warn">degraded</div>
      )}
    </div>
  );
}
