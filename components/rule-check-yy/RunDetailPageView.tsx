"use client";
/**
 * Client wrapper for `/rule-check-yy/runs/[runId]`. Renders Shell + breadcrumbs
 * (which need useApp's `t()` hook) around the fetched run. The parent page
 * is a server component that handles data fetching + dev MOCK fallback.
 */

import Link from "next/link";
import { Shell } from "@/components/shared/Shell";
import { Card } from "@/components/shared/atoms";
import { useApp } from "@/lib/i18n";
import { RunDetailContent } from "./RunDetailContent";
import type { RuleCheckRunAudited } from "@/lib/rule-check-yy";

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
        t("nav_group_trust_yy"),
        t("nav_rule_check_yy"),
        t("rc_yy_runs"),
        runId.slice(0, 8),
      ]}
      directionTag={t("rc_yy_run_detail")}
    >
      {run ? (
        <RunDetailContent run={run} />
      ) : (
        <div className="p-6">
          <Card>
            <div className="p-6 text-center text-ink-3">
              Run {runId.slice(0, 8)} not found.
              <Link href="/rule-check-yy/runs" className="ml-2 text-accent hover:underline">
                ← back to list
              </Link>
            </div>
          </Card>
        </div>
      )}
    </Shell>
  );
}
