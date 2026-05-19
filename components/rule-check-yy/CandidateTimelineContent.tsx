"use client";
/**
 * /rule-check/candidates/[id] — candidate-centric timeline.
 *
 * Chronological list of runs for one candidate. Stub until real data wiring.
 */
import React from "react";
import Link from "next/link";
import { Card, CardHead } from "@/components/shared/atoms";
import { useApp } from "@/lib/i18n";
import { MOCK_RUNS } from "./mock";
import { DecisionBadge } from "./atoms/DecisionBadge";

export interface CandidateTimelineContentProps {
  candidateId: string;
}

export function CandidateTimelineContent({ candidateId }: CandidateTimelineContentProps) {
  const { t } = useApp();
  const runs = MOCK_RUNS.filter((r) => r.input.candidateId === candidateId);

  return (
    <div className="flex flex-col gap-4 p-6">
      <header>
        <h1 className="text-xl font-semibold text-ink-1">
          {t("rc_candidate")}: <span className="font-mono">{candidateId}</span>
        </h1>
        <p className="mt-1 text-xs text-ink-3">{runs.length} runs</p>
      </header>
      <Card>
        <CardHead>
          <span className="text-[12.5px] font-medium text-ink-1">Timeline</span>
        </CardHead>
        <div className="divide-y divide-line">
          {runs.length === 0 && (
            <div className="px-3 py-6 text-center text-ink-3 text-[12px]">
              {t("rc_no_runs")} for {candidateId}
            </div>
          )}
          {runs.map((r) => (
            <Link
              key={r.runId}
              href={`/rule-check/runs/${r.runId}`}
              className="flex items-center gap-3 px-3 py-3 hover:bg-panel"
            >
              <DecisionBadge value={r.finalDecision.decision} size="sm" />
              <span className="font-mono text-[12px] text-ink-2">{r.input.ruleId}</span>
              <span className="text-[11px] text-ink-3">·</span>
              <span className="text-[12px] text-ink-2">{r.fetched.rule.name}</span>
              <span className="ml-auto font-mono text-[11px] text-ink-3">
                {r.timestamp.replace("T", " ").slice(0, 16)}
              </span>
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}
