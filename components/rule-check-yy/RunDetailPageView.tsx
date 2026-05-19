"use client";
/**
 * Client wrapper for `/rule-check/runs/[runId]`. Renders Shell + breadcrumbs
 * (which need useApp's `t()` hook) around the fetched run. The parent page
 * is a server component that handles data fetching + dev MOCK fallback.
 */

import Link from "next/link";
import { Shell } from "@/components/shared/Shell";
import { Card } from "@/components/shared/atoms";
import { useApp } from "@/lib/i18n";
import { RunDetailContent } from "./RunDetailContent";
import type { RuleCheckRunAudited } from "@/lib/rule-check";

export function RunDetailPageView({
  runId,
  run,
}: {
  runId: string;
  run: RuleCheckRunAudited | null;
}) {
  const { t } = useApp();
  return (
    <Shell
      crumbs={[
        t("nav_group_trust"),
        t("nav_rule_check"),
        t("rc_runs"),
        runId.slice(0, 8),
      ]}
      directionTag={t("rc_run_detail")}
    >
      {run ? (
        <RunDetailContent run={run} />
      ) : (
        <div className="p-6">
          <Card>
            <div className="p-6 text-center text-ink-3">
              Run {runId.slice(0, 8)} not found.
              <Link href="/rule-check/runs" className="ml-2 text-accent hover:underline">
                ← back to list
              </Link>
            </div>
          </Card>
        </div>
      )}
    </Shell>
  );
}
