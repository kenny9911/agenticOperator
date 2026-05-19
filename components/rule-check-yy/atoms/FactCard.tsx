"use client";
/**
 * Fact card — the atom of Layer 2 (Inference Chain).
 *
 * Two states:
 *   - Collapsed: in-chain node, ~200px wide, 5 lines tall
 *   - Expanded: in-place, ~400px wide, 6 sections per SPEC §9.2
 *
 * The 6 expanded sections (all derived from existing audit JSON — no LLM
 * re-invocation; only D1, D2 derivations per SPEC §9.3):
 *   ① Cited slice — from `evidence[i]`
 *   ② Rule binding — `fetched.rule.{name, spec/sourceText, stepOrder}`
 *   ③ Source receipt — trace entry matched by D2 heuristic
 *   ④ Raw JSON — fetched instance, with cited field marked
 *   ⑤ Cross-references — D1 derivation, in-run only
 *   ⑥ Verify externally — Neo4j browser link + Copy as Cypher
 *
 * Border tint signals trust:
 *   decisive=true & grounded=true   → green tint (the trusted path)
 *   decisive=true & grounded=false  → red 2px + ⚠ (the hallucination signal)
 *   decisive=false                  → muted line (informational)
 *   grounded=undefined              → dashed (unvalidated)
 */

import { useState } from "react";
import { Badge } from "@/components/shared/atoms";
import type {
  EvidenceAudited,
  Instance,
  FetchedRule,
  OntologyApiTraceEntry,
} from "@/lib/rule-check";

export interface FactCardProps {
  evidence: EvidenceAudited;
  instance: Instance | undefined;
  rule: FetchedRule;
  traceEntries: OntologyApiTraceEntry[];
  allInstances: Instance[];
  expanded: boolean;
  onToggle: () => void;
}

export function FactCard({
  evidence,
  instance,
  rule,
  traceEntries,
  allInstances,
  expanded,
  onToggle,
}: FactCardProps) {
  const border = borderStyle(evidence);
  // Outer element is a `<div role="button">` rather than a native `<button>`
  // because the expanded body contains interactive children (<a> to Neo4j
  // Browser + <button> Copy Cypher in VerifyActions). HTML forbids nested
  // interactive elements; React 19 / Next 16 surface that as a hydration
  // error. ARIA semantics + keyboard activation preserved manually below;
  // inner elements already have `stopPropagation` so toggle bubble is OK.
  // SPEC §15 row "FactCard hydration fix" — 2026-05-13.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
      aria-expanded={expanded}
      className="text-left bg-surface shadow-sh-1 rounded-lg overflow-hidden transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-accent"
      style={{
        ...border,
        width: expanded ? 400 : 200,
        minHeight: expanded ? undefined : 120,
      }}
    >
      <CollapsedHeader evidence={evidence} />
      {expanded && (
        <div className="border-t border-line p-3 flex flex-col gap-3 text-[11px]">
          <Section label="① Cited slice">
            <KV k="field" v={evidence.field} />
            <KV k="value" v={formatValue(evidence.value)} />
            <KV
              k="role"
              v={
                <span className="inline-flex items-center gap-2">
                  {evidence.decisive ? (
                    <Badge variant="info">decisive</Badge>
                  ) : (
                    <Badge>informational</Badge>
                  )}
                  {evidence.grounded === true && <Badge variant="ok">grounded</Badge>}
                  {evidence.grounded === false && (
                    <Badge variant="err">not grounded ⚠</Badge>
                  )}
                </span>
              }
            />
          </Section>

          <Section label="② Rule binding">
            <div className="text-ink-2">
              <span className="font-mono">{rule.id}</span> · {rule.name}
              <span className="ml-2 text-ink-3">Step {rule.stepOrder}</span>
            </div>
            <div className="mt-1 text-ink-3 line-clamp-3 whitespace-pre-wrap">
              {rule.sourceText}
            </div>
          </Section>

          <Section label="③ Source receipt">
            <TraceReceipt
              evidence={evidence}
              traceEntries={traceEntries}
            />
          </Section>

          <Section label="④ Raw JSON">
            {instance ? (
              <RawJson instance={instance} highlightField={evidence.field} />
            ) : (
              <div className="text-ink-3">
                (instance #idx {evidence.fetchedInstanceIndex} not found in
                fetched.instances)
              </div>
            )}
          </Section>

          <Section label="⑤ Cross-references in this run">
            <CrossRefs
              evidence={evidence}
              instance={instance}
              allInstances={allInstances}
            />
          </Section>

          <Section label="⑥ Verify externally">
            <VerifyActions evidence={evidence} />
          </Section>
        </div>
      )}
    </div>
  );
}

