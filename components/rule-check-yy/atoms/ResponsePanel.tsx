"use client";
/**
 * Response panel — Layer 5 right side. Shows the parsed RuleJudgmentAudited
 * + token counts + latency + optional logprob inline chart.
 */
import React from "react";
import { useApp } from "@/lib/i18n";
import { Badge } from "@/components/shared/atoms";
import type { LLMRawResponse, RuleJudgmentAudited } from "@/lib/rule-check";

export interface ResponsePanelProps {
  llmRaw: LLMRawResponse;
  parsed: RuleJudgmentAudited | null;
}

export function ResponsePanel({ llmRaw, parsed }: ResponsePanelProps) {
  const { t } = useApp();
  return (
    <div className="rounded-lg border border-line bg-surface shadow-sh-1 p-3 flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-3">
        <KV label={t("rc_model")} value={llmRaw.model} mono />
        <KV label={t("rc_latency")} value={`${llmRaw.latencyMs}ms`} />
        <KV
          label="tokens in/out"
          value={`${llmRaw.inputTokens.toLocaleString()}/${llmRaw.outputTokens.toLocaleString()}`}
          mono
        />
      </div>
      {parsed && (
        <div className="rounded-md bg-bg p-3 font-mono text-[11px] text-ink-2 max-h-72 overflow-auto whitespace-pre-wrap">
          {JSON.stringify(parsed, null, 2)}
        </div>
      )}
      {parsed?.counterfactuals && parsed.counterfactuals.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-[10.5px] uppercase tracking-wide text-ink-3 flex items-center gap-2">
            counterfactuals <Badge variant="warn">{t("rc_speculative")}</Badge>
          </div>
          {parsed.counterfactuals.map((cf, i) => (
            <div key={i} className="text-[12px] text-ink-2 border-l-2 border-line pl-2">
              <span className="italic">{cf.hypotheticalChange}</span>{" "}
              <span className="font-mono text-ink-3">→</span>{" "}
              <span className="font-mono text-ink-1">{cf.predictedDecision}</span>{" "}
              <span className="text-ink-3">({(cf.confidence * 100).toFixed(0)}%)</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function KV({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className={`mt-0.5 text-ink-1 ${mono ? "font-mono text-[12px]" : "text-[14px]"}`}>
        {value}
      </div>
    </div>
  );
}
