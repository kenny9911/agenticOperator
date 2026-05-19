"use client";
/**
 * Client wrapper for `/rule-check-yy/batches/[batchId]` — Shell + breadcrumbs.
 * Parent page is a server component that fetches the BatchSummary.
 */

import { Shell } from "@/components/shared/Shell";
import { useApp } from "@/lib/i18n";
import { BatchDetailContent } from "./BatchDetailContent";
import type { BatchSummary } from "@/app/rule-check-yy/actions";

export interface BatchDetailPageViewProps {
  summary: BatchSummary;
}

export function BatchDetailPageView({ summary }: BatchDetailPageViewProps) {
  const { t } = useApp();
  const shortId = summary.batchId.slice(0, 12) + "…";
  return (
    <Shell
      crumbs={[t("nav_group_trust_yy"), t("nav_rule_check_yy"), shortId]}
      directionTag={t("rc_yy_aggregate_title")}
    >
      <BatchDetailContent summary={summary} />
    </Shell>
  );
}
