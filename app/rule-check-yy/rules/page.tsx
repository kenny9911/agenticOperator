import { listActiveRules } from "@/lib/rule-check/server-actions";
import { RuleLibraryPageView } from "@/components/rule-check/RuleLibraryPageView";

const DEFAULT_SCOPE = {
  actionRef: "matchResume",
  client: "腾讯",
  domain: "RAAS-v1",
};

export default async function RuleLibraryPage({
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

  let rules: Awaited<ReturnType<typeof listActiveRules>> = [];
  try {
    rules = await listActiveRules({ actionRef, domain, client });
  } catch {
    // Ontology API unavailable → empty list; UI shows the no-match state.
    rules = [];
  }

  const scopeLabel = `${actionRef} · ${client} · ${domain}`;

  return <RuleLibraryPageView rules={rules} scopeLabel={scopeLabel} />;
}
