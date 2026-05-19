"use client";
/**
 * Client wrapper for `/rule-check/batches/[batchId]` — Shell + breadcrumbs.
 * Parent page is a server component that fetches the BatchSummary.
 */

import { Shell } from "@/components/shared/Shell";
import { useApp } from "@/lib/i18n";
import { BatchDetailContent } from "./BatchDetailContent";
import type { BatchSummary } from "@/app/rule-check/actions";

export interface BatchDetailPageViewProps {
  summary: BatchSummary;
}

export function BatchDetailPageView({ summary }: BatchDetailPageViewProps) {
  const { t } = useApp();
  const shortId = summary.batchId.slice(0, 12) + "…";
  return (
    <Shell
      crumbs={[t("nav_group_trust"), t("nav_rule_check"), shortId]}
      directionTag={t("rc_aggregate_title")}
    >
      <BatchDetailContent summary={summary} />
    </Shell>
  );
}
