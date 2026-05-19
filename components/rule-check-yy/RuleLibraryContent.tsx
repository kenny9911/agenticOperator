"use client";
/**
 * /rule-check/rules — Static rule dictionary (SPEC §9.2 + §15 locked
 * 2026-05-13).
 *
 * Pure reference catalog. No run aggregation, no firing-rate, no recent
 * runs, no "where this rule fired" — those patterns aggregate by rule
 * globally and violate the "run is the smallest unit" rule from §15.
 *
 * Each card shows: rule id / name / sourceText (truncated, click to expand)
 * + Step <stepOrder> chip + canBlock badge (when present).
 *
 * Filter chips by stepOrder + free-text search by id/name.
 */

import { useMemo, useState } from "react";
import { Badge, Btn, Card, CardHead } from "@/components/shared/atoms";
import { useApp } from "@/lib/i18n";
import type { FetchedRuleClassified } from "@/lib/rule-check";

export interface RuleLibraryContentProps {
  rules: FetchedRuleClassified[];
  scopeLabel: string;
}

export function RuleLibraryContent({
  rules,
  scopeLabel,
}: RuleLibraryContentProps) {
  const { t } = useApp();
  const [stepFilter, setStepFilter] = useState<number | "all">("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const stepOrders = useMemo(() => {
    const set = new Set<number>();
    for (const r of rules) set.add(r.stepOrder);
    return Array.from(set).sort((a, b) => a - b);
  }, [rules]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rules.filter((r) => {
      if (stepFilter !== "all" && r.stepOrder !== stepFilter) return false;
      if (!q) return true;
      return (
        r.id.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q)
      );
    });
  }, [rules, stepFilter, query]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full min-h-0 gap-4 p-6">
      <header className="flex items-end justify-between flex-shrink-0">
        <div>
          <h1 className="text-xl font-semibold text-ink-1">{t("rc_rules")}</h1>
          <p className="mt-1 text-[12px] text-ink-3">
            {scopeLabel} · {rules.length} rules
          </p>
        </div>
      </header>

      <div className="flex items-center gap-3 flex-wrap flex-shrink-0">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="filter by id or name…"
          className="rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] text-ink-1 min-w-[260px]"
        />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setStepFilter("all")}
            className={`rounded-md border px-2.5 py-1 text-[11px] ${
              stepFilter === "all"
                ? "border-accent bg-accent text-white"
                : "border-line bg-surface text-ink-2 hover:bg-panel"
            }`}
          >
            all
          </button>
          {stepOrders.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStepFilter(s)}
              className={`rounded-md border px-2.5 py-1 text-[11px] ${
                stepFilter === s
                  ? "border-accent bg-accent text-white"
                  : "border-line bg-surface text-ink-2 hover:bg-panel"
              }`}
            >
              Step {s}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line bg-surface p-8 text-center text-[12px] text-ink-3">
            No rules match the current filter.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {filtered.map((rule) => {
              const isOpen = expanded.has(rule.id);
              return (
                <Card key={rule.id}>
                  <CardHead>
                    <span className="font-mono text-[12px] text-ink-1">{rule.id}</span>
                    <Badge>Step {rule.stepOrder}</Badge>
                    {rule.canBlock === true && (
                      <Badge variant="err">canBlock</Badge>
                    )}
                    <Badge variant="info" className="ml-auto">
                      {rule.applicableScope}
                    </Badge>
                  </CardHead>
                  <div className="p-3 flex flex-col gap-2">
                    <div className="text-[13px] font-medium text-ink-1">{rule.name}</div>
                    <div
                      className={`text-[12px] text-ink-2 leading-relaxed whitespace-pre-wrap ${
                        isOpen ? "" : "line-clamp-3"
                      }`}
                    >
                      {rule.sourceText || (
                        <span className="text-ink-4 italic">(no source text)</span>
                      )}
                    </div>
                    {rule.sourceText && rule.sourceText.length > 200 && (
                      <Btn
                        variant="ghost"
                        size="sm"
                        onClick={() => toggle(rule.id)}
                      >
                        {isOpen ? "▴ collapse" : "▾ expand"}
                      </Btn>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
