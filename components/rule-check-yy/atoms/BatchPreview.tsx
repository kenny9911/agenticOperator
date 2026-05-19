"use client";
/**
 * Right-hand preview panel for `/rule-check` aggregate page (v3 — row=batch).
 *
 * Fetches `getBatchSummary(batchId)` and renders verdict + step calls + candidate
 * key fields + other instances. Strict subset of audit JSON (SPEC §9.3 D9).
 */

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { Badge, Btn, Card } from "@/components/shared/atoms";
import { DecisionBadge } from "./DecisionBadge";
import { getBatchSummary, type BatchSummary } from "@/app/rule-check/actions";
import { useApp } from "@/lib/i18n";
import type { Instance } from "@/lib/rule-check";

export interface BatchPreviewProps {
  batchId: string | undefined;
}

export function BatchPreview({ batchId }: BatchPreviewProps) {
  const { t } = useApp();
  const cacheRef = useRef<Map<string, BatchSummary>>(new Map());
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setError(null);
    if (!batchId) {
      setSummary(null);
      return;
    }
    const cached = cacheRef.current.get(batchId);
    if (cached) {
      setSummary(cached);
      return;
    }
    startTransition(async () => {
      const res = await getBatchSummary(batchId);
      if (!mountedRef.current) return;
      if (res.ok) {
        cacheRef.current.set(batchId, res.summary);
        setSummary(res.summary);
      } else {
        setSummary(null);
        setError(res.error);
      }
    });
  }, [batchId]);

  if (!batchId) {
    return (
      <Card>
        <div className="p-6 text-center text-[12px] text-ink-3">
          {t("rc_select_batch_hint")}
        </div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card>
        <div className="p-4 text-[12px] text-err">
          <strong>error:</strong> {error}
        </div>
      </Card>
    );
  }
  if (isPending || !summary) {
    return (
      <Card>
        <div className="p-6 text-center text-[12px] text-ink-3">…loading…</div>
      </Card>
    );
  }

  const totalIn = summary.stepCalls.reduce((a, s) => a + s.inputTokens, 0);
  const totalOut = summary.stepCalls.reduce((a, s) => a + s.outputTokens, 0);
  const totalLatency = summary.stepCalls.reduce((a, s) => a + s.latencyMs, 0);

  return (
    <Card>
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="font-mono text-[11.5px] text-ink-1">
            {summary.batchId.slice(0, 12)}…
          </div>
          <div className="text-[10.5px] text-ink-3">{summary.timestamp}</div>
        </div>

        {summary.aggregateDecision.terminal && (
          <div className="rounded border border-warn bg-warn-bg px-3 py-2 text-[11px] text-warn">
            ↯ <strong>{t("rc_short_circuited")}</strong>
            {summary.aggregateDecision.terminalAtStep !== undefined && (
              <> @ step {summary.aggregateDecision.terminalAtStep}</>
            )}
          </div>
        )}

        <div className="flex items-center gap-3">
          <DecisionBadge value={summary.aggregateDecision.decision} size="md" />
          <div className="flex-1 flex flex-col gap-0.5 text-[11.5px]">
            <div>
              <span className="text-ink-3">cand</span>{" "}
              <span className="font-mono text-ink-1">
                {summary.input.candidateId}
              </span>
            </div>
            <div>
              <span className="text-ink-3">job</span>{" "}
              <span className="font-mono text-ink-2">
                {summary.input.jobRef ?? "—"}
              </span>
            </div>
            <div>
              <span className="text-ink-3">client</span>{" "}
              <span className="text-ink-2">{summary.input.scope.client}</span>
              {summary.input.scope.department && (
                <span className="text-ink-3"> / {summary.input.scope.department}</span>
              )}
            </div>
          </div>
        </div>

        {summary.aggregateDecision.triggeredRules.length > 0 && (
          <div className="text-[11px] text-ink-3">
            triggered:{" "}
            {summary.aggregateDecision.triggeredRules.slice(0, 10).map((r, i) => (
              <span key={r}>
                {i > 0 && ", "}
                <span className="font-mono text-ink-2">{r}</span>
              </span>
            ))}
            {summary.aggregateDecision.triggeredRules.length > 10 && (
              <span> (+{summary.aggregateDecision.triggeredRules.length - 10} more)</span>
            )}
          </div>
        )}

        <div className="border-t border-line pt-3">
          <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1.5">
            {t("rc_step_calls")}
          </div>
          <div className="flex flex-col gap-1">
            {summary.stepCalls.map((sc) => (
              <div
                key={sc.stepKey}
                className="flex items-center gap-2 text-[11px]"
              >
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    sc.shortCircuited ? "bg-warn" : "bg-ok"
                  }`}
                />
                <span className="font-mono text-ink-1">{sc.stepKey}</span>
                {sc.shortCircuited ? (
                  <span className="text-warn">skipped</span>
                ) : (
                  <span className="text-ink-3">
                    {sc.latencyMs}ms · {sc.inputTokens}/{sc.outputTokens}tok
                  </span>
                )}
                {sc.triggeredShortCircuit && (
                  <Badge variant="warn" className="ml-auto">
                    ↯ {sc.triggeredShortCircuit.byRuleId}
                  </Badge>
                )}
              </div>
            ))}
            <div className="text-[10.5px] text-ink-4 mt-1">
              total {totalLatency}ms · {totalIn}/{totalOut} tok
            </div>
          </div>
        </div>

        {summary.candidateOverview.mainFields.length > 0 && (
          <div className="border-t border-line pt-3">
            <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1.5">
              {t("rc_candidate_overview")}
              {summary.candidateOverview.instance && (
                <span className="ml-2 font-mono text-ink-4 normal-case tracking-normal">
                  {summary.candidateOverview.instance.objectType} ·{" "}
                  {summary.candidateOverview.instance.objectId}
                </span>
              )}
            </div>
            <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1 text-[11.5px]">
              {summary.candidateOverview.mainFields.map((f, i) => (
                <Row key={i} label={f.label} value={f.value} />
              ))}
            </dl>
          </div>
        )}

        {summary.otherInstances.length > 0 && (
          <div className="border-t border-line pt-3">
            <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1.5">
              {t("rc_other_instances")}
              <span className="ml-2 text-ink-4 normal-case tracking-normal">
                ({summary.otherInstances.length})
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {summary.otherInstances.map((inst, i) => (
                <CollapsibleInstance key={`${inst.objectType}-${inst.objectId}-${i}`} instance={inst} />
              ))}
            </div>
          </div>
        )}

        <div className="pt-2 border-t border-line">
          <Link href={`/rule-check/batches/${summary.batchId}`} className="block">
            <Btn variant="primary" size="sm" className="w-full justify-center">
              {t("rc_open_run_detail")} →
            </Btn>
          </Link>
        </div>
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-ink-1 truncate">{value}</dd>
    </>
  );
}

function CollapsibleInstance({ instance }: { instance: Instance }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-line bg-bg">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-2.5 py-1.5 text-[11.5px] hover:bg-panel"
      >
        <span className="font-mono text-ink-2 truncate">
          <span className="text-ink-1">{instance.objectType}</span>
          <span className="text-ink-3 mx-1">·</span>
          {instance.objectId}
        </span>
        <span className="text-ink-3 text-[10px] ml-2">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <pre className="m-0 border-t border-line px-2.5 py-2 font-mono text-[10.5px] text-ink-2 whitespace-pre-wrap break-all max-h-64 overflow-auto">
          {JSON.stringify(instance.data, null, 2)}
        </pre>
      )}
    </div>
  );
}
