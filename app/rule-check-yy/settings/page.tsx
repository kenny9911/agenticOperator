"use client";
import React from "react";
import { Shell } from "@/components/shared/Shell";
import { SettingsContent } from "@/components/rule-check-yy/SettingsContent";
import { useApp } from "@/lib/i18n";

export default function SettingsPage() {
  const { t } = useApp();
  return (
    <Shell
      crumbs={[t("nav_group_trust_yy"), t("nav_rule_check_yy"), t("rc_yy_settings")]}
      directionTag={t("rc_yy_settings")}
    >
      <SettingsContent />
    </Shell>
  );
}
