"use client";

import React from "react";
import { Badge, Btn } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import {
  DomainInngestAppManager,
  MainInngestAppRegistration,
} from "@/components/shared/InngestAppRegistrationControls";
import { ProcessControlPanel } from "@/components/settings/ProcessControlPanel";
import { fetchJson } from "@/lib/api/client";
import { useApp } from "@/lib/i18n";
import type { SystemEnvConfigResponse, SystemEnvConfigUpdateResponse } from "@/app/api/system/env-config/route";
import type { SystemConfigResponse } from "@/app/api/system/config/route";
import type { RuntimeConfigFieldState, RuntimeConfigSaveTarget } from "@/server/ops/runtime-config";

type SaveMessage = { kind: "ok" | "warn" | "err"; text: string } | null;
type LoadOptions = { silent?: boolean; preserveDraft?: boolean; preserveMessage?: boolean };

export function EnvironmentConfigContent() {
  const { t } = useApp();
  const [data, setData] = React.useState<SystemEnvConfigResponse | null>(null);
  const [systemCfg, setSystemCfg] = React.useState<SystemConfigResponse | null>(null);
  const [draft, setDraft] = React.useState<Record<string, string>>({});
  const [saveTarget, setSaveTarget] = React.useState<RuntimeConfigSaveTarget>("env_local");
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<SaveMessage>(null);
  const dirtyRef = React.useRef(false);
  const savingRef = React.useRef(false);
  const busyActionRef = React.useRef<string | null>(null);

  const fields = data?.runtimeConfig.fields ?? [];

  const load = React.useCallback(async (options: LoadOptions = {}) => {
    if (!options.silent) setLoading(true);
    if (!options.preserveMessage) setMessage(null);
    try {
      const [next, system] = await Promise.all([
        fetchJson<SystemEnvConfigResponse>("/api/system/env-config", { cache: "no-store", timeoutMs: 12_000 }),
        fetchJson<SystemConfigResponse>("/api/system/config", { cache: "no-store", timeoutMs: 12_000 }),
      ]);
      setData(next);
      setSystemCfg(system);
      if (!options.preserveDraft || !dirtyRef.current) {
        setDraft(draftFromFields(next.runtimeConfig.fields));
      }
    } catch (e) {
      if (!options.silent) {
        setMessage({ kind: "err", text: (e as Error).message || t("settings_env_load_failed") });
      }
    } finally {
      if (!options.silent) setLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const dirtyKeys = React.useMemo(() => dirtyFieldKeys(fields, draft), [fields, draft]);
  const groups = React.useMemo(() => groupFields(fields), [fields]);

  React.useEffect(() => {
    dirtyRef.current = dirtyKeys.length > 0;
  }, [dirtyKeys.length]);

  React.useEffect(() => {
    savingRef.current = saving;
  }, [saving]);

  React.useEffect(() => {
    busyActionRef.current = busyAction;
  }, [busyAction]);

  React.useEffect(() => {
    const refreshFromFiles = () => {
      if (dirtyRef.current || savingRef.current || busyActionRef.current) return;
      void load({ silent: true, preserveDraft: true, preserveMessage: true });
    };
    const id = window.setInterval(refreshFromFiles, 8_000);
    window.addEventListener("focus", refreshFromFiles);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", refreshFromFiles);
    };
  }, [load]);

  const save = async () => {
    if (!data || dirtyKeys.length === 0) return;
    setSaving(true);
    setMessage(null);
    try {
      const values: Record<string, string> = {};
      for (const field of fields) {
        if (!dirtyKeys.includes(field.key)) continue;
        values[field.key] = draft[field.key] ?? "";
      }
      const res = await fetch("/api/system/env-config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values, target: saveTarget }),
      });
      const body = (await res.json()) as SystemEnvConfigUpdateResponse;
      if (!res.ok || !body.ok) throw new Error((body as { error?: string }).error ?? "save failed");
      const system = await fetchJson<SystemConfigResponse>("/api/system/config", { cache: "no-store", timeoutMs: 12_000 });
      setData(body.config);
      setSystemCfg(system);
      setDraft(draftFromFields(body.config.runtimeConfig.fields));
      const baseMessage = body.target === "runtime"
        ? t("settings_env_save_runtime_success")
        : t("settings_env_save_env_success").replace("{file}", body.config.runtimeConfig.writableEnvFile);
      setMessage({
        kind: body.restartRequiredKeys.length > 0 ? "warn" : "ok",
        text: body.restartRequiredKeys.length > 0
          ? `${baseMessage}${t("settings_env_save_joiner")}${t("settings_env_save_restart_suffix")}`
          : baseMessage,
      });
    } catch (e) {
      setMessage({ kind: "err", text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const runInfraCheck = async () => {
    setBusyAction("check");
    setMessage(null);
    try {
      const res = await fetch("/api/infra/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check" }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? "check failed");
      const system = await fetchJson<SystemConfigResponse>("/api/system/config", { cache: "no-store", timeoutMs: 12_000 }).catch(() => null);
      setData((prev) => prev ? { ...prev, infra: body.snapshot, generatedAt: new Date().toISOString() } : prev);
      if (system) setSystemCfg(system);
      setMessage({
        kind: "ok",
        text: t("config_infra_check_result")
          .replace("{recorded}", String(body.recorded ?? 0))
          .replace("{resolved}", String(body.resolved ?? 0)),
      });
    } catch (e) {
      setMessage({ kind: "err", text: (e as Error).message });
    } finally {
      setBusyAction(null);
    }
  };

  const syncGraph = async () => {
    setBusyAction("neo4j");
    setMessage(null);
    try {
      const res = await fetch("/api/em/sync/event-definitions/run-now", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error(body.error ?? body.result?.error ?? "sync failed");
      await load();
      setMessage({ kind: "ok", text: t("monitor_infra_action_done") });
    } catch (e) {
      setMessage({ kind: "err", text: (e as Error).message });
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="flex-1 min-w-0 overflow-auto bg-bg">
      <header className="border-b border-line px-8 py-7">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="m-0 text-[26px] leading-tight font-semibold text-ink-1">{t("settings_env_title")}</h1>
            <p className="m-0 mt-1.5 max-w-[760px] text-[13px] leading-6 text-ink-3">
              {t("settings_env_subtitle")}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Btn onClick={load} disabled={loading} title={t("settings_env_reload")}>
              <Ic.clock />{loading ? "…" : t("settings_env_reload")}
            </Btn>
            <Btn onClick={runInfraCheck} disabled={busyAction !== null} title={t("config_run_infra_check")}>
              <Ic.gauge />{busyAction === "check" ? "…" : t("config_run_infra_check")}
            </Btn>
            <Btn onClick={save} disabled={saving || dirtyKeys.length === 0} variant="accent" title={t("config_save")}>
              <Ic.check />{saving ? "…" : dirtyKeys.length > 0 ? t("settings_env_save_dirty").replace("{n}", String(dirtyKeys.length)) : t("config_save")}
            </Btn>
          </div>
        </div>
        {message && (
          <div className={`mt-4 text-[12px] ${message.kind === "err" ? "text-[color:var(--c-err)]" : message.kind === "warn" ? "text-[color:var(--c-warn)]" : "text-[color:var(--c-ok)]"}`}>
            {message.text}
          </div>
        )}
        <div className="mt-4 flex min-w-0 flex-wrap items-center gap-3 rounded-md border border-line bg-surface px-3 py-2.5">
          <div className="min-w-[220px] flex-1">
            <div className="text-[12px] font-medium text-ink-1">{t("settings_env_save_target")}</div>
            <div className="mt-0.5 text-[11.5px] leading-5 text-ink-4">
              {saveTarget === "env_local"
                ? t("settings_env_target_env_local_hint").replace("{file}", data?.runtimeConfig.writableEnvFile ?? ".env.local")
                : t("settings_env_target_runtime_hint")}
            </div>
          </div>
          <div className="inline-flex rounded-md border border-line bg-bg p-0.5">
            <button
              type="button"
              aria-pressed={saveTarget === "env_local"}
              onClick={() => setSaveTarget("env_local")}
              className={segmentClass(saveTarget === "env_local")}
            >
              {t("settings_env_target_env_local")}
            </button>
            <button
              type="button"
              aria-pressed={saveTarget === "runtime"}
              onClick={() => setSaveTarget("runtime")}
              className={segmentClass(saveTarget === "runtime")}
            >
              {t("settings_env_target_runtime")}
            </button>
          </div>
          <Badge variant="ok" dot>{t("settings_env_autosync")}</Badge>
        </div>
      </header>

      <main className="px-8 py-6 space-y-8">
        <SystemConfigSummary cfg={systemCfg} loading={loading} fieldCount={fields.length} />

        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-[12px] font-medium text-ink-2">{t("settings_env_infra_title")}</div>
            {data?.generatedAt && (
              <div className="text-[11px] text-ink-4 mono">{new Date(data.generatedAt).toLocaleString()}</div>
            )}
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-3">
            {(data?.infra.subsystems ?? []).map((sub) => (
              <div key={sub.id} className="min-w-0 rounded-md border border-line bg-surface p-4">
                <div className="flex items-center justify-between gap-2 min-w-0">
                  <div className="min-w-0 truncate text-[13px] font-medium text-ink-1">{sub.label}</div>
                  <Badge variant={badgeForState(sub.state)}>{sub.state}</Badge>
                </div>
                {sub.detail && <div className="mt-2 text-[11.5px] leading-5 text-ink-3 break-words">{sub.detail}</div>}
                <div className="mt-3 space-y-1">
                  {sub.metrics.map((m) => (
                    <div key={m.label} className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-2 text-[11px] leading-5">
                      <span className="text-ink-4 whitespace-nowrap">{m.label}</span>
                      <span className="min-w-0 truncate mono text-ink-3" title={m.value}>{compactValue(m.value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {loading && !data && (
              <div className="rounded-md border border-line bg-surface p-4 text-[12px] text-ink-3">{t("settings_env_loading")}</div>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Btn size="sm" onClick={syncGraph} disabled={!data || busyAction !== null}>
              <Ic.branch />{busyAction === "neo4j" ? "…" : t("monitor_infra_action_sync_neo4j")}
            </Btn>
          </div>
        </section>

        <ProcessControlPanel onChanged={() => load({ silent: true, preserveDraft: true, preserveMessage: true })} />

        <section className="min-w-0">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <div className="text-[12px] font-medium text-ink-2">{t("settings_env_app_registration_title")}</div>
              <div className="mt-1 text-[11.5px] leading-5 text-ink-4">{t("settings_env_app_registration_hint")}</div>
            </div>
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(360px,100%),1fr))] gap-3">
            <MainInngestAppRegistration
              defaultUrl={data?.infra.inngest.serveEndpointUrl ?? systemCfg?.inngest.serveEndpointUrl ?? ""}
              onSynced={() => load({ silent: true, preserveDraft: true, preserveMessage: true })}
            />
            <DomainInngestAppManager />
          </div>
        </section>

        <section className="min-w-0">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <div className="text-[12px] font-medium text-ink-2">{t("settings_env_cards_title")}</div>
              <div className="mt-1 text-[11.5px] leading-5 text-ink-4">{t("settings_env_cards_hint")}</div>
            </div>
            <div className="text-[11px] text-ink-4">
              {fields.length > 0 ? t("settings_env_field_count").replace("{n}", String(fields.length)) : ""}
            </div>
          </div>

          {groups.length === 0 && !loading ? (
            <div className="rounded-md border border-line bg-surface p-4 text-[12px] text-ink-3">
              {t("settings_env_empty")}
            </div>
          ) : (
            <div className="space-y-7">
              {groups.map((group) => (
                <div key={group.id} className="min-w-0">
                  <div className="mb-2 flex items-center gap-2">
                    <div className="text-[12px] font-semibold text-ink-1">{group.label}</div>
                    <span className="mono text-[10.5px] text-ink-4">{group.fields.length}</span>
                  </div>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-3">
                    {group.fields.map((field) => (
                      <EnvFieldCard
                        key={field.key}
                        field={field}
                        value={draft[field.key] ?? ""}
                        dirty={dirtyKeys.includes(field.key)}
                        onChange={(value) => setDraft((prev) => ({ ...prev, [field.key]: value }))}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function SystemConfigSummary({
  cfg,
  loading,
  fieldCount,
}: {
  cfg: SystemConfigResponse | null;
  loading: boolean;
  fieldCount: number;
}) {
  const { t } = useApp();
  if (!cfg && loading) {
    return (
      <section className="rounded-md border border-line bg-surface p-4 text-[12px] text-ink-3">
        {t("settings_env_loading")}
      </section>
    );
  }
  if (!cfg) return null;

  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="text-[12px] font-medium text-ink-2">{t("settings_env_system_title")}</div>
        <div className="text-[11px] text-ink-4 mono">{new Date(cfg.generatedAt).toLocaleString()}</div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(230px,1fr))] gap-3">
        <SummaryCard
          title={t("config_inngest_label")}
          badge={cfg.inngest.healthy ? "healthy" : "unreachable"}
          badgeVariant={cfg.inngest.healthy ? "ok" : "err"}
          rows={[
            ["URL", cfg.inngest.url],
            [t("config_serve_endpoint"), cfg.inngest.serveEndpointUrl],
            [t("config_fn_count"), String(cfg.inngest.registeredFunctionCount)],
            [t("config_runs_24h"), cfg.inngest.runsLast24h?.toLocaleString() ?? "—"],
            [t("config_app_errors"), cfg.inngest.appErrors.length === 0 ? "0" : String(cfg.inngest.appErrors.length)],
          ]}
        />
        <SummaryCard
          title={t("config_event_engine_label")}
          badge={
            cfg.eventEngine.staleness === "fresh"
              ? t("allmeta_strip_fresh")
              : cfg.eventEngine.staleness === "stale"
                ? t("allmeta_strip_stale")
                : t("allmeta_strip_never")
          }
          badgeVariant={cfg.eventEngine.staleness === "fresh" ? "ok" : cfg.eventEngine.staleness === "stale" ? "warn" : "err"}
          rows={[
            [t("config_last_sync"), cfg.eventEngine.lastSyncAt ? new Date(cfg.eventEngine.lastSyncAt).toLocaleString() : "—"],
            [t("config_synced_events"), String(cfg.eventEngine.syncedEventCount)],
            [t("config_last_error"), cfg.eventEngine.lastError ?? "—"],
          ]}
        />
        <SummaryCard
          title={t("config_raas_label")}
          badge={cfg.raas.apiUrl ? "configured" : "unset"}
          badgeVariant={cfg.raas.apiUrl ? "ok" : "default"}
          rows={[
            ["API URL", cfg.raas.apiUrl ?? "—"],
            ["Inngest URL", cfg.raas.inngestSharedWithLocal ? t("config_shared_with_local") : cfg.raas.inngestUrl],
          ]}
        />
        <SummaryCard
          title={t("config_runtime_edit")}
          badge={t("settings_env_field_count").replace("{n}", String(fieldCount))}
          badgeVariant="info"
          rows={[
            [t("config_runtime_source_runtime"), String(cfg.runtimeConfig.fields.filter((f) => f.source === "runtime").length)],
            [t("config_runtime_source_env"), String(cfg.runtimeConfig.fields.filter((f) => f.source === "env").length)],
            [t("config_runtime_source_unset"), String(cfg.runtimeConfig.fields.filter((f) => f.source === "unset").length)],
          ]}
        />
      </div>
    </section>
  );
}

function SummaryCard({
  title,
  badge,
  badgeVariant,
  rows,
}: {
  title: string;
  badge: string;
  badgeVariant: "default" | "ok" | "warn" | "err" | "info";
  rows: Array<[string, string]>;
}) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2 min-w-0">
        <div className="min-w-0 truncate text-[13px] font-medium text-ink-1">{title}</div>
        <Badge variant={badgeVariant}>{badge}</Badge>
      </div>
      <div className="mt-3 space-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-2 text-[11px] leading-5">
            <span className="text-ink-4 whitespace-nowrap">{label}</span>
            <span className="min-w-0 truncate mono text-ink-3" title={value}>{compactValue(value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EnvFieldCard({
  field,
  value,
  dirty,
  onChange,
}: {
  field: RuntimeConfigFieldState;
  value: string;
  dirty: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useApp();
  return (
    <label className="min-w-0 rounded-md border border-line bg-surface p-3.5">
      <div className="flex items-start gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium text-ink-1" title={field.label}>{field.label}</div>
          <div className="mt-1 mono text-[10.5px] text-ink-4 break-all">{field.key}</div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <Badge variant={sourceVariant(field.source)}>{t(`config_runtime_source_${field.source}`)}</Badge>
          {dirty && <Badge variant="info">{t("settings_env_dirty")}</Badge>}
          {field.secret && <Badge variant="warn">{t("settings_env_secret")}</Badge>}
          {field.restartRequired && <Badge variant="warn">{t("config_restart_badge")}</Badge>}
        </div>
      </div>

      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={!field.editable}
        type={field.secret ? "password" : "text"}
        placeholder={field.secret && field.hasEffectiveValue ? t("config_secret_keep") : (field.placeholder ?? field.displayValue)}
        title={field.displayValue}
        className="mt-3 h-8 w-full min-w-0 rounded-md border border-line bg-panel px-2.5 mono text-[12px] text-ink-1 outline-none disabled:cursor-not-allowed disabled:text-ink-4 focus:border-[color:var(--c-accent)]"
      />

      <div className="mt-2 min-h-[34px] text-[11px] leading-[17px] text-ink-3 break-words">
        {field.description || t("settings_env_no_description")}
      </div>

      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
        {field.sourceFiles && field.sourceFiles.length > 0 ? (
          field.sourceFiles.map((file) => (
            <span key={file} className="max-w-full rounded border border-line bg-bg px-1.5 py-0.5 mono text-[10px] text-ink-4 truncate">
              {file}
            </span>
          ))
        ) : (
          <span className="text-[10.5px] text-ink-4">{t("settings_env_source_runtime_only")}</span>
        )}
        {!field.editable && <span className="text-[10.5px] text-ink-4">{t("settings_env_readonly")}</span>}
      </div>
    </label>
  );
}

function draftFromFields(fields: RuntimeConfigFieldState[]): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [
    field.key,
    field.secret ? "" : (field.overrideValue ?? field.effectiveValue ?? ""),
  ]));
}

function dirtyFieldKeys(fields: RuntimeConfigFieldState[], draft: Record<string, string>): string[] {
  return fields
    .filter((field) => {
      if (!field.editable) return false;
      const next = draft[field.key] ?? "";
      if (field.secret) return next.trim().length > 0;
      const original = field.overrideValue ?? field.effectiveValue ?? "";
      return next !== original || (field.hasOverride && next.trim().length === 0);
    })
    .map((field) => field.key);
}

function groupFields(fields: RuntimeConfigFieldState[]) {
  const byKey = new Map<string, { id: string; label: string; fields: RuntimeConfigFieldState[] }>();
  for (const field of fields) {
    const id = field.section || "other";
    const group = byKey.get(id) ?? { id, label: field.sectionLabel || id, fields: [] };
    group.fields.push(field);
    byKey.set(id, group);
  }
  return Array.from(byKey.values());
}

function badgeForState(state: string): "default" | "ok" | "warn" | "err" | "info" {
  if (state === "healthy") return "ok";
  if (state === "degraded") return "warn";
  if (state === "down") return "err";
  return "default";
}

function sourceVariant(source: string): "default" | "ok" | "warn" | "err" | "info" {
  if (source === "runtime") return "info";
  if (source === "env") return "ok";
  if (source === "default") return "warn";
  return "default";
}

function segmentClass(active: boolean): string {
  return [
    "h-6 rounded px-2.5 text-[11.5px] font-medium transition-colors",
    active
      ? "bg-surface text-ink-1 shadow-[inset_0_0_0_1px_var(--c-line)]"
      : "text-ink-3 hover:text-ink-1",
  ].join(" ");
}

function compactValue(value: string): string {
  try {
    const url = new URL(value);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return value;
  }
}
