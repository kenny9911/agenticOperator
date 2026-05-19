"use client";
/**
 * /rule-check/settings — operator self-service.
 *
 * Stub: defaults, thresholds, retention. Persistence wired in UI-5.
 */
import React, { useState } from "react";
import { Card, CardHead, Btn } from "@/components/shared/atoms";
import { useApp } from "@/lib/i18n";

export function SettingsContent() {
  const { t } = useApp();
  const [model, setModel] = useState("gpt-4o");
  const [confThreshold, setConfThreshold] = useState(0.5);
  const [timeout, setTimeout_] = useState(8000);
  const [retention, setRetention] = useState(90);

  return (
    <div className="flex flex-col gap-4 p-6 max-w-2xl">
      <header>
        <h1 className="text-xl font-semibold text-ink-1">{t("rc_settings")}</h1>
        <p className="mt-1 text-xs text-ink-3">Operator-level defaults (not yet persisted).</p>
      </header>

      <Card>
        <CardHead>
          <span className="text-[12.5px] font-medium text-ink-1">Model defaults</span>
        </CardHead>
        <div className="p-4 flex flex-col gap-3">
          <Row label="LLM model">
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="input"
            />
          </Row>
          <Row label="LLM timeout (ms)">
            <input
              type="number"
              value={timeout}
              onChange={(e) => setTimeout_(parseInt(e.target.value, 10))}
              className="input"
            />
          </Row>
        </div>
      </Card>

      <Card>
        <CardHead>
          <span className="text-[12.5px] font-medium text-ink-1">Confidence threshold</span>
        </CardHead>
        <div className="p-4 flex flex-col gap-2">
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={confThreshold}
            onChange={(e) => setConfThreshold(parseFloat(e.target.value))}
          />
          <div className="text-[12px] text-ink-2">
            Flag runs with confidence below{" "}
            <span className="font-mono">{(confThreshold * 100).toFixed(0)}%</span>
          </div>
        </div>
      </Card>

      <Card>
        <CardHead>
          <span className="text-[12.5px] font-medium text-ink-1">Audit retention</span>
        </CardHead>
        <div className="p-4">
          <Row label="Days to retain audit JSON">
            <input
              type="number"
              value={retention}
              onChange={(e) => setRetention(parseInt(e.target.value, 10))}
              className="input"
            />
          </Row>
        </div>
      </Card>

      <div className="flex items-center gap-2">
        <Btn variant="primary">Save</Btn>
        <Btn variant="ghost">Reset to defaults</Btn>
      </div>

      <style jsx>{`
        .input {
          font-family: inherit;
          font-size: 12px;
          padding: 6px 8px;
          border-radius: 4px;
          border: 1px solid var(--c-line);
          background: var(--c-bg);
          color: var(--c-ink-1);
          width: 100%;
        }
      `}</style>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-ink-3">
      <span>{label}</span>
      {children}
    </label>
  );
}
