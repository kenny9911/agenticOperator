"use client";
/**
 * /rule-check/runs/[runId] — the Prove page.
 *
 * Eight vertical layers (SPEC §9.2), each a Card with an anchor id. L2 and
 * L5 are new in this iteration (2026-05-13):
 *   1. Verdict hero
 *   2. ★ Inference Chain (Rule → decisive Evidence → Verdict; SPEC §9.2)
 *   3. Why this verdict (RootCauseTimeline; dataObservation chip-ified per D5)
 *   4. Evidence ledger (EvidenceCard grid + drawer for raw instance JSON)
 *   5. ★ Counterfactuals (LLM-speculative, surfaced from envelope; UI-D)
 *   6. Validation strip (4-light board + failures pills)
 *   7. Prompt + Response receipts (PromptPanel 3-tab + ResponsePanel + LogprobInlineChart)
 *   8. Ask why (AskWhyChat)
 */
import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { Badge, Btn, Card, CardHead } from "@/components/shared/atoms";
import { useApp } from "@/lib/i18n";
import { DecisionBadge } from "./atoms/DecisionBadge";
import { ConfidenceRing } from "./atoms/ConfidenceRing";
import { InferenceChain } from "./atoms/InferenceChain";
import { RootCauseTimeline } from "./atoms/RootCauseTimeline";
import { EvidenceCard } from "./atoms/EvidenceCard";
import { ValidationLight } from "./atoms/ValidationLight";
import { PromptPanel } from "./atoms/PromptPanel";
import { ResponsePanel } from "./atoms/ResponsePanel";
import { LogprobInlineChart } from "./atoms/LogprobInlineChart";
import { AskWhyChat } from "./atoms/AskWhyChat";
import { CounterfactualsList } from "./atoms/CounterfactualsList";
import { ReplayButton } from "./atoms/ReplayButton";
import type { Instance, RuleCheckRunAudited } from "@/lib/rule-check";

export interface RunDetailContentProps {
  run: RuleCheckRunAudited;
}

