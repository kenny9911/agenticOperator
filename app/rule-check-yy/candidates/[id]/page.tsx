"use client";
import React from "react";
import { Shell } from "@/components/shared/Shell";
import { CandidateTimelineContent } from "@/components/rule-check-yy/CandidateTimelineContent";
import { useApp } from "@/lib/i18n";

export default function CandidateTimelinePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { t } = useApp();
  const { id } = React.use(params);
  return (
    <Shell
      crumbs={[
        t("nav_group_trust_yy"),
        t("nav_rule_check_yy"),
        t("rc_yy_candidates"),
        id,
      ]}
      directionTag={t("rc_yy_candidates")}
    >
      <CandidateTimelineContent candidateId={id} />
    </Shell>
  );
}
