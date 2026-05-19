"use client";
/**
 * Client wrapper for /rule-check-yy/rules — Shell + breadcrumbs + content.
 * Parent page is a server component that fetches rules via listActiveRules.
 */

import { Shell } from "@/components/shared/Shell";
import { useApp } from "@/lib/i18n";
import { RuleLibraryContent } from "./RuleLibraryContent";
import type { FetchedRuleClassified } from "@/lib/rule-check-yy";

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
      crumbs={[t("nav_group_trust_yy"), t("nav_rule_check_yy"), t("rc_yy_rules")]}
      directionTag={t("rc_yy_rules")}
    >
      <RuleLibraryContent rules={rules} scopeLabel={scopeLabel} />
    </Shell>
  );
}
