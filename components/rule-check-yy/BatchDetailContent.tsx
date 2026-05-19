"use client";
/**
 * `/rule-check/batches/[batchId]` — single-run (batch) detail page.
 *
 * Sections (top → bottom):
 *   1. Verdict + step calls (2-col grid)
 *   2. Candidate overview + job overview (2-col grid)
 *   3. Other Neo4j instances (collapsible list)
 *   4. Step groups: per-step rule cards (expandable with rule sourceText + 3-section judgment basis)
 *
 * Entire page scrolls vertically.
 *
 * Strict subset of `RuleCheckBatchRunAudited` (SPEC §9.3 D9). No new content.
 */

import Link from "next/link";
import { useState } from "react";
import { Badge, Btn, Card, CardHead } from "@/components/shared/atoms";
import { DecisionBadge } from "./atoms/DecisionBadge";
import { useApp } from "@/lib/i18n";
import type { BatchSummary, BatchRuleEntry, BatchStepCallSlim, BatchStepGroup } from "@/app/rule-check/actions";
import type { Instance } from "@/lib/rule-check";

export interface BatchDetailContentProps {
  summary: BatchSummary;
}

export function BatchDetailContent({ summary }: BatchDetailContentProps) {
  const { t } = useApp();
  const totalLatency = summary.stepCalls.reduce((a, s) => a + s.latencyMs, 0);
  const totalIn = summary.stepCalls.reduce((a, s) => a + s.inputTokens, 0);
  const totalOut = summary.stepCalls.reduce((a, s) => a + s.outputTokens, 0);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto">
      <div className="flex flex-col gap-4 p-6 max-w-[1200px] mx-auto w-full">
        {/* Header */}
        <header className="flex items-end justify-between">
          <div>
            <h1 className="text-xl font-semibold text-ink-1">
              {t("rc_aggregate_title")} · <span className="font-mono">{summary.batchId.slice(0, 12)}…</span>
            </h1>
            <p className="mt-1 text-[12px] text-ink-3">{summary.timestamp}</p>
          </div>
          <Link
            href="/dev/rule-check"
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-accent bg-accent px-3 py-1.5 text-[12px] text-white hover:opacity-90"
          >
            ↻ {t("rc_run_new_batch")}
          </Link>
        </header>

        {/* Section 1: Verdict + Step calls */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <VerdictCard summary={summary} />
          <StepCallsCard
            stepCalls={summary.stepCalls}
            totalLatency={totalLatency}
            totalIn={totalIn}
            totalOut={totalOut}
          />
        </div>

        {/* Section 2: Candidate / Job overview */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <OverviewCard
            title={t("rc_candidate_overview")}
            instance={summary.candidateOverview.instance}
            fields={summary.candidateOverview.mainFields}
          />
          <OverviewCard
            title={t("rc_job_overview")}
            instance={summary.jobOverview.instance}
            fields={summary.jobOverview.mainFields}
          />
        </div>

        {/* Section 3: Other instances */}
        {summary.otherInstances.length > 0 && (
          <Card>
            <CardHead>
              <span className="text-[12.5px] font-medium text-ink-1">
                {t("rc_other_instances")} ({summary.otherInstances.length})
              </span>
            </CardHead>
            <div className="p-3 flex flex-col gap-1.5">
              {summary.otherInstances.map((inst, i) => (
                <CollapsibleInstance key={`${inst.objectType}-${inst.objectId}-${i}`} instance={inst} />
              ))}
            </div>
          </Card>
        )}

        {/* Section 4: Step groups */}
        {summary.stepGroups.map((group) => (
          <StepGroupSection key={group.stepKey} group={group} />
        ))}
      </div>
    </div>
  );
}

function VerdictCard({ summary }: { summary: BatchSummary }) {
  const { t } = useApp();
  const triggered = summary.aggregateDecision.triggeredRules;
  return (
    <Card>
      <CardHead>
        <span className="text-[12.5px] font-medium text-ink-1">{t("rc_total_verdict")}</span>
      </CardHead>
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <DecisionBadge value={summary.aggregateDecision.decision} size="xl" />
          {summary.aggregateDecision.terminal && (
            <Badge variant="warn">
              ↯ step {summary.aggregateDecision.terminalAtStep ?? "?"}
            </Badge>
          )}
        </div>
        <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-ink-3">cand</dt>
          <dd className="font-mono text-ink-1">{summary.input.candidateId}</dd>
          <dt className="text-ink-3">job</dt>
          <dd className="font-mono text-ink-2">{summary.input.jobRef ?? "—"}</dd>
          <dt className="text-ink-3">client</dt>
          <dd className="text-ink-2">
            {summary.input.scope.client}
            {summary.input.scope.department && ` / ${summary.input.scope.department}`}
          </dd>
        </dl>
        {triggered.length > 0 && (
          <div className="text-[11.5px] text-ink-3">
            triggered ({triggered.length}):{" "}
            <span className="font-mono text-ink-2">
              {triggered.slice(0, 12).join(", ")}
              {triggered.length > 12 && ` (+${triggered.length - 12} more)`}
            </span>
          </div>
        )}
      </div>
    </Card>
  );
}

function StepCallsCard({
  stepCalls,
  totalLatency,
  totalIn,
  totalOut,
}: {
  stepCalls: BatchStepCallSlim[];
  totalLatency: number;
  totalIn: number;
  totalOut: number;
}) {
  const { t } = useApp();
  return (
    <Card>
      <CardHead>
        <span className="text-[12.5px] font-medium text-ink-1">{t("rc_step_calls")}</span>
      </CardHead>
      <div className="p-4 flex flex-col gap-2">
        {stepCalls.map((sc) => (
          <div key={sc.stepKey} className="flex items-center gap-2 text-[12px]">
            <span
              className={`inline-block w-2.5 h-2.5 rounded-full ${
                sc.shortCircuited ? "bg-warn" : "bg-ok"
              }`}
            />
            <span className="font-mono text-ink-1 w-[60px]">{sc.stepKey}</span>
            {sc.shortCircuited ? (
              <span className="text-warn flex-1">skipped (short-circuit)</span>
            ) : (
              <span className="text-ink-3 flex-1">
                {sc.latencyMs}ms · {sc.inputTokens}/{sc.outputTokens}tok ·{" "}
                <span className="font-mono text-ink-4">{sc.model}</span>
              </span>
            )}
            {sc.triggeredShortCircuit && (
              <Badge variant="warn">↯ {sc.triggeredShortCircuit.byRuleId}</Badge>
            )}
          </div>
        ))}
        <div className="text-[11px] text-ink-4 mt-1 border-t border-line pt-2">
          total {totalLatency}ms · {totalIn}/{totalOut} tok
        </div>
      </div>
    </Card>
  );
}

function OverviewCard({
  title,
  instance,
  fields,
}: {
  title: string;
  instance: Instance | null;
  fields: Array<{ label: string; value: string }>;
}) {
  const [showRaw, setShowRaw] = useState(false);
  if (!instance) {
    return (
      <Card>
        <CardHead>
          <span className="text-[12.5px] font-medium text-ink-1">{title}</span>
        </CardHead>
        <div className="p-4 text-[12px] text-ink-3 italic">(no instance available)</div>
      </Card>
    );
  }
  return (
    <Card>
      <CardHead>
        <span className="text-[12.5px] font-medium text-ink-1">{title}</span>
        <span className="ml-2 font-mono text-[10.5px] text-ink-4">
          {instance.objectType} · {instance.objectId}
        </span>
        <Btn variant="ghost" size="sm" className="ml-auto" onClick={() => setShowRaw((s) => !s)}>
          {showRaw ? "▴ collapse" : "▾ raw"}
        </Btn>
      </CardHead>
      <div className="p-4">
        {fields.length === 0 ? (
          <div className="text-[12px] text-ink-3 italic">(no key fields)</div>
        ) : (
          <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-[12px]">
            {fields.map((f, i) => (
              <Row key={i} label={f.label} value={f.value} />
            ))}
          </dl>
        )}
        {showRaw && (
          <pre className="mt-3 border-t border-line pt-2 font-mono text-[10.5px] text-ink-2 whitespace-pre-wrap break-all max-h-80 overflow-auto">
            {JSON.stringify(instance.data, null, 2)}
          </pre>
        )}
      </div>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-ink-1">{value}</dd>
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

function StepGroupSection({ group }: { group: BatchStepGroup }) {
  return (
    <Card>
      <CardHead>
        <span className="text-[12.5px] font-medium text-ink-1">
          Step {group.stepOrder}
        </span>
        <span className="ml-2 text-[11px] text-ink-3">({group.rules.length} rules)</span>
      </CardHead>
      <div className="p-3 flex flex-col gap-2">
        {group.rules.map((rule) => (
          <RuleCard key={rule.runId} rule={rule} />
        ))}
      </div>
    </Card>
  );
}

function RuleCard({ rule }: { rule: BatchRuleEntry }) {
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  const isShortCircuit = rule.overrideReason?.startsWith("short_circuit:");
  return (
    <div className="rounded border border-line bg-bg">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-panel"
      >
        <span className="font-mono text-[12px] text-ink-1 w-[60px] flex-shrink-0">{rule.ruleId}</span>
        <DecisionBadge value={rule.decision} size="sm" />
        {isShortCircuit ? (
          <Badge variant="warn">↯ {t("rc_short_circuited")}</Badge>
        ) : null}
        <span className="text-[11.5px] text-ink-3 truncate flex-1 min-w-0">
          {isShortCircuit
            ? rule.overrideReason
            : rule.conclusionText || rule.ruleName || "(no conclusion)"}
        </span>
        <span className="text-[10px] text-ink-4 ml-2">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="border-t border-line p-3 flex flex-col gap-3 text-[12px]">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1">
              {t("rc_rule_source_text")} · <span className="font-mono normal-case tracking-normal text-ink-4">{rule.ruleName}</span>
            </div>
            <pre className="m-0 font-sans whitespace-pre-wrap text-ink-2 leading-relaxed">
              {rule.sourceText || "(no source text)"}
            </pre>
          </div>
          {!isShortCircuit && (rule.dataObservationText || rule.contrastReasoningText || rule.conclusionText) && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1">
                {t("rc_judgment_basis")}
              </div>
              <dl className="grid grid-cols-[80px_1fr] gap-x-3 gap-y-1.5 text-[11.5px]">
                {rule.dataObservationText && (
                  <>
                    <dt className="text-ink-3">数据观察</dt>
                    <dd className="text-ink-1 leading-relaxed">{rule.dataObservationText}</dd>
                  </>
                )}
                {rule.contrastReasoningText && (
                  <>
                    <dt className="text-ink-3">对照推理</dt>
                    <dd className="text-ink-1 leading-relaxed">{rule.contrastReasoningText}</dd>
                  </>
                )}
                {rule.conclusionText && (
                  <>
                    <dt className="text-ink-3">结论</dt>
                    <dd className="text-ink-1 leading-relaxed">{rule.conclusionText}</dd>
                  </>
                )}
              </dl>
            </div>
          )}
          <div>
            <Link href={`/rule-check/runs/${rule.runId}`}>
              <Btn variant="ghost" size="sm">
                {t("rc_open_full_judgment")} ↗
              </Btn>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
