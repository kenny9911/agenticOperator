"use client";
/**
 * Client wrapper for the Runs aggregate page. Renders Shell + breadcrumbs
 * (which need useApp) around AggregateContent. Parent page is a server
 * component that fetches data.
 */

import { Shell } from "@/components/shared/Shell";
import { useApp } from "@/lib/i18n";
import { AggregateContent } from "./AggregateContent";
import type { BatchRow, BatchAggregateMetrics } from "@/app/rule-check/actions";

export interface AggregatePageViewProps {
  rows: BatchRow[];
  aggregate: BatchAggregateMetrics;
  scopeLabel: string;
}

export function AggregatePageView(props: AggregatePageViewProps) {
  const { t } = useApp();
  return (
    <Shell
      crumbs={[t("nav_group_trust"), t("nav_rule_check")]}
      directionTag={t("rc_aggregate_title")}
    >
      <AggregateContent {...props} />
    </Shell>
  );
}
