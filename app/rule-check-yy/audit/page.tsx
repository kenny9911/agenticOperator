"use client";
import React from "react";
import { Shell } from "@/components/shared/Shell";
import { AuditContent } from "@/components/rule-check/AuditContent";
import { useApp } from "@/lib/i18n";

export default function AuditPage() {
  const { t } = useApp();
  return (
    <Shell
      crumbs={[t("nav_group_trust"), t("nav_rule_check"), t("rc_audit")]}
      directionTag={t("rc_audit")}
    >
      <AuditContent />
    </Shell>
  );
}
