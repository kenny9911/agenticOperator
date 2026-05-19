import { listAggregateBatches } from "@/lib/rule-check/server-actions";
import { AggregatePageView } from "@/components/rule-check/AggregatePageView";

export default async function RuleCheckLandingPage({
  searchParams,
}: {
  searchParams?: Promise<{
    actionRef?: string;
    client?: string;
    candidateId?: string;
    fromDate?: string;
    toDate?: string;
  }>;
}) {
  const params = (await searchParams) ?? {};
  const { rows, aggregate } = await listAggregateBatches({
    actionRef: params.actionRef,
    client: params.client,
    candidateId: params.candidateId,
    fromDate: params.fromDate,
    toDate: params.toDate,
    limit: 200,
  });

  const scopeBits: string[] = [];
  if (params.actionRef) scopeBits.push(params.actionRef);
  if (params.client) scopeBits.push(params.client);
  if (params.candidateId) scopeBits.push(`cand=${params.candidateId}`);
  const scopeLabel = scopeBits.length > 0 ? scopeBits.join(" · ") : "all runs";

  return (
    <AggregatePageView rows={rows} aggregate={aggregate} scopeLabel={scopeLabel} />
  );
}
