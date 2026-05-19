"use client";
import React from "react";
import { Shell } from "@/components/shared/Shell";
import { SettingsContent } from "@/components/rule-check/SettingsContent";
import { useApp } from "@/lib/i18n";

export default function SettingsPage() {
  const { t } = useApp();
  return (
    <Shell
      crumbs={[t("nav_group_trust"), t("nav_rule_check"), t("rc_settings")]}
      directionTag={t("rc_settings")}
    >
      <SettingsContent />
    </Shell>
  );
}
