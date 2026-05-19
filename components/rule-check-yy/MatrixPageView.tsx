"use client";
/**
 * Client wrapper for the /rule-check matrix landing — renders Shell (which
 * needs useApp's t() hook) around `MatrixContent`. The parent page is a
 * server component that fetches matrix cells + active rules.
 */

import { Shell } from "@/components/shared/Shell";
import { useApp } from "@/lib/i18n";
import { MatrixContent } from "./MatrixContent";
import type { MatrixCell } from "@/app/rule-check/actions";
import type { FetchedRuleClassified } from "@/lib/rule-check";

export interface MatrixPageViewProps {
  cells: MatrixCell[];
  rules: FetchedRuleClassified[];
  candidates: string[];
  scopeLabel: string;
}

export function MatrixPageView(props: MatrixPageViewProps) {
  const { t } = useApp();
  return (
    <Shell
      crumbs={[t("nav_group_trust"), t("nav_rule_check"), t("rc_matrix_title")]}
      directionTag={t("rc_matrix_title")}
    >
      <MatrixContent {...props} />
    </Shell>
  );
}
