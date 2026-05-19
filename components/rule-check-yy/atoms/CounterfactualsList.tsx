"use client";
/**
 * Counterfactuals (Layer 5 of the Prove page).
 *
 * Renders `llmParsed.counterfactuals[]` — LLM-emitted "what would flip
 * this verdict?" hypotheticals. Per SPEC §9.2 they are explicitly tagged
 * as LLM-speculative; the UI never re-runs the LLM to produce them.
 *
 * Returns `null` if the array is absent or empty so the Card shell is
 * not rendered (SPEC §9.3 D7 spirit — render only what's in audit JSON).
 */

import { Badge } from "@/components/shared/atoms";
import { DecisionBadge } from "./DecisionBadge";
import type { CounterfactualEntry } from "@/lib/rule-check";

export interface CounterfactualsListProps {
  counterfactuals: CounterfactualEntry[] | undefined;
}

export function CounterfactualsList({
  counterfactuals,
}: CounterfactualsListProps) {
  if (!counterfactuals || counterfactuals.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Badge variant="warn">LLM-speculative</Badge>
      </div>
      <ul className="flex flex-col gap-2">
        {counterfactuals.map((c, i) => (
          <li
            key={i}
            className="rounded border border-line bg-bg p-3 flex flex-col gap-1.5"
          >
            <div className="text-[12.5px] text-ink-1">{c.hypotheticalChange}</div>
            <div className="flex items-center gap-3 text-[11px] text-ink-3">
              <span>→</span>
              <DecisionBadge value={c.predictedDecision} size="sm" />
              <span className="ml-1">conf</span>
              <div
                className="flex items-center gap-1 flex-1 max-w-[200px]"
                aria-label={`confidence ${(c.confidence * 100).toFixed(0)}%`}
              >
                <div className="relative h-1.5 flex-1 rounded bg-panel overflow-hidden">
                  <div
                    className="absolute inset-y-0 left-0"
                    style={{
                      width: `${Math.max(0, Math.min(1, c.confidence)) * 100}%`,
                      background: "var(--c-ink-3)",
                    }}
                  />
                </div>
                <span className="font-mono tabular-nums text-[10.5px] text-ink-2">
                  {(c.confidence * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
