"use client";
/**
 * 3-tab Prompt panel — Layer 5 of the Prove page.
 *
 * Tabs:
 *   1. Resolved prompt — exactly what the LLM saw (user message)
 *   2. Source actionObject — the snapshot of generatePrompt's input
 *   3. Raw LLM response — verbatim API response body
 *
 * Per locked decision: Re-run + diff cancelled, so Tab 3 is the unparsed
 * receipt rather than a diff view.
 */
import React, { useState } from "react";
import { useApp } from "@/lib/i18n";
import type { PromptProvenance } from "@/lib/rule-check";

export interface PromptPanelProps {
  prompt: string;
  provenance: PromptProvenance;
  llmRawResponse: unknown;
  defaultTab?: "resolved" | "source" | "raw";
}

type Tab = "resolved" | "source" | "raw";

export function PromptPanel({
  prompt,
  provenance,
  llmRawResponse,
  defaultTab = "resolved",
}: PromptPanelProps) {
  const { t } = useApp();
  const [tab, setTab] = useState<Tab>(defaultTab);

  return (
    <div className="rounded-lg border border-line bg-surface shadow-sh-1 overflow-hidden">
      <div className="flex items-stretch border-b border-line bg-surface">
        <TabBtn active={tab === "resolved"} onClick={() => setTab("resolved")}>
          {t("rc_tab_resolved")}
        </TabBtn>
        <TabBtn active={tab === "source"} onClick={() => setTab("source")}>
          {t("rc_tab_source")}
        </TabBtn>
        <TabBtn active={tab === "raw"} onClick={() => setTab("raw")}>
          {t("rc_tab_raw_response")}
        </TabBtn>
        <div className="ml-auto px-3 py-2 text-[10px] text-ink-3 font-mono self-center">
          prompt sha: {provenance.promptSha256.slice(0, 12)}…
        </div>
      </div>
      <div className="p-3">
        {tab === "resolved" && <ResolvedView prompt={prompt} />}
        {tab === "source" && <SourceView provenance={provenance} />}
        {tab === "raw" && <RawView raw={llmRawResponse} />}
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-4 py-2 text-[12px] font-medium border-b-2 transition-colors"
      style={{
        borderColor: active ? "var(--c-accent)" : "transparent",
        color: active ? "var(--c-accent)" : "var(--c-ink-3)",
        background: active ? "var(--c-accent-bg)" : "transparent",
      }}
    >
      {children}
    </button>
  );
}

function ResolvedView({ prompt }: { prompt: string }) {
  return (
    <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap font-mono text-[11px] text-ink-2 leading-relaxed">
      {prompt}
    </pre>
  );
}

function SourceView({ provenance }: { provenance: PromptProvenance }) {
  return (
    <div className="flex flex-col gap-2 text-[12px]">
      <div className="grid grid-cols-2 gap-3">
        <KV k="actionRef" v={provenance.generatePromptInput.actionRef} />
        <KV k="domain" v={provenance.generatePromptInput.domain} />
        <KV k="client" v={provenance.generatePromptInput.client} />
        <KV
          k="clientDepartment"
          v={provenance.generatePromptInput.clientDepartment ?? "—"}
        />
        <KV
          k="runtimeInputDigest"
          v={provenance.generatePromptInput.runtimeInputDigest.slice(0, 16) + "…"}
        />
        <KV k="resolvedAt" v={provenance.resolvedAt} />
      </div>
      <div className="grid grid-cols-2 gap-3 mt-2">
        <KV k="promptSha256" v={provenance.promptSha256} mono />
        <KV k="actionObjectSha256" v={provenance.actionObjectSha256} mono />
      </div>
    </div>
  );
}

function RawView({ raw }: { raw: unknown }) {
  return (
    <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap font-mono text-[11px] text-ink-2 leading-relaxed">
      {JSON.stringify(raw, null, 2)}
    </pre>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-ink-3">{k}</div>
      <div
        className={`mt-0.5 text-ink-1 ${mono ? "font-mono text-[10.5px] break-all" : ""}`}
      >
        {v}
      </div>
    </div>
  );
}