export function RunDetailContent({ run }: RunDetailContentProps) {
  const { t } = useApp();
  const [drawer, setDrawer] = useState<Instance | null>(null);

  const fetchedInstances = run.fetched.instances;
  const evidence = run.llmParsed?.evidence ?? [];

  // For SPEC §9.3 D5 — map evidence.objectId → first index, used to chip-ify
  // bracketed IDs in `rootCauseSections.dataObservation`.
  const evidenceIndexByObjectId = useMemo(() => {
    const m = new Map<string, number>();
    evidence.forEach((ev, i) => {
      if (!m.has(ev.objectId)) m.set(ev.objectId, i);
    });
    return m;
  }, [evidence]);

  function resolveSource(idx: number): Instance | undefined {
    return fetchedInstances[idx];
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-y-auto">
      <div className="flex flex-col gap-4 p-6 max-w-[1100px] mx-auto w-full">
      {/* ── Layer 1: Verdict hero ───────────────────────────────── */}
      <Card>
        <div id="layer-1" className="p-4 flex items-center gap-6">
          <DecisionBadge
            value={run.finalDecision.decision}
            size="xl"
            overridden={!!run.finalDecision.overrideReason}
          />
          {run.llmParsed && (
            <ConfidenceRing
              value={run.llmParsed.confidence}
              size={80}
              label={t("rc_confidence")}
              breakdown={run.confidenceBreakdown}
            />
          )}
          <div className="flex-1 flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[14px] text-ink-1">
                {run.input.ruleId}
              </span>
              <span className="text-ink-3">·</span>
              <span className="text-[14px] text-ink-2">{run.fetched.rule.name}</span>
              {run.finalDecision.overrideReason?.startsWith("short_circuit:") ? (
                <Badge variant="warn">↯ Skipped (short-circuit)</Badge>
              ) : run.finalDecision.overrideReason ? (
                <Badge variant="warn">{t("rc_overridden")}</Badge>
              ) : null}
            </div>
            <div className="text-[12px] text-ink-3">
              <span>
                {t("rc_candidate")}: <span className="font-mono text-ink-2">{run.input.candidateId}</span>
              </span>{" "}
              ·{" "}
              <span>
                {t("rc_job")}: <span className="font-mono text-ink-2">{run.input.jobRef}</span>
              </span>{" "}
              ·{" "}
              <span>
                {t("rc_client")}: <span className="text-ink-2">{run.input.scope.client}{run.input.scope.department ? " / " + run.input.scope.department : ""}</span>
              </span>
            </div>
            <div className="text-[11px] text-ink-3">
              {run.timestamp} · runId {run.runId.slice(0, 12)}…
            </div>
          </div>
          <div className="flex flex-col gap-1.5 items-end">
            <ReplayButton runId={run.runId} />
            <Btn variant="ghost" size="sm" onClick={() => navigator.clipboard?.writeText(run.runId)}>
              {t("rc_copy_run_id")}
            </Btn>
            <Link
              href={`/rule-check/candidates/${run.input.candidateId}`}
              className="rounded-md border border-line bg-surface px-2.5 py-1 text-[11.5px] text-ink-1 hover:bg-panel"
            >
              {t("rc_candidates")} →
            </Link>
          </div>
        </div>
        {run.finalDecision.overrideReason && (
          <div className="border-t border-line bg-warn-bg px-4 py-2 text-[11.5px] text-warn">
            {run.finalDecision.overrideReason.startsWith("short_circuit:")
              ? `↯ ${run.finalDecision.overrideReason} — 本规则未进入评估,上游 step 已硬终止`
              : `⚠ ${run.finalDecision.overrideReason}`}
          </div>
        )}
      </Card>

      {/* ── Layer 2: ★ Inference Chain ────────────────────────── */}
      <Card>
        <CardHead>
          <a id="layer-2" />
          <span className="text-[12.5px] font-medium text-ink-1">
            {t("rc_chain_title")}
          </span>
        </CardHead>
        <div className="p-2">
          <InferenceChain run={run} />
        </div>
      </Card>

      {/* ── Layer 3: Why this verdict ─────────────────────────── */}
      {run.llmParsed?.rootCauseSections && (
        <Card>
          <CardHead>
            <a id="layer-3" />
            <span className="text-[12.5px] font-medium text-ink-1">{t("rc_why")}</span>
          </CardHead>
          <div className="p-4">
            <RootCauseTimeline
              sections={run.llmParsed.rootCauseSections}
              renderedSections={{
                dataObservation: chipifyText(
                  run.llmParsed.rootCauseSections.dataObservation,
                  evidenceIndexByObjectId,
                ),
              }}
            />
          </div>
        </Card>
      )}

      {/* ── Layer 4: Evidence ledger ──────────────────────────── */}
      <Card>
        <CardHead>
          <a id="layer-4" />
          <span className="text-[12.5px] font-medium text-ink-1">{t("rc_evidence")}</span>
          <span className="ml-2 text-[11px] text-ink-3">{evidence.length}</span>
        </CardHead>
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          {evidence.length === 0 && (
            <div className="col-span-2 text-center text-ink-3 text-[12px] py-6">
              (no evidence emitted)
            </div>
          )}
          {evidence.map((ev, i) => (
            <EvidenceCard
              key={i}
              evidence={ev}
              sourceInstance={resolveSource(ev.fetchedInstanceIndex)}
              onViewSource={(inst) => setDrawer(inst)}
            />
          ))}
        </div>
      </Card>

      {/* ── Layer 5: ★ Counterfactuals (hidden when absent) ──── */}
      {run.llmParsed?.counterfactuals && run.llmParsed.counterfactuals.length > 0 && (
        <Card>
          <CardHead>
            <a id="layer-5" />
            <span className="text-[12.5px] font-medium text-ink-1">
              {t("rc_cf_title")}
            </span>
          </CardHead>
          <div className="p-4">
            <CounterfactualsList counterfactuals={run.llmParsed.counterfactuals} />
          </div>
        </Card>
      )}

      {/* ── Layer 6: Validation strip ───────────────────────── */}
      <Card>
        <CardHead>
          <a id="layer-6" />
          <span className="text-[12.5px] font-medium text-ink-1">{t("rc_validation")}</span>
        </CardHead>
        <div className="p-4 flex flex-col gap-3">
          <ValidationLight report={run.validation} variant="full" />
          {run.validation.failures.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {run.validation.failures.map((f, i) => (
                <Badge key={i} variant="err">{f}</Badge>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* ── Layer 7: Prompt + Response receipts ─────────────── */}
      <Card>
        <CardHead>
          <a id="layer-7" />
          <span className="text-[12.5px] font-medium text-ink-1">{t("rc_prompt")} + {t("rc_response")}</span>
        </CardHead>
        <div className="p-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
          <PromptPanel
            prompt={run.prompt}
            provenance={run.promptProvenance}
            llmRawResponse={run.llmRaw.response}
          />
          <div className="flex flex-col gap-3">
            <ResponsePanel llmRaw={run.llmRaw} parsed={run.llmParsed} />
            {/* Logprob chart if available — confidenceBreakdown.logprobScore != null */}
            {run.confidenceBreakdown.source === "composite_full" && (
              <LogprobInlineChart
                tokens={generateMockLogprobs(run.llmRaw.outputTokens)}
              />
            )}
          </div>
        </div>
      </Card>

      {/* ── Layer 8: Ask why ────────────────────────────────── */}
      <Card>
        <CardHead>
          <a id="layer-8" />
          <span className="text-[12.5px] font-medium text-ink-1">{t("rc_ask_why")}</span>
        </CardHead>
        <div className="p-4">
          <AskWhyChat run={run} />
        </div>
      </Card>

      {/* ── Source drawer (overlay) ──────────────────────────── */}
      {drawer && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-end bg-black/40"
          onClick={() => setDrawer(null)}
        >
          <aside
            className="h-full w-full max-w-2xl bg-surface border-l border-line shadow-sh-2 overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 flex items-center justify-between border-b border-line bg-surface px-4 py-3">
              <div>
                <div className="text-[10.5px] uppercase tracking-wide text-ink-3">
                  {t("rc_drawer_source")}
                </div>
                <div className="font-mono text-[13px] text-ink-1">
                  {drawer.objectType}/{drawer.objectId}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDrawer(null)}
                className="rounded border border-line px-2 py-1 text-[12px] text-ink-2 hover:bg-panel"
              >
                ✕
              </button>
            </div>
            <pre className="p-4 font-mono text-[11px] text-ink-2 whitespace-pre-wrap">
              {JSON.stringify(drawer.data, null, 2)}
            </pre>
          </aside>
        </div>
      )}
      </div>
    </div>
  );
}

// Mock logprobs for the chart preview when run was made with `composite_full`.
function generateMockLogprobs(outputTokens: number): Array<{ token: string; logprob: number }> {
  const n = Math.min(50, Math.max(10, outputTokens));
  const out: Array<{ token: string; logprob: number }> = [];
  for (let i = 0; i < n; i++) {
    out.push({ token: `t${i}`, logprob: -0.05 - Math.random() * 0.6 });
  }
  return out;
}

/**
 * SPEC §9.3 D5 — replace bracketed IDs like "[App-12345]" with clickable
 * chips when they correspond to an `evidence[].objectId` in this run.
 * Non-matching brackets are left as plain text. The chip click scrolls to
 * the corresponding L2 InferenceChain node by id `chain-evidence-<idx>`.
 */
function chipifyText(
  text: string,
  evidenceIndexByObjectId: Map<string, number>,
): ReactNode {
  if (!text) return null;
  const regex = /\[([A-Z][a-zA-Z0-9-]+)\]/g;
  const parts: ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = regex.exec(text)) !== null) {
    const full = m[0];
    const inner = m[1];
    const start = m.index;
    const target = evidenceIndexByObjectId.get(inner);
    if (target !== undefined) {
      if (start > lastIdx) parts.push(text.slice(lastIdx, start));
      parts.push(
        <button
          key={`chip-${key++}`}
          type="button"
          className="inline-flex items-center rounded border px-1.5 mx-0.5 text-[12px] hover:opacity-80"
          style={{
            color: "var(--c-info)",
            background: "var(--c-info-bg)",
            borderColor: "color-mix(in oklab, var(--c-info) 30%, transparent)",
          }}
          onClick={() => scrollToChainEvidence(target)}
        >
          {full}
        </button>,
      );
      lastIdx = start + full.length;
    }
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts.length > 0 ? parts : text;
}

function scrollToChainEvidence(idx: number) {
  if (typeof document === "undefined") return;
  const el = document.getElementById(`chain-evidence-${idx}`);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.style.boxShadow = "0 0 0 3px color-mix(in oklab, var(--c-info) 40%, transparent)";
  setTimeout(() => {
    el.style.boxShadow = "";
  }, 1400);
}
