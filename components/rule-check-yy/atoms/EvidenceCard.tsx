"use client";
/**
 * Evidence card — Layer 3 of the Prove page.
 *
 * Renders one piece of evidence with provenance: objectType/objectId,
 * field (JSONPath-lite), value (byte-equal display), `decisive` and
 * `grounded` flags, and a "View source" affordance that opens the raw
 * fetched instance JSON in a drawer.
 */
import React from "react";
import { Badge } from "@/components/shared/atoms";
import { useApp } from "@/lib/i18n";
import type { EvidenceAudited, Instance } from "@/lib/rule-check";

export interface EvidenceCardProps {
  evidence: EvidenceAudited;
  sourceInstance?: Instance;
  onViewSource?: (instance: Instance) => void;
}

export function EvidenceCard({
  evidence,
  sourceInstance,
  onViewSource,
}: EvidenceCardProps) {
  const { t } = useApp();
  const grounded = evidence.grounded;
  const decisive = evidence.decisive;
  const valueStr = formatValue(evidence.value);

  return (
    <div
      className="rounded-lg border bg-surface p-3 shadow-sh-1 flex flex-col gap-2"
      style={{
        borderColor:
          grounded === false
            ? "color-mix(in oklab, var(--c-err) 40%, transparent)"
            : "var(--c-line)",
      }}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] text-ink-2">
          {evidence.objectType}
          <span className="text-ink-4">/</span>
          {evidence.objectId}
        </span>
        {decisive && <Badge variant="info">decisive</Badge>}
        {grounded === false && <Badge variant="err">not grounded</Badge>}
        {grounded === true && <Badge variant="ok">grounded</Badge>}
      </div>
      <div className="text-[11px] text-ink-3">
        field: <span className="font-mono text-ink-2">{evidence.field}</span>
      </div>
      <div className="rounded bg-bg p-2 font-mono text-[12px] text-ink-1 break-all">
        {valueStr}
      </div>
      {sourceInstance && (
        <button
          type="button"
          className="self-start text-[11px] text-accent hover:underline"
          onClick={() => onViewSource?.(sourceInstance)}
        >
          {t("rc_view_source")} →
        </button>
      )}
    </div>
  );
}

function formatValue(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, null, 2);
}
