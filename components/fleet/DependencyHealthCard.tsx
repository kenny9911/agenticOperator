"use client";
import React from "react";
import { useApp } from "@/lib/i18n";
import { Card, CardHead, StatusDot, Badge, Btn } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import { friendlyDomainName } from "@/lib/domain-ids";
import type { DependencyHealthResponse, DependencyHealthRow } from "@/lib/dependency-health/contract";

// Dependency Health card — the at-a-glance operator view of whether a paid
// external dependency (RoboHire / AI gateway) is dead, and the AO-side verdict
// (没钱了 / 故障了 / 说不准). Mirrors the 消息通知 alert (shares its wire contract);
// polls the read API. A green "all healthy" state is intentional — it's the
// reassurance an on-call wants.

type Severity = DependencyHealthRow["severity"];

const DOT: Record<Severity, "ok" | "warn" | "err" | "info"> = {
  ok: "ok",
  info: "info",
  warn: "warn",
  critical: "err",
};
const BADGE: Record<Severity, "ok" | "info" | "warn" | "err"> = {
  ok: "ok",
  info: "info",
  warn: "warn",
  critical: "err",
};

function sinceLabel(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.max(1, Math.floor(diff / 60_000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export function DependencyHealthCard() {
  const { t } = useApp();
  const [data, setData] = React.useState<DependencyHealthResponse | null>(null);
  const [resetting, setResetting] = React.useState<string | null>(null);
  const aliveRef = React.useRef(true);

  const load = React.useCallback(() => {
    return fetch("/api/dependency-health")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (aliveRef.current && j) setData(j as DependencyHealthResponse);
      })
      .catch(() => {});
  }, []);

  React.useEffect(() => {
    aliveRef.current = true;
    load();
    const id = setInterval(load, 10_000);
    return () => {
      aliveRef.current = false;
      clearInterval(id);
    };
  }, [load]);

  const onReset = React.useCallback(
    async (provider: string) => {
      setResetting(provider);
      try {
        await fetch("/api/dependency-health/reset", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ provider }),
        });
        await load(); // reflect the cleared state immediately
      } catch {
        /* best-effort — the next poll will reconcile */
      } finally {
        if (aliveRef.current) setResetting(null);
      }
    },
    [load],
  );

  if (!data) return null;

  const anyUnhealthy = data.providers.some((p) => p.label !== "healthy");

  return (
    <Card>
      <CardHead>
        <span className="text-[12.5px] font-semibold text-ink-1">{t("dep_title")}</span>
        <span className="flex-1" />
        <span className="text-[11px] text-ink-3 tabular-nums">
          {t("dep_subtitle").replace("{min}", String(data.windowMinutes))}
        </span>
      </CardHead>
      <div className="divide-y divide-[color:var(--c-line)]">
        {data.providers.map((p) => (
          <ProviderLine key={p.provider} p={p} t={t} onReset={onReset} resetting={resetting === p.provider} />
        ))}
      </div>
      {(!anyUnhealthy || data.partial) && (
        <div className="px-4 py-2 text-[11px] text-ink-4 border-t border-line">
          {data.partial ? t("dep_partial") : t("dep_hint_healthy")}
        </div>
      )}
    </Card>
  );
}

function ProviderLine({
  p,
  t,
  onReset,
  resetting,
}: {
  p: DependencyHealthRow;
  t: (k: string) => string;
  onReset: (provider: string) => void;
  resetting: boolean;
}) {
  const name = t(`dep_provider_${p.provider}`);
  const labelText = t(`dep_label_${p.label}`);
  const hint = t(`dep_hint_${p.label}`);
  const ops = p.affectedOps.map((op) => t(`dep_op_${op}`) || op).join("、");
  const domains = p.affectedDomains.map(friendlyDomainName).join("、");
  const unhealthy = p.label !== "healthy";

  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <div className="pt-0.5">
        <StatusDot kind={DOT[p.severity]} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-medium text-ink-1">{name}</span>
          <Badge variant={BADGE[p.severity]} dot={p.severity === "critical"} pulse={p.severity === "critical"}>
            {labelText}
          </Badge>
          {p.failureCount > 0 && (
            <span className="text-[11px] text-ink-3 tabular-nums">
              {t("dep_failures_n").replace("{n}", String(p.failureCount))}
              {p.sinceTs ? ` · ${sinceLabel(p.sinceTs)}` : ""}
            </span>
          )}
        </div>
        <div className="text-[11.5px] text-ink-3 mt-0.5">{hint}</div>
        {ops && (
          <div className="text-[11px] text-ink-4 mt-0.5">
            {t("dep_affected")}: {ops}
            {domains ? ` · ${domains}` : ""}
          </div>
        )}
        {p.lastFailureTs && (
          <div className="text-[11px] text-ink-4 mt-0.5">
            {t("dep_last_fail").replace("{ago}", sinceLabel(p.lastFailureTs))}
          </div>
        )}
      </div>
      <div className="shrink-0 flex flex-col items-end gap-1.5 pt-0.5">
        {p.notificationId && (
          <a
            href="/notifications"
            className="inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline"
          >
            <Ic.bell style={{ width: 12, height: 12 }} />
            {t("dep_view_alert")}
          </a>
        )}
        {unhealthy && (
          <Btn
            size="sm"
            onClick={() => onReset(p.provider)}
            disabled={resetting}
            title={t("dep_reset_hint")}
          >
            {resetting ? t("dep_resetting") : t("dep_reset")}
          </Btn>
        )}
      </div>
    </div>
  );
}
