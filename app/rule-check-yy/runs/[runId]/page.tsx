import { getRunDetail } from "@/lib/rule-check/server-actions";
import { RunDetailPageView } from "@/components/rule-check/RunDetailPageView";

export default async function RunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const result = await getRunDetail(runId);
  let run = result.ok ? result.run : null;

  // Dev-only fallback: if the run isn't on disk but is one of the hardcoded
  // demo fixtures, surface it so the UI can be exercised without seeded data.
  if (!run && process.env.NODE_ENV === "development") {
    const { MOCK_RUNS } = await import("@/components/rule-check/mock");
    run = MOCK_RUNS.find((r) => r.runId === runId) ?? null;
  }

  return <RunDetailPageView runId={runId} run={run} />;
}
