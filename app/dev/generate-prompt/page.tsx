"use client";

/**
 * /dev/generate-prompt — live preview of the v4 canonical `generatePrompt` flow.
 *
 * The page is action-agnostic: enter an `actionRef`, paste a complete JSON
 * runtime input, hit "Run live". The server action calls `generatePrompt`,
 * which delegates sentinel selection + placeholder substitution to whichever
 * adapter is registered for that action. To exercise a new action, register
 * an adapter in `lib/ontology-gen/v4/runtime-adapters/index.ts`, swap the
 * actionRef + paste its JSON shape — no UI change needed.
 *
 * `client` is required (drives rule filter + renders the `### client` block);
 * `clientDepartment` is optional.
 *
 * Dev-only, URL-only (not in LeftNav). Port 3002.
 */

import { useMemo, useState, useTransition } from "react";

import { runLive, type RunLiveResult } from "./actions";

const DEFAULT_INPUT_JSON = JSON.stringify(
  {
    job: {
      job_requisition_id: "JR-2026-001",
      title: "高级后端工程师",
      client: "腾讯",
      department: "互动娱乐事业群",
      required_skills: ["Java", "Spring Boot", "MySQL"],
      preferred_skills: ["Kafka", "Redis"],
      min_years_experience: 5,
      education: "本科及以上",
      age_max: 40,
    },
    resume: {
      candidate_id: "C-12345",
      name: "Alice",
      date_of_birth: "1990-03-15",
      gender: "女",
      highest_education: {
        school: "复旦大学",
        degree: "本科",
        major: "计算机科学与技术",
        graduation_year: 2012,
        is_full_time: true,
      },
      work_experience: [
        {
          company: "字节跳动",
          title: "后端工程师",
          start_date: "2022-01",
          end_date: "2025-12",
          responsibilities:
            "负责广告投放系统服务端开发，主导亿级 QPS 接口的性能优化。",
        },
      ],
      skill_tags: ["Java", "Spring Boot", "MySQL", "Redis", "Kafka"],
      conflict_of_interest_declaration: "无亲属在腾讯任职。",
    },
  },
  null,
  2,
);

