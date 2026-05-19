"use client";
/**
 * /rule-check/audit — compliance + analytics page.
 *
 * Stub: report builder + recent-export list. Real export endpoint TBD.
 */
import React, { useState } from "react";
import { Card, CardHead, Btn } from "@/components/shared/atoms";
import { useApp } from "@/lib/i18n";

export function AuditContent() {
  const { t } = useApp();
  const [from, setFrom] = useState("2026-04-01");
  const [to, setTo] = useState("2026-05-12");
  const [client, setClient] = useState("腾讯");
  const [decision, setDecision] = useState<"all" | "blocked" | "pending_human">("blocked");

  return (
    <div className="flex flex-col gap-4 p-6">
      <header>
        <h1 className="text-xl font-semibold text-ink-1">{t("rc_audit")}</h1>
        <p className="mt-1 text-xs text-ink-3">
          Compliance reports + cross-run analytics. Exports run against the
          out-of-Ontology audit store.
        </p>
      </header>

      <Card>
        <CardHead>
          <span className="text-[12.5px] font-medium text-ink-1">Report builder</span>
        </CardHead>
        <div className="p-4 grid grid-cols-2 gap-3 max-w-2xl">
          <Field label="from">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="input"
            />
          </Field>
          <Field label="to">
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="input"
            />
          </Field>
          <Field label={t("rc_client")}>
            <input
              value={client}
              onChange={(e) => setClient(e.target.value)}
              className="input"
            />
          </Field>
          <Field label={t("rc_filter_status")}>
            <select
              value={decision}
              onChange={(e) => setDecision(e.target.value as typeof decision)}
              className="input"
            >
              <option value="all">all</option>
              <option value="blocked">{t("rc_blocked")}</option>
              <option value="pending_human">{t("rc_pending_human")}</option>
            </select>
          </Field>
          <div className="col-span-2 flex items-center gap-2">
            <Btn variant="primary">Export PDF</Btn>
            <Btn variant="default">Export XLSX</Btn>
            <Btn variant="ghost">Export signed JSON bundle</Btn>
          </div>
        </div>
      </Card>

      <Card>
        <CardHead>
          <span className="text-[12.5px] font-medium text-ink-1">Recent exports</span>
        </CardHead>
        <div className="p-3 text-[12px] text-ink-3">
          (no exports yet — UI-5 wires this to the audit store)
        </div>
      </Card>
      <style jsx>{`
        .input {
          font-family: inherit;
          font-size: 12px;
          padding: 6px 8px;
          border-radius: 4px;
          border: 1px solid var(--c-line);
          background: var(--c-bg);
          color: var(--c-ink-1);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-ink-3">
      <span>{label}</span>
      {children}
    </label>
  );
}
