"use client";

/**
 * /dev/rule-check — engineering preview of the full Rule Checker.
 *
 * Submits to a server action that calls `checkRules()` (batch). Renders the
 * aggregate decision + per-rule cards + audit metadata. Not the commercial
 * UI — that lives at `/rule-check/*`.
 */

import { useEffect, useMemo, useState, useTransition } from "react";

import { runCheckBatch, type RunCheckBatchResult } from "./actions";
import { formatElapsed } from "@/components/rule-check/atoms/formatElapsed";

const DEFAULTS = {
  actionRef: "matchResume",
  candidateId: "C-MVP-001",
  jobRef: "JR-MVP-TENCENT-001",
  client: "腾讯",
  clientDepartment: "",
  domain: "RAAS-v1",
  rules: "",  // empty = all action rules
};

export default function RuleCheckDevPage() {
  const [actionRef, setActionRef] = useState(DEFAULTS.actionRef);
  const [candidateId, setCandidateId] = useState(DEFAULTS.candidateId);
  const [jobRef, setJobRef] = useState(DEFAULTS.jobRef);
  const [client, setClient] = useState(DEFAULTS.client);
  const [clientDepartment, setClientDepartment] = useState(DEFAULTS.clientDepartment);
  const [domain, setDomain] = useState(DEFAULTS.domain);
  const [rulesCsv, setRulesCsv] = useState(DEFAULTS.rules);

  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RunCheckBatchResult | null>(null);
  const [showTrace, setShowTrace] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  // Tick elapsed timer once per second while a run is in flight.
  useEffect(() => {
    if (!isPending) return;
    setElapsedMs(0);
    const startedAt = Date.now();
    const id = setInterval(() => {
      setElapsedMs(Date.now() - startedAt);
    }, 250);
    return () => clearInterval(id);
  }, [isPending]);

  const canRun = useMemo(
    () =>
      !isPending &&
      candidateId.trim().length > 0 &&
      jobRef.trim().length > 0 &&
      client.trim().length > 0,
    [isPending, candidateId, jobRef, client],
  );

  function handleRun() {
    if (!canRun) return;
    startTransition(async () => {
      const ruleIds = rulesCsv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await runCheckBatch({
        actionRef: actionRef.trim(),
        candidateId: candidateId.trim(),
        jobRef: jobRef.trim(),
        client: client.trim(),
        clientDepartment: clientDepartment.trim() || undefined,
        domain: domain.trim(),
        ruleIds: ruleIds.length > 0 ? ruleIds : undefined,
      });
      setResult(res);
    });
  }

  return (
    <main className="min-h-screen bg-bg p-6 font-sans text-ink-1">
      <header className="mb-4">
        <h1 className="text-lg font-semibold text-ink-1">
          Rule Checker (full)
          <span className="ml-2 text-xs font-normal text-ink-3">
            — engineering preview · batch · /dev/rule-check
          </span>
        </h1>
        <p className="mt-1 text-xs text-ink-3">
          Calls <code className="font-mono">checkRules()</code>: one LLM call evaluates all action rules, returns a batch run with aggregate decision + per-rule judgments. Commercial UI lives at <code className="font-mono">/rule-check</code>.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[360px_1fr]">
        <Panel title="Run params">
          <div className="flex flex-col gap-2">
            <Field label="actionRef">
              <input className="input" value={actionRef} onChange={(e) => setActionRef(e.target.value)} />
            </Field>
            <Field label="candidateId">
              <input className="input" value={candidateId} onChange={(e) => setCandidateId(e.target.value)} />
            </Field>
            <Field label="jobRef">
              <input className="input" value={jobRef} onChange={(e) => setJobRef(e.target.value)} />
            </Field>
            <Field label="client">
              <input className="input" value={client} onChange={(e) => setClient(e.target.value)} />
            </Field>
            <Field label="clientDepartment (optional)">
              <input className="input" value={clientDepartment} onChange={(e) => setClientDepartment(e.target.value)} />
            </Field>
            <Field label="domain">
              <input className="input" value={domain} onChange={(e) => setDomain(e.target.value)} />
            </Field>
            <Field label="rules (comma; empty = all)">
              <input className="input" placeholder="10-7,10-17" value={rulesCsv} onChange={(e) => setRulesCsv(e.target.value)} />
            </Field>
            <button
              type="button"
              className="mt-2 rounded bg-accent px-3 py-1.5 text-xs font-semibold text-bg shadow-sh-1 disabled:opacity-50"
              disabled={!canRun}
              onClick={handleRun}
            >
              {isPending ? `Running… ${formatElapsed(elapsedMs)}` : "Run check"}
            </button>
            {isPending && (
              <p className="mt-1 text-[10px] text-ink-3">
                Single LLM call: prefetch → generatePrompt → kimi → envelope parse → per-rule validate. Watch stderr for stage timings (RULE_CHECK_DEBUG=1 for verbose).
              </p>
            )}
          </div>
        </Panel>

        <div className="flex flex-col gap-4">
          {result && !result.ok && (
            <Panel title="Error">
              <pre className="whitespace-pre-wrap text-xs text-err">{result.error}</pre>
            </Panel>
          )}

          {result?.ok && (
            <>
              <Panel title="Aggregate decision">
                <div className="flex items-center gap-3">
                  <span
                    className={`rounded px-3 py-1 text-sm font-bold uppercase ${decisionColor(result.batch.aggregateDecision.decision)}`}
                  >
                    {result.batch.aggregateDecision.decision}
                  </span>
                  {result.batch.aggregateDecision.triggeredRules.length > 0 && (
                    <span className="text-xs text-ink-3">
                      triggered: {result.batch.aggregateDecision.triggeredRules.join(", ")}
                    </span>
                  )}
                </div>
                {result.batch.aggregateDecision.terminal && (
                  <div className="mt-2 rounded border border-warn bg-warn-bg px-3 py-2 text-[11px] text-warn">
                    ↯ <strong>short-circuit @ step {result.batch.aggregateDecision.terminalAtStep}</strong> — 后续 step 跳过 LLM 调用,规则合成为 not_started
                  </div>
                )}
                <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-ink-3 sm:grid-cols-4">
                  <Stat label="batchId" value={result.batch.batchId.slice(0, 8) + "…"} />
                  <Stat label="rules" value={String(result.batch.results.length)} />
                  <Stat label="steps" value={String(result.batch.stepCalls.length)} />
                  <Stat label="model" value={firstStepLlmRaw(result.batch)?.model ?? "—"} />
                  <Stat label="total latency" value={`${sumStepLatency(result.batch)}ms`} />
                  <Stat label="total in/out tok" value={`${sumStepTokens(result.batch, "in")}/${sumStepTokens(result.batch, "out")}`} />
                  <Stat label="api calls" value={String(result.batch.ontologyApiTrace.length)} />
                  <Stat
                    label="step calls"
                    value={result.batch.stepCalls.map((s) => s.shortCircuited ? `${s.stepKey}:skip` : `${s.stepKey}:✓`).join(" ")}
                  />
                </div>
              </Panel>

              <Panel title={`Per-rule judgments (${result.batch.results.length})`}>
                <div className="flex flex-col gap-2">
                  {result.batch.results.map((r) => {
                    const v = r.validation;
                    return (
                      <div key={r.runId} className="rounded border border-line bg-bg p-2 text-xs">
                        <div className="flex items-center gap-2">
                          <code className="font-mono text-ink-1">{r.input.ruleId}</code>
                          <span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${decisionColor(r.finalDecision.decision)}`}>
                            {r.finalDecision.decision}
                          </span>
                          {r.llmParsed && (
                            <span className="text-ink-3">
                              conf={(r.llmParsed.confidence * 100).toFixed(0)}% ({r.confidenceBreakdown.source})
                            </span>
                          )}
                          <span className="ml-auto font-mono text-[10px] text-ink-3">
                            {v.ruleIdExists ? "✓" : "✗"}{v.evidenceGrounded ? "✓" : "✗"}{v.schemaValid ? "✓" : "✗"}
                            {v.blockSemanticCheck === "ok" ? "✓" : v.blockSemanticCheck === "warning" ? "⚠" : "–"}
                          </span>
                        </div>
                        {r.finalDecision.overrideReason && (
                          <div className="mt-1 text-warn">override: {r.finalDecision.overrideReason}</div>
                        )}
                        {r.llmParsed?.rootCauseSections && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-ink-3">rootCause</summary>
                            <div className="mt-1 space-y-1 pl-2 text-ink-2">
                              <div><strong>数据观察:</strong> {r.llmParsed.rootCauseSections.dataObservation}</div>
                              <div><strong>对照推理:</strong> {r.llmParsed.rootCauseSections.contrastReasoning}</div>
                              <div><strong>结论:</strong> {r.llmParsed.rootCauseSections.conclusion}</div>
                            </div>
                          </details>
                        )}
                      </div>
                    );
                  })}
                </div>
              </Panel>

              <Panel title="Trace">
                <button
                  type="button"
                  className="text-xs text-accent underline"
                  onClick={() => setShowTrace(!showTrace)}
                >
                  {showTrace ? "Hide" : "Show"} full batch JSON
                </button>
                {showTrace && (
                  <pre className="mt-2 max-h-[60vh] overflow-auto rounded bg-bg p-2 font-mono text-[10px] text-ink-2">
                    {JSON.stringify(result.batch, null, 2)}
                  </pre>
                )}
              </Panel>
            </>
          )}
        </div>
      </div>

      <style jsx>{`
        .input {
          font-family: inherit;
          font-size: 12px;
          padding: 4px 8px;
          border-radius: 4px;
          border: 1px solid var(--c-line);
          background: var(--c-surface);
          color: var(--c-ink-1);
        }
      `}</style>
    </main>
  );
}

type BatchResultLike = Extract<RunCheckBatchResult, { ok: true }>["batch"];

function firstStepLlmRaw(batch: BatchResultLike): BatchResultLike["stepCalls"][number]["llmRaw"] | null {
  return batch.stepCalls.find((s) => !s.shortCircuited)?.llmRaw ?? null;
}

function sumStepLatency(batch: BatchResultLike): number {
  return batch.stepCalls.reduce((sum, s) => sum + (s.llmRaw?.latencyMs ?? 0), 0);
}

function sumStepTokens(batch: BatchResultLike, kind: "in" | "out"): number {
  return batch.stepCalls.reduce((sum, s) => {
    if (!s.llmRaw) return sum;
    return sum + (kind === "in" ? s.llmRaw.inputTokens : s.llmRaw.outputTokens);
  }, 0);
}

function decisionColor(d: string): string {
  switch (d) {
    case "passed":
      return "bg-ok-bg text-ok";
    case "blocked":
      return "bg-err-bg text-err";
    case "pending_human":
      return "bg-warn-bg text-warn";
    case "not_started":
      return "bg-surface text-ink-3";
    default:
      return "bg-surface text-ink-3";
  }
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface shadow-sh-1">
      <header className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
        {title}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-ink-3">{label}</span>
      {children}
    </label>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className="mt-0.5 font-mono text-ink-1">{value}</div>
    </div>
  );
}
