import {
  listMatrixCells,
  listActiveRules,
} from "@/lib/rule-check/server-actions";
import { MatrixPageView } from "@/components/rule-check/MatrixPageView";

const DEFAULT_SCOPE = {
  actionRef: "matchResume",
  client: "腾讯",
  domain: "RAAS-v1",
};

export default async function RuleCheckMatrixPage({
  searchParams,
}: {
  searchParams?: Promise<{
    actionRef?: string;
    client?: string;
    domain?: string;
  }>;
}) {
  const params = (await searchParams) ?? {};
  const actionRef = params.actionRef || DEFAULT_SCOPE.actionRef;
  const client = params.client || DEFAULT_SCOPE.client;
  const domain = params.domain || DEFAULT_SCOPE.domain;

  let cells = await listMatrixCells({ actionRef, client });
  let rules: Awaited<ReturnType<typeof listActiveRules>> = [];

  try {
    rules = await listActiveRules({ actionRef, domain, client });
  } catch {
    // Ontology API may be unavailable in some environments — degrade
    // gracefully: derive rules from the cells themselves.
    const ruleSeen = new Map<string, { id: string; stepOrder: number }>();
    for (const c of cells) {
      if (!ruleSeen.has(c.ruleId)) {
        ruleSeen.set(c.ruleId, { id: c.ruleId, stepOrder: 0 });
      }
    }
    rules = Array.from(ruleSeen.values()).map((r) => ({
      id: r.id,
      name: r.id,
      sourceText: "",
      stepOrder: r.stepOrder,
      applicableScope: client,
    }));
  }

  // Distinct candidates from cells, sorted alphabetically.
  const candidates = Array.from(
    new Set(cells.map((c) => c.candidateId)),
  ).sort();

  const scopeLabel = `${actionRef} · ${client} · ${domain}`;

  return (
    <MatrixPageView
      cells={cells}
      rules={rules}
      candidates={candidates}
      scopeLabel={scopeLabel}
    />
  );
}
