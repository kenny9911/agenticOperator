"use client";
/**
 * Ask why chat — Layer 6 of the Prove page.
 *
 * Mock-mode in UI-4: synthesizes answers locally from the run trace.
 * UI-5 will swap `onAsk` to a server action that calls an LLM grounded
 * in the run JSON.
 */
import React, { useState } from "react";
import { useApp } from "@/lib/i18n";
import type { RuleCheckRunAudited } from "@/lib/rule-check";

export interface AskWhyChatProps {
  run: RuleCheckRunAudited;
  onAsk?: (question: string) => Promise<string>;
}

interface Turn {
  q: string;
  a: string;
}

export function AskWhyChat({ run, onAsk }: AskWhyChatProps) {
  const { t } = useApp();
  const [history, setHistory] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const presets = [
    `为什么不是 blocked？`,
    `evidence 是从哪条 instance 来的？`,
    `如果 expected_salary_range 改为 90000-100000，结果如何？`,
  ];

  async function ask(q: string) {
    if (!q.trim()) return;
    setBusy(true);
    setDraft("");
    try {
      const a = onAsk
        ? await onAsk(q)
        : mockAnswer(q, run);
      setHistory((h) => [...h, { q, a }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-surface shadow-sh-1 p-3 flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {presets.map((p, i) => (
          <button
            key={i}
            type="button"
            onClick={() => ask(p)}
            disabled={busy}
            className="rounded border border-line bg-bg px-2 py-1 text-[11px] text-ink-2 hover:bg-panel disabled:opacity-50"
          >
            {p}
          </button>
        ))}
      </div>

      {history.length > 0 && (
        <div className="flex flex-col gap-2 max-h-72 overflow-auto">
          {history.map((turn, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="rounded bg-accent-bg px-3 py-2 text-[12px] text-accent self-end max-w-[80%]">
                Q: {turn.q}
              </div>
              <div className="rounded bg-bg px-3 py-2 text-[12px] text-ink-2 max-w-[90%] whitespace-pre-wrap">
                {turn.a}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") ask(draft);
          }}
          placeholder={t("rc_ask_placeholder")}
          disabled={busy}
          className="flex-1 rounded border border-line bg-bg px-2 py-1.5 text-[12px] text-ink-1 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => ask(draft)}
          disabled={busy || draft.trim().length === 0}
          className="rounded bg-accent px-3 py-1.5 text-[12px] font-medium text-bg disabled:opacity-50"
        >
          {busy ? "…" : "Ask"}
        </button>
      </div>
    </div>
  );
}

function mockAnswer(q: string, run: RuleCheckRunAudited): string {
  // Tiny rule-based mock so UI-4 demos can answer without an LLM call.
  const fd = run.finalDecision.decision;
  if (q.includes("blocked") || q.includes("拦截")) {
    if (fd === "blocked") {
      return `本次判定为 blocked。证据: ${
        run.llmParsed?.evidence
          .filter((e) => e.decisive)
          .map((e) => `${e.objectType}.${e.field}=${JSON.stringify(e.value)}`)
          .join(" + ") ?? "—"
      }。详见 Layer 2 的"对照推理"段。`;
    }
    return `本次判定不是 blocked，是 ${fd}。原因见 rootCauseSections.conclusion。`;
  }
  if (q.includes("evidence") || q.includes("instance")) {
    const ev = run.llmParsed?.evidence ?? [];
    return `evidence 来源:\n${ev
      .map(
        (e, i) =>
          `[${i}] ${e.objectType}/${e.objectId}.${e.field} (fetchedInstanceIndex=${e.fetchedInstanceIndex}, grounded=${e.grounded ?? "—"})`,
      )
      .join("\n")}`;
  }
  if (q.includes("如果") || q.includes("if ")) {
    const cf = run.llmParsed?.counterfactuals ?? [];
    if (cf.length > 0) {
      return `LLM 预测的反事实（推测性）:\n${cf
        .map((c) => `· ${c.hypotheticalChange} → ${c.predictedDecision} (${(c.confidence * 100).toFixed(0)}%)`)
        .join("\n")}`;
    }
    return "未提供反事实分析。可在 LLM 输出的 counterfactuals 字段查看。";
  }
  return `（mock 回复，UI-5 将接入真实 LLM）当前判定 ${fd}，rootCause: ${
    run.llmParsed?.rootCauseSections.conclusion ?? "—"
  }`;
}
