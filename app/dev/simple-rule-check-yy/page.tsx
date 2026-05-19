"use client";

/**
 * /dev/simple-rule-check — interactive preview of the Simple Rule Checker (MVP).
 *
 * Form mirrors `/dev/generate-prompt`'s shape (Panel / Field / Stat). Submits
 * to a server action that calls `checkRule()`. Renders the decision badge,
 * validation strip, evidence cards, root cause + next action, and a
 * collapsible trace panel for the full RuleCheckRun JSON.
 *
 * Dev-only, URL-only (not in LeftNav). Port 3002.
 */

import { useMemo, useState, useTransition } from "react";

import { runCheck, type RunCheckResult } from "./actions";

const RULE_OPTIONS = ["10-7", "10-17", "10-18", "10-25", "10-32"] as const;

const DEFAULTS = {
  actionRef: "matchResume",
  ruleId: "10-7" as (typeof RULE_OPTIONS)[number] | string,
  candidateId: "C-MVP-001",
  jobRef: "JR-MVP-TENCENT-001",
  client: "腾讯",
  clientDepartment: "",
  domain: "RAAS-v1",
};

export default function RuleCheckPage() {
  const [actionRef, setActionRef] = useState(DEFAULTS.actionRef);
  const [ruleId, setRuleId] = useState<string>(DEFAULTS.ruleId);
  const [candidateId, setCandidateId] = useState(DEFAULTS.candidateId);
  const [jobRef, setJobRef] = useState(DEFAULTS.jobRef);
  const [client, setClient] = useState(DEFAULTS.client);
  const [clientDepartment, setClientDepartment] = useState(DEFAULTS.clientDepartment);
  const [domain, setDomain] = useState(DEFAULTS.domain);

  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RunCheckResult | null>(null);
  const [showTrace, setShowTrace] = useState(false);

  const canRun = useMemo(
    () =>
      !isPending &&
      ruleId.trim().length > 0 &&
      candidateId.trim().length > 0 &&
      client.trim().length > 0,
    [isPending, ruleId, candidateId, client],
  );

  function handleRun() {
    if (!canRun) return;
    startTransition(async () => {
      const res = await runCheck({
        actionRef: actionRef.trim(),
        ruleId: ruleId.trim(),
        candidateId: candidateId.trim(),
        jobRef: jobRef.trim() || undefined,
        client: client.trim(),
        clientDepartment: clientDepartment.trim() || undefined,
        domain: domain.trim(),
      });
      setResult(res);
    });
  }

  return (
    <main className="min-h-screen bg-bg p-6 font-sans text-ink-1">
      <header className="mb-4">
        <h1 className="text-lg font-semibold text-ink-1">
          Simple Rule Checker
          <span className="ml-2 text-xs font-normal text-ink-3">
            — MVP preview · matchResume
          </span>
        </h1>
        <p className="mt-1 text-xs text-ink-3">
          Pick a rule, candidate, and tenant scope; the server fetches instances from the
          Ontology API, calls the LLM with strict JSON output, validates evidence is
          grounded in fetched data, and persists an audit trace.
        </p>
      </header>

      <Panel title="Check params">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
          <Field label="actionRef">
            <input
              value={actionRef}
              onChange={(e) => setActionRef(e.target.value)}
              className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
            />
          </Field>
          <Field label="rule">
            <select
              value={ruleId}
              onChange={(e) => setRuleId(e.target.value)}
              className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
            >
              {RULE_OPTIONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="candidateId">
            <input
              value={candidateId}
              onChange={(e) => setCandidateId(e.target.value)}
              className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
            />
          </Field>
          <Field label="jobRef (optional)">
            <input
              value={jobRef}
              onChange={(e) => setJobRef(e.target.value)}
              className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
            />
          </Field>
          <Field label="client (required)">
            <input
              value={client}
              onChange={(e) => setClient(e.target.value)}
              className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
            />
          </Field>
          <Field label="department (optional)">
            <input
              value={clientDepartment}
              onChange={(e) => setClientDepartment(e.target.value)}
              className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
            />
          </Field>
          <Field label="domain">
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
            />
          </Field>
        </div>
        <div className="mt-3">
          <button
            type="button"
            onClick={handleRun}
            disabled={!canRun}
            className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-2 disabled:opacity-50"
          >
            {isPending ? "Running check…" : "Run check"}
          </button>
        </div>
      </Panel>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-3">
          <ResultDecision result={result} />
          <ResultValidation result={result} />
          <ResultEvidence result={result} />
        </section>
        <section className="flex flex-col gap-3">
          <ResultMeta result={result} />
          <ResultReasoning result={result} />
          <Panel title="Trace (RuleCheckRun JSON)">
            <button
              type="button"
              onClick={() => setShowTrace((s) => !s)}
              className="rounded border border-line bg-bg px-2 py-1 text-xs text-ink-2 hover:bg-surface"
            >
              {showTrace ? "Hide trace" : "Show trace"}
            </button>
            {showTrace && result?.ok ? (
              <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-2">
                {JSON.stringify(result.run, null, 2)}
              </pre>
            ) : null}
          </Panel>
        </section>
      </div>

      {result && !result.ok ? (
        <div className="mt-4 rounded-lg border border-err bg-err-bg p-3 text-xs">
          <div className="font-semibold text-err">Error</div>
          <div className="mt-1 font-mono text-ink-1">{result.error}</div>
          {result.details ? (
            <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-ink-2">
              {JSON.stringify(result.details, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

// ─── sub-components ───

function ResultDecision({ result }: { result: RunCheckResult | null }) {
  if (!result) {
    return (
      <Panel title="Decision">
        <div className="text-sm text-ink-3">No result yet. Click &quot;Run check&quot;.</div>
      </Panel>
    );
  }
  if (!result.ok) {
    return (
      <Panel title="Decision">
        <div className="text-sm text-err">Error (see panel below)</div>
      </Panel>
    );
  }
  const d = result.run.finalDecision.decision;
  const reason = result.run.finalDecision.overrideReason;
  const colorClass = decisionColor(d);
  const conf = result.run.llmParsed?.confidence;
  return (
    <Panel title="Decision">
      <div className={`inline-block rounded px-3 py-1 text-sm font-semibold ${colorClass}`}>
        {d.toUpperCase()}
      </div>
      {reason ? (
        <div className="mt-2 text-xs text-warn">
          override: <span className="font-mono">{reason}</span>
        </div>
      ) : null}
      {typeof conf === "number" ? (
        <div className="mt-3">
          <div className="text-xs text-ink-3">Confidence</div>
          <div className="mt-1 h-2 w-full rounded bg-surface">
            <div
              className="h-2 rounded bg-accent"
              style={{ width: `${Math.round(conf * 100)}%` }}
            />
          </div>
          <div className="mt-1 text-xs text-ink-2">{(conf * 100).toFixed(0)}%</div>
        </div>
      ) : null}
    </Panel>
  );
}

function ResultValidation({ result }: { result: RunCheckResult | null }) {
  if (!result?.ok) return null;
  const v = result.run.validation;
  return (
    <Panel title="Validation">
      <div className="flex flex-col gap-1 text-xs">
        <ValidationRow ok={v.ruleIdExists} label="rule_id exists" />
        <ValidationRow ok={v.evidenceGrounded} label="evidence grounded in fetched data" />
        <ValidationRow ok={v.schemaValid} label="LLM output schema valid" />
        <div className="text-ink-3">
          block-semantic: <span className="font-mono">{v.blockSemanticCheck}</span>
        </div>
        {v.failures.length > 0 ? (
          <div className="mt-2 rounded border border-warn bg-warn-bg p-2">
            <div className="font-semibold text-warn">Failures</div>
            <ul className="ml-4 mt-1 list-disc font-mono text-[11px] text-ink-2">
              {v.failures.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function ValidationRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold ${
          ok ? "bg-ok text-white" : "bg-err text-white"
        }`}
      >
        {ok ? "✓" : "✗"}
      </span>
      <span className="text-ink-2">{label}</span>
    </div>
  );
}

function ResultEvidence({ result }: { result: RunCheckResult | null }) {
  if (!result?.ok || !result.run.llmParsed) return null;
  const evs = result.run.llmParsed.evidence;
  if (evs.length === 0) {
    return (
      <Panel title="Evidence">
        <div className="text-sm text-ink-3">(none cited)</div>
      </Panel>
    );
  }
  return (
    <Panel title={`Evidence (${evs.length})`}>
      <div className="flex flex-col gap-2">
        {evs.map((ev, i) => (
          <div key={i} className="rounded border border-line bg-bg p-2 text-xs">
            <div className="text-ink-3">
              <span className="font-mono text-ink-1">{ev.objectType}</span>
              <span className="text-ink-4"> / </span>
              <span className="font-mono text-ink-2">{ev.objectId}</span>
              <span className="text-ink-4"> · </span>
              <span className="font-mono text-ink-2">{ev.field}</span>
            </div>
            <pre className="mt-1 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-ink-1">
              {JSON.stringify(ev.value, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function ResultMeta({ result }: { result: RunCheckResult | null }) {
  if (!result?.ok) return null;
  const r = result.run;
  return (
    <Panel title="Run metadata">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
        <Stat label="runId" value={r.runId} />
        <Stat label="rule" value={r.input.ruleId} />
        <Stat label="candidate" value={r.input.candidateId} />
        <Stat label="job" value={r.input.jobRef ?? "(none)"} />
        <Stat label="domain" value={r.input.domain ?? "TEST-RAAS-v1"} />
        <Stat label="model" value={r.llmRaw.model} />
        <Stat label="tokens" value={`${r.llmRaw.inputTokens} → ${r.llmRaw.outputTokens}`} />
        <Stat label="latency" value={`${r.llmRaw.latencyMs}ms`} />
        <Stat label="audit" value={r.auditPath ?? "(in-memory only)"} />
      </div>
    </Panel>
  );
}

function ResultReasoning({ result }: { result: RunCheckResult | null }) {
  if (!result?.ok || !result.run.llmParsed) return null;
  const p = result.run.llmParsed;
  return (
    <Panel title="Reasoning">
      <div className="text-xs text-ink-3">Root cause</div>
      <div className="mt-1 text-sm text-ink-1">{p.rootCause}</div>
      <div className="mt-3 text-xs text-ink-3">Next action</div>
      <div className="mt-1 font-mono text-sm text-ink-2">{p.nextAction}</div>
    </Panel>
  );
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
    <span>
      <span className="text-ink-4">{label}:</span>{" "}
      <span className="font-mono text-ink-2">{value}</span>
    </span>
  );
}
