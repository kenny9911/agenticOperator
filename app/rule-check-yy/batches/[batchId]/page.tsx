import { getBatchSummary } from "@/lib/rule-check/server-actions";
import { BatchDetailPageView } from "@/components/rule-check/BatchDetailPageView";

export default async function BatchDetailPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  const { batchId } = await params;
  const res = await getBatchSummary(batchId);
  if (!res.ok) {
    return (
      <div className="p-6 text-[12px] text-err">
        <strong>error:</strong> {res.error}
      </div>
    );
  }
  return <BatchDetailPageView summary={res.summary} />;
}