export default function GeneratePromptPage() {
  const [actionRef, setActionRef] = useState("matchResume");
  const [domain, setDomain] = useState("RAAS-v1");
  const [client, setClient] = useState("腾讯");
  const [clientDepartment, setClientDepartment] = useState("互动娱乐事业群");
  const [inputJson, setInputJson] = useState(DEFAULT_INPUT_JSON);

  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<RunLiveResult | null>(null);

  // Parse the JSON eagerly so we can disable the button when malformed and
  // show a friendly parse-error panel before the user fires a network call.
  const { input, parseError } = useMemo(() => {
    try {
      const parsed = JSON.parse(inputJson) as unknown;
      return { input: parsed, parseError: null as string | null };
    } catch (e) {
      return {
        input: null as unknown,
        parseError: e instanceof Error ? e.message : String(e),
      };
    }
  }, [inputJson]);

  function handleRun() {
    if (parseError || input === null || input === undefined) return;
    if (client.trim().length === 0) return;
    startTransition(async () => {
      const res = await runLive({
        actionRef,
        domain,
        client: client.trim(),
        clientDepartment: clientDepartment.trim() || undefined,
        runtimeInput: input as Record<string, unknown> | string,
      });
      setResult(res);
    });
  }

  const canRun = !parseError && !isPending && client.trim().length > 0;

  return (
    <main className="min-h-screen bg-bg p-6 font-sans text-ink-1">
      <header className="mb-4">
        <h1 className="text-lg font-semibold text-ink-1">
          Generate Prompt
          <span className="ml-2 text-xs font-normal text-ink-3">
            — v4 live preview (any registered action)
          </span>
        </h1>
        <p className="mt-1 text-xs text-ink-3">
          Enter an <code className="font-mono">actionRef</code> +{" "}
          <code className="font-mono">client</code> (required), optionally a{" "}
          <code className="font-mono">clientDepartment</code>, paste the
          runtime input JSON, hit{" "}
          <strong className="text-ink-2">Run live</strong>. The server action
          calls <code className="font-mono">generatePrompt</code> against the
          Ontology API and renders the substituted prompt below. Token stays
          server-side.
        </p>
      </header>

      <Panel title="Live fetch params">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-4">
          <Field label="actionRef">
            <input
              value={actionRef}
              onChange={(e) => setActionRef(e.target.value)}
              className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
              placeholder="matchResume"
            />
          </Field>
          <Field label="domain">
            <input
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
              placeholder="RAAS-v1"
            />
          </Field>
          <Field label="client (required)">
            <input
              value={client}
              onChange={(e) => setClient(e.target.value)}
              className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
              placeholder="腾讯"
            />
          </Field>
          <Field label="clientDepartment (optional)">
            <input
              value={clientDepartment}
              onChange={(e) => setClientDepartment(e.target.value)}
              className="w-full rounded border border-line bg-bg px-2 py-1 text-sm focus:border-accent focus:outline-none"
              placeholder="互动娱乐事业群"
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
            {isPending ? "Fetching…" : "Run live"}
          </button>
          {client.trim().length === 0 ? (
            <span className="ml-3 text-xs text-warn">client is required</span>
          ) : null}
        </div>
      </Panel>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* ── Left: single JSON input ── */}
        <section className="flex flex-col gap-3">
          <Panel title="Runtime input (single JSON object)">
            <textarea
              value={inputJson}
              onChange={(e) => setInputJson(e.target.value)}
              rows={36}
              spellCheck={false}
              className="w-full resize-y rounded border border-line bg-bg px-2 py-1 font-mono text-xs leading-relaxed text-ink-1 focus:border-accent focus:outline-none"
            />
          </Panel>
          {parseError ? (
            <div className="rounded-lg border border-err bg-err-bg p-3 text-xs">
              <div className="font-semibold text-err">JSON parse error</div>
              <div className="mt-1 font-mono text-ink-1">{parseError}</div>
            </div>
          ) : null}
        </section>

        {/* ── Right: result ── */}
        <section className="flex flex-col gap-3">
          <ResultMeta result={result} />
          <Panel title="Filled prompt (markdown)">
            <PromptPre result={result} parseError={parseError} />
          </Panel>
          {result && !result.ok ? (
            <div className="rounded-lg border border-err bg-err-bg p-3 text-xs">
              <div className="font-semibold text-err">Error</div>
              <div className="mt-1 font-mono text-ink-1">{result.error}</div>
              {result.details ? (
                <pre className="mt-2 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-ink-2">
                  {JSON.stringify(result.details, null, 2)}
                </pre>
              ) : null}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}

// ─── sub-components ───

function ResultMeta({ result }: { result: RunLiveResult | null }) {
  if (!result) {
    return (
      <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-3">
        Click &quot;Run live&quot; to fetch the prompt from the Ontology API.
      </div>
    );
  }
  if (!result.ok) {
    return (
      <div className="rounded-lg border border-err bg-err-bg px-3 py-2 text-xs text-err">
        Result: error (see panel below)
      </div>
    );
  }
  const m = result.meta;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-line bg-surface px-3 py-2 text-xs text-ink-3">
      <Stat label="action" value={m.actionName} />
      <Stat label="id" value={m.actionId} />
      <Stat label="domain" value={m.domain} />
      <Stat label="client" value={m.client ?? "(none)"} />
      <Stat label="template" value={m.templateVersion} />
      <Stat label="strategy" value={m.promptStrategy} />
      <Stat label="compiledAt" value={m.compiledAt} />
    </div>
  );
}

function PromptPre({
  result,
  parseError,
}: {
  result: RunLiveResult | null;
  parseError: string | null;
}) {
  if (parseError) {
    return (
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-3">
        (fix JSON parse error to enable Run live)
      </pre>
    );
  }
  if (!result) {
    return (
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-3">
        (no result yet)
      </pre>
    );
  }
  if (!result.ok) {
    return (
      <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-3">
        (no prompt — see error)
      </pre>
    );
  }
  return (
    <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-1">
      {result.prompt}
    </pre>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface shadow-sh-1">
      <header className="border-b border-line px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
        {title}
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
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