// ─── header (always visible) ─────────────────────────────────────────────

function CollapsedHeader({ evidence }: { evidence: EvidenceAudited }) {
  return (
    <div className="p-3 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block w-2 h-2 rounded-full"
          style={{
            background: evidence.decisive
              ? "var(--c-info)"
              : "var(--c-ink-4)",
          }}
        />
        <span className="font-mono text-[11px] text-ink-2 truncate">
          {evidence.objectType}
          <span className="text-ink-4 mx-0.5">·</span>
          {evidence.objectId}
        </span>
      </div>
      <div className="text-[10.5px] text-ink-3">{evidence.field}</div>
      <div className="font-mono text-[11.5px] text-ink-1 break-all line-clamp-2">
        {formatValue(evidence.value)}
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-[10px] text-ink-3">
        {evidence.grounded === true && <span>✓ grounded</span>}
        {evidence.grounded === false && (
          <span style={{ color: "var(--c-err)" }}>⚠ not grounded</span>
        )}
        {evidence.grounded === undefined && <span>· unvalidated</span>}
        <span className="ml-auto font-mono">
          #idx {evidence.fetchedInstanceIndex}
        </span>
      </div>
    </div>
  );
}

// ─── §③ Source receipt (D2) ──────────────────────────────────────────────

function TraceReceipt({
  evidence,
  traceEntries,
}: {
  evidence: EvidenceAudited;
  traceEntries: OntologyApiTraceEntry[];
}) {
  const { primary, ambiguous } = matchTraceEntry(evidence, traceEntries);
  if (!primary) {
    return (
      <div className="text-ink-3">(no matching trace entry; D2 unresolved)</div>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-ink-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-ink-3">GET</span>
        <span
          className="font-mono text-[10.5px] truncate"
          title={primary.requestUrl}
        >
          {primary.requestUrl}
        </span>
        {ambiguous && <Badge variant="warn">ambiguous</Badge>}
      </div>
      <div className="text-ink-3 text-[10.5px]">
        {primary.responseStatus} · {primary.latencyMs}ms · {primary.timestamp}
      </div>
    </div>
  );
}

function matchTraceEntry(
  evidence: EvidenceAudited,
  trace: OntologyApiTraceEntry[],
): { primary: OntologyApiTraceEntry | undefined; ambiguous: boolean } {
  const strict = trace.filter(
    (e) =>
      e.requestUrl.includes(evidence.objectType) &&
      e.requestUrl.includes(evidence.objectId),
  );
  if (strict.length > 0) {
    return { primary: strict[0], ambiguous: strict.length > 1 };
  }
  // Some endpoints (list / filter) won't include the objectId. Fall back to
  // objectType-only match — mark ambiguous because we can't be sure.
  const loose = trace.filter((e) => e.requestUrl.includes(evidence.objectType));
  return { primary: loose[0], ambiguous: loose.length > 1 };
}

// ─── §④ Raw JSON with cited field marker ─────────────────────────────────

function RawJson({
  instance,
  highlightField,
}: {
  instance: Instance;
  highlightField: string;
}) {
  const lines = JSON.stringify(instance.data, null, 2).split("\n");
  return (
    <pre className="rounded bg-bg p-2 font-mono text-[10.5px] text-ink-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
      {lines.map((line, i) => {
        const isHit = new RegExp(`^\\s*"${escapeRegex(highlightField)}"\\s*:`).test(line);
        return (
          <div
            key={i}
            style={{
              color: isHit ? "var(--c-ink-1)" : undefined,
              background: isHit
                ? "color-mix(in oklab, var(--c-info) 12%, transparent)"
                : undefined,
            }}
          >
            {isHit ? "✦ " : "  "}
            {line}
          </div>
        );
      })}
    </pre>
  );
}

// ─── §⑤ Cross-references (D1) ────────────────────────────────────────────

function CrossRefs({
  evidence,
  instance,
  allInstances,
}: {
  evidence: EvidenceAudited;
  instance: Instance | undefined;
  allInstances: Instance[];
}) {
  if (!instance) {
    return <div className="text-ink-3">(instance missing)</div>;
  }
  const refs = deriveCrossRefs(
    {
      idx: evidence.fetchedInstanceIndex,
      objectType: instance.objectType,
      objectId: instance.objectId,
      data: instance.data,
    },
    allInstances,
  );
  if (refs.length === 0) {
    return <div className="text-ink-3">(no cross-references found)</div>;
  }
  return (
    <ul className="flex flex-col gap-1 text-ink-2">
      {refs.map((r, i) => (
        <li key={i} className="flex items-center gap-1.5">
          <span className="font-mono text-ink-3">·</span>
          <span className="font-mono text-ink-1">{r.field}</span>
          <span className="text-ink-3">=</span>
          <span className="font-mono text-[10.5px]">{r.value}</span>
          <span className="text-ink-3">→</span>
          <span className="font-mono text-[10.5px]">
            {r.otherObjectType}/{r.otherObjectId}
          </span>
          <span className="text-ink-3 ml-1">(idx {r.otherIdx})</span>
        </li>
      ))}
    </ul>
  );
}

interface CrossRef {
  field: string;
  value: string;
  otherIdx: number;
  otherObjectType: string;
  otherObjectId: string;
  otherField: string;
}

function deriveCrossRefs(
  current: {
    idx: number;
    objectType: string;
    objectId: string;
    data: Record<string, unknown>;
  },
  allInstances: Instance[],
): CrossRef[] {
  const refs: CrossRef[] = [];
  for (const [field, value] of Object.entries(current.data)) {
    if (typeof value !== "string") continue;
    if (!field.endsWith("_id") && field !== "id") continue;
    for (let i = 0; i < allInstances.length; i++) {
      if (i === current.idx) continue;
      const other = allInstances[i];
      if (!other) continue;
      for (const [otherField, otherValue] of Object.entries(other.data)) {
        if (otherValue === value) {
          refs.push({
            field,
            value,
            otherIdx: i,
            otherObjectType: other.objectType,
            otherObjectId: other.objectId,
            otherField,
          });
        }
      }
    }
  }
  // Dedupe by (otherIdx, otherField)
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.otherIdx}|${r.otherField}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── §⑥ Verify externally ────────────────────────────────────────────────

function VerifyActions({ evidence }: { evidence: EvidenceAudited }) {
  const [copied, setCopied] = useState(false);
  const cypher = `MATCH (n:${evidence.objectType} {id: '${evidence.objectId}'}) RETURN n`;
  const browserUrl = neo4jBrowserUrl(evidence);

  return (
    <div className="flex flex-wrap items-center gap-2">
      {browserUrl ? (
        <a
          href={browserUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink-1 hover:bg-panel"
          onClick={(e) => e.stopPropagation()}
        >
          ↗ Open in Neo4j Browser
        </a>
      ) : (
        <span
          className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink-4 cursor-not-allowed"
          title="set NEXT_PUBLIC_NEO4J_BROWSER_URL"
        >
          ↗ Neo4j Browser (env unset)
        </span>
      )}
      <button
        type="button"
        className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink-1 hover:bg-panel"
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard?.writeText(cypher);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? "✓ copied" : "📋 Copy as Cypher"}
      </button>
    </div>
  );
}

function neo4jBrowserUrl(evidence: EvidenceAudited): string | null {
  const base = process.env.NEXT_PUBLIC_NEO4J_BROWSER_URL;
  if (!base) return null;
  const cmd = `MATCH (n:${evidence.objectType} {id: '${evidence.objectId}'}) RETURN n`;
  return `${base}?cmd=play&arg=${encodeURIComponent(cmd)}`;
}

// ─── helpers ─────────────────────────────────────────────────────────────

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-wide text-ink-3">
        {label}
      </div>
      <div>{children}</div>
    </section>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="text-ink-3 min-w-12">{k}</span>
      <span className="text-ink-1 font-mono break-all">{v}</span>
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function borderStyle(evidence: EvidenceAudited): React.CSSProperties {
  const decisive = evidence.decisive;
  const grounded = evidence.grounded;
  if (decisive && grounded === true) {
    return {
      border: "1px solid color-mix(in oklab, var(--c-ok) 35%, transparent)",
    };
  }
  if (decisive && grounded === false) {
    return {
      border: "2px solid var(--c-err)",
    };
  }
  if (grounded === undefined) {
    return {
      border: "1px dashed var(--c-ink-4)",
    };
  }
  return {
    border: "1px solid var(--c-line)",
  };
}
