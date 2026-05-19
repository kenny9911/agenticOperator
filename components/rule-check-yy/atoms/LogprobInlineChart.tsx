"use client";
/**
 * Logprob inline chart — visualizes per-token logprobs from the LLM response.
 * Renders nothing when logprobs are absent (graceful degradation).
 */
import React from "react";

export interface LogprobToken {
  token: string;
  logprob: number;
}

export interface LogprobInlineChartProps {
  tokens: LogprobToken[];
}

export function LogprobInlineChart({ tokens }: LogprobInlineChartProps) {
  if (tokens.length === 0) return null;

  // Show up to first 50 tokens to keep the chart compact.
  const shown = tokens.slice(0, 50);

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10.5px] uppercase tracking-wide text-ink-3">
        per-token logprob (first {shown.length})
      </div>
      <div className="flex items-end gap-px h-8 overflow-hidden rounded bg-bg p-1">
        {shown.map((tk, i) => {
          // logprob ∈ (-∞, 0]; map exp(logprob) ∈ (0, 1] to bar height.
          const prob = Math.exp(tk.logprob);
          const heightPct = Math.max(4, Math.round(prob * 100));
          const color =
            prob >= 0.7 ? "var(--c-ok)" : prob >= 0.3 ? "var(--c-warn)" : "var(--c-err)";
          return (
            <span
              key={i}
              title={`${tk.token} · logp=${tk.logprob.toFixed(2)} (p=${prob.toFixed(2)})`}
              className="flex-1 min-w-[2px]"
              style={{ height: `${heightPct}%`, background: color }}
            />
          );
        })}
      </div>
    </div>
  );
}
