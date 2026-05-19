"use client";
/**
 * Inference Chain (Layer 2 of the Prove page).
 *
 * Renders Rule → N decisive Evidence FactCards → Verdict as a horizontal
 * strip, with cubic Bezier arrows connecting the nodes. Arrows are
 * measured-layout: a `ResizeObserver` watches the container + each node
 * and recomputes the path data after each layout change. This keeps the
 * arrows accurate when FactCards expand inline (multiple cards can be
 * open simultaneously, in which case the row grows vertically).
 *
 * Bezier math mirrors `components/workflow/WorkflowContent.tsx:148-155`
 * (right-edge of source → left-edge of target, control points at midpoint).
 *
 * Edge cases:
 *   - `llmParsed === null` (Zod parse failed) → render a single
 *     "schema_invalid" tile pointing to Layer 7.
 *   - `evidence[]` empty OR no decisive evidence → degraded chain:
 *     Rule → ⊘ no decisive evidence → Verdict (dashed gray arrow).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DecisionBadge } from "./DecisionBadge";
import { FactCard } from "./FactCard";
import type {
  RuleCheckRunAudited,
  RuleDecision,
} from "@/lib/rule-check";

export interface InferenceChainProps {
  run: RuleCheckRunAudited;
}

interface ChainPath {
  d: string;
  stroke: string;
  dashed: boolean;
}

const STROKE_BY_DECISION: Record<RuleDecision, string> = {
  passed: "var(--c-ok)",
  blocked: "var(--c-err)",
  pending_human: "var(--c-warn)",
  not_started: "var(--c-ink-3)",
};

export function InferenceChain({ run }: InferenceChainProps) {
  // Schema-invalid short-circuit: LLM output failed Zod parse, no chain to draw.
  if (run.llmParsed === null) {
    return (
      <div className="rounded-md border border-warn bg-warn-bg px-3 py-2 text-[11.5px] text-warn">
        ⚠ envelope schema invalid — see Layer 7 (Prompt + Response receipts)
        for the raw LLM output.
      </div>
    );
  }

  const decisive = run.llmParsed.evidence.filter((e) => e.decisive);
  const decision = run.finalDecision.decision;
  const verdictStroke = STROKE_BY_DECISION[decision];
  const containerRef = useRef<HTMLDivElement>(null);
  const ruleRef = useRef<HTMLDivElement>(null);
  const verdictRef = useRef<HTMLDivElement>(null);
  const evidenceRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [paths, setPaths] = useState<ChainPath[]>([]);
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 });
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const setEvidenceRef = useCallback(
    (idx: number) => (el: HTMLDivElement | null) => {
      if (el) evidenceRefs.current.set(idx, el);
      else evidenceRefs.current.delete(idx);
    },
    [],
  );

  // Toggle: collapse if open, open if closed.
  const toggleExpanded = useCallback((idx: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }, []);

  const recompute = useCallback(() => {
    const container = containerRef.current;
    const rule = ruleRef.current;
    const verdict = verdictRef.current;
    if (!container || !rule || !verdict) return;
    const cRect = container.getBoundingClientRect();
    setSvgSize({ w: cRect.width, h: cRect.height });

    const evidenceNodes: Array<{ idx: number; el: HTMLDivElement }> = [];
    for (const [idx, el] of evidenceRefs.current) {
      evidenceNodes.push({ idx, el });
    }
    evidenceNodes.sort((a, b) => a.idx - b.idx);

    const toPoint = (el: HTMLElement, side: "right" | "left") => {
      const r = el.getBoundingClientRect();
      return {
        x: (side === "right" ? r.right : r.left) - cRect.left,
        y: r.top - cRect.top + r.height / 2,
      };
    };

    const newPaths: ChainPath[] = [];

    // Path: Rule → first evidence (or Rule → Verdict if no decisive evidence)
    if (evidenceNodes.length === 0) {
      const a = toPoint(rule, "right");
      const b = toPoint(verdict, "left");
      newPaths.push({
        d: bezier(a, b),
        stroke: "var(--c-ink-4)",
        dashed: true,
      });
    } else {
      let prevPoint = toPoint(rule, "right");
      for (let i = 0; i < evidenceNodes.length; i++) {
        const node = evidenceNodes[i];
        if (!node) continue;
        const target = toPoint(node.el, "left");
        newPaths.push({
          d: bezier(prevPoint, target),
          stroke: verdictStroke,
          dashed: false,
        });
        prevPoint = toPoint(node.el, "right");
      }
      // Last evidence → Verdict
      const last = toPoint(verdict, "left");
      newPaths.push({
        d: bezier(prevPoint, last),
        stroke: verdictStroke,
        dashed: false,
      });
    }

    setPaths(newPaths);
  }, [verdictStroke]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute, expanded.size, decisive.length]);

  // ResizeObserver — rAF-coalesced
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let rafId: number | null = null;
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        recompute();
      });
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(container);
    if (ruleRef.current) ro.observe(ruleRef.current);
    if (verdictRef.current) ro.observe(verdictRef.current);
    for (const el of evidenceRefs.current.values()) {
      ro.observe(el);
    }
    window.addEventListener("resize", schedule);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [recompute, expanded.size, decisive.length]);

  const traceEntries = run.ontologyApiTrace;
  const allInstances = run.fetched.instances;
  const rule = run.fetched.rule;

  const stepLabel = useMemo(
    () => (rule.stepOrder ? `Step ${rule.stepOrder}` : ""),
    [rule.stepOrder],
  );

  return (
    <div
      ref={containerRef}
      className="relative w-full overflow-x-auto"
      style={{ minHeight: 180 }}
    >
      <svg
        className="absolute inset-0 pointer-events-none"
        width={svgSize.w}
        height={svgSize.h}
        viewBox={`0 0 ${svgSize.w || 1} ${svgSize.h || 1}`}
        preserveAspectRatio="none"
      >
        <defs>
          <marker
            id="chain-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
          </marker>
        </defs>
        {paths.map((p, i) => (
          <path
            key={i}
            d={p.d}
            fill="none"
            stroke={p.stroke}
            strokeWidth={2}
            strokeDasharray={p.dashed ? "4 4" : undefined}
            markerEnd="url(#chain-arrow)"
            style={{ color: p.stroke }}
          />
        ))}
      </svg>

      <div className="relative z-[1] flex flex-wrap items-start gap-12 p-4">
        {/* Rule node (leftmost, fixed) */}
        <div
          ref={ruleRef}
          className="rounded-lg border border-line bg-panel p-3 flex flex-col gap-1 shrink-0"
          style={{ width: 140 }}
        >
          <div className="text-[10px] uppercase tracking-wide text-ink-3">
            Rule
          </div>
          <div className="font-mono text-[12px] text-ink-1">{rule.id}</div>
          <div className="text-[10.5px] text-ink-2 line-clamp-2">
            {rule.name}
          </div>
          {stepLabel && (
            <div className="text-[10px] text-ink-3 mt-1">{stepLabel}</div>
          )}
        </div>

        {/* Evidence nodes */}
        {decisive.length === 0 && (
          <div
            className="rounded-md border border-dashed border-ink-4 px-3 py-2 text-[11px] text-ink-3 shrink-0"
            style={{ width: 200 }}
          >
            ⊘ no decisive evidence
          </div>
        )}
        {decisive.map((ev) => {
          // `ev` was filtered from full evidence[]; preserve original index so
          // arrow ordering matches narrative order.
          const idxInFull = run.llmParsed!.evidence.indexOf(ev);
          return (
            <div
              key={idxInFull}
              id={`chain-evidence-${idxInFull}`}
              ref={setEvidenceRef(idxInFull)}
              className="shrink-0 transition-shadow"
            >
              <FactCard
                evidence={ev}
                instance={allInstances[ev.fetchedInstanceIndex]}
                rule={rule}
                traceEntries={traceEntries}
                allInstances={allInstances}
                expanded={expanded.has(idxInFull)}
                onToggle={() => toggleExpanded(idxInFull)}
              />
            </div>
          );
        })}

        {/* Verdict node (rightmost, fixed) */}
        <div
          ref={verdictRef}
          className="rounded-lg border bg-surface p-3 flex flex-col items-center gap-2 shrink-0"
          style={{
            width: 160,
            borderColor: `color-mix(in oklab, ${verdictStroke} 30%, transparent)`,
          }}
        >
          <div className="text-[10px] uppercase tracking-wide text-ink-3">
            Verdict
          </div>
          <DecisionBadge value={decision} size="md" />
          <div className="text-[10.5px] text-ink-3">
            {(run.llmParsed!.confidence * 100).toFixed(0)}% conf
          </div>
          {run.llmParsed!.nextAction && (
            <div className="text-[10px] text-ink-3 text-center line-clamp-2">
              {run.llmParsed!.nextAction}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Cubic Bezier from point a (right-edge) to b (left-edge), control points
// at midpoint X — mirrors WorkflowContent.tsx's edge math.
function bezier(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const mid = (a.x + b.x) / 2;
  return `M ${a.x} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${b.x} ${b.y}`;
}
