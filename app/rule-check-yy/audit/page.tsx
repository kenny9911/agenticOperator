"use client";
import React from "react";
import { Shell } from "@/components/shared/Shell";
import { AuditContent } from "@/components/rule-check-yy/AuditContent";
import { useApp } from "@/lib/i18n";

export default function AuditPage() {
  const { t } = useApp();
  return (
    <Shell
      crumbs={[t("nav_group_trust_yy"), t("nav_rule_check_yy"), t("rc_yy_audit")]}
      directionTag={t("rc_yy_audit")}
    >
      <AuditContent />
    </Shell>
  );
}
