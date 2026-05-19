"use client";
/**
 * Client wrapper for /rule-check/rules — Shell + breadcrumbs + content.
 * Parent page is a server component that fetches rules via listActiveRules.
 */

import { Shell } from "@/components/shared/Shell";
import { useApp } from "@/lib/i18n";
import { RuleLibraryContent } from "./RuleLibraryContent";
import type { FetchedRuleClassified } from "@/lib/rule-check";

export interface RuleLibraryPageViewProps {
  rules: FetchedRuleClassified[];
  scopeLabel: string;
}

export function RuleLibraryPageView({
  rules,
  scopeLabel,
}: RuleLibraryPageViewProps) {
  const { t } = useApp();
  return (
    <Shell
      crumbs={[t("nav_group_trust"), t("nav_rule_check"), t("rc_rules")]}
      directionTag={t("rc_rules")}
    >
      <RuleLibraryContent rules={rules} scopeLabel={scopeLabel} />
    </Shell>
  );
}
