"use client";
/**
 * Replay button (Layer 1, top-right).
 *
 * Re-runs the current case as a NEW independent runId per SPEC §14.2.
 * Old run's audit JSON is untouched on disk. On success, navigates to the
 * new runId page. On failure, renders an inline error badge.
 *
 * Pending state shows elapsed time via the shared `formatElapsed` helper.
 * mounted-ref guard prevents `router.push` after unmount.
 */

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Btn } from "@/components/shared/atoms";
import { replayRun } from "@/app/rule-check/actions";
import { formatElapsed } from "./formatElapsed";
import { useApp } from "@/lib/i18n";

export interface ReplayButtonProps {
  runId: string;
}

export function ReplayButton({ runId }: ReplayButtonProps) {
  const router = useRouter();
  const { t } = useApp();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Tick elapsed timer while transition is pending.
  useEffect(() => {
    if (!isPending) return;
    setElapsedMs(0);
    const startedAt = Date.now();
    const id = setInterval(() => {
      if (mountedRef.current) setElapsedMs(Date.now() - startedAt);
    }, 250);
    return () => clearInterval(id);
  }, [isPending]);

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const res = await replayRun(runId);
      if (!mountedRef.current) return;
      if (res.ok) {
        router.push(`/rule-check/runs/${res.newRunId}`);
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div className="flex flex-col gap-1 items-end">
      <Btn
        variant="accent"
        size="sm"
        onClick={handleClick}
        disabled={isPending}
      >
        {isPending
          ? `⟳ ${t("rc_replay_running")} ${formatElapsed(elapsedMs)}`
          : `↻ ${t("rc_replay")}`}
      </Btn>
      {error && (
        <Badge variant="err">
          {t("rc_replay_failed")}: {error}
        </Badge>
      )}
    </div>
  );
}
