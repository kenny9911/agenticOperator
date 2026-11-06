// Monitor 'Events' tab — Inngest event firehose.
//
// Shows ALL events flowing through Inngest dev server (both sides of the
// AO ↔ RAAS integration):
//   - RAAS → AO:    RESUME_DOWNLOADED, REQUIREMENT_LOGGED, ...
//   - AO  → RAAS:   RESUME_PROCESSED, MATCH_*, JD_GENERATED, ...
//   - Inngest meta: function.finished, scheduled.timer, etc. (optionally hidden)
//
// Each event row:
//   - timestamp · name · payload preview
//   - click → expand to show full payload JSON + triggered runs (with status)

"use client";

import { useCallback, useEffect, useState } from "react";
import { useApp } from "@/lib/i18n";
import { useDomain } from "@/lib/domains";
import type { InngestEventRow } from "@/lib/api/inngest-events";
import { HelpTip } from "@/components/shared/HelpTip";

const REFRESH_MS = 5000;

type RunForEvent = {
  run_id: string;
  status: string;
  run_started_at?: string;
  ended_at?: string | null;
  function_id?: string;
  output?: unknown;
};

const HIDE_NAMES_DEFAULT = new Set([
  'inngest/function.finished',
  'inngest/function.failed',
  'inngest/scheduled.timer',
  'inngest/cron',
]);

export function InngestEventsTab() {
  const { t } = useApp();
  const { domain } = useDomain();
  const [events, setEvents] = useState<InngestEventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [nameFilter, setNameFilter] = useState('');
  const [hideMeta, setHideMeta] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runsByEvent, setRunsByEvent] = useState<Map<string, RunForEvent[]>>(new Map());
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [auto, setAuto] = useState(true);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: "100", domain });
      if (nameFilter) params.set("name", nameFilter);
      const r = await fetch(`/api/inngest-events?${params.toString()}`);
      const b = await r.json();
      setEvents(b.events ?? []);
      setLastRefresh(new Date().toLocaleTimeString());
      setLoading(false);
    } catch {
      /* soft */
    }
  }, [domain, nameFilter]);

  async function fetchRunsFor(eventId: string) {
    if (runsByEvent.has(eventId)) return;
    try {
      // Route via our own /api proxy so the URL resolves server-side from
      // INNGEST_BASE_URL — partner deploys on LAN don't have localhost:8288.
      const r = await fetch(`/api/inngest-events/${encodeURIComponent(eventId)}/runs`);
      const b = await r.json();
      setRunsByEvent((prev) => {
        const next = new Map(prev);
        next.set(eventId, b.runs ?? []);
        return next;
      });
    } catch {
      /* soft */
    }
  }

  useEffect(() => {
    void load();
    if (!auto) return;
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load, auto]);

  const filtered = hideMeta ? events.filter((e) => !HIDE_NAMES_DEFAULT.has(e.name)) : events;

  return (
    <div>
      {/* Filter toolbar */}
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <input
          value={nameFilter}
          onChange={(e) => setNameFilter(e.target.value)}
          placeholder={t('monitor_events_filter_placeholder')}
          className="px-3 py-1 text-[12px] border border-line rounded bg-surface text-ink-1 mono w-[280px]"
        />
        <label className="flex items-center gap-1.5 text-[11px] text-ink-3 cursor-pointer">
          <input
            type="checkbox"
            checked={hideMeta}
            onChange={(e) => setHideMeta(e.target.checked)}
          />
          {t('monitor_events_hide_meta')}
        </label>
        <label className="flex items-center gap-1.5 text-[11px] text-ink-3 cursor-pointer">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => setAuto(e.target.checked)}
          />
          {t('monitor_events_auto_refresh')}
        </label>
        {lastRefresh && (
          <span className="text-[10px] mono text-ink-4">{lastRefresh}</span>
        )}
        <span className="ml-auto text-[11px] text-ink-4 mono">
          {filtered.length} / {events.length} {t("monitor_events_total")}
        </span>
        <button
          onClick={load}
          className="text-[11px] px-2 py-1 border border-line rounded hover:bg-surface-hover"
        >
          ↻ {t("monitor_events_refresh")}
        </button>
      </div>

      {loading && events.length === 0 && (
        <div className="text-[12px] text-ink-3 px-2 py-4">{t('monitor_events_loading')}</div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="border border-dashed border-line rounded p-8 text-center text-[12px] text-ink-3">
          {t('monitor_events_none')}
        </div>
      )}

      <div className="space-y-1.5">
        {filtered.map((ev) => (
          <EventRow
            key={ev.id}
            event={ev}
            expanded={expandedId === ev.id}
            onToggle={() => {
              const next = expandedId === ev.id ? null : ev.id;
              setExpandedId(next);
              if (next) fetchRunsFor(ev.id);
            }}
            runs={runsByEvent.get(ev.id) ?? null}
          />
        ))}
      </div>
    </div>
  );
}

function EventRow({
  event,
  expanded,
  onToggle,
  runs,
}: {
  event: InngestEventRow;
  expanded: boolean;
  onToggle: () => void;
  runs: RunForEvent[] | null;
}) {
  const { t } = useApp();
  const [replaying, setReplaying] = useState(false);
  const [replayMsg, setReplayMsg] = useState<string | null>(null);

  async function handleReplay(e: React.MouseEvent) {
    e.stopPropagation();
    if (!event.id) {
      setReplayMsg(t('monitor_detail_retry_failed').replace('{message}', 'no event id'));
      return;
    }
    setReplaying(true);
    setReplayMsg(null);
    try {
      const r = await fetch('/api/inngest-admin/replay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: event.id }),
      });
      const b = await r.json();
      if (b.ok) {
        setReplayMsg(t('monitor_detail_retry_success').replace('{id}', b.new_event_id));
      } else {
        setReplayMsg(t('monitor_detail_retry_failed').replace('{message}', b.message ?? b.error));
      }
    } catch (err) {
      setReplayMsg(
        t('monitor_detail_retry_failed').replace('{message}', (err as Error).message),
      );
    } finally {
      setReplaying(false);
    }
  }
  const time = event.received_at
    ? new Date(event.received_at).toLocaleString('zh-CN', { hour12: false })
    : event.ts
    ? new Date(event.ts).toLocaleString('zh-CN', { hour12: false })
    : '—';
  const isAoEmit = event.name.startsWith('RESUME_PROCESSED') ||
    event.name.startsWith('MATCH_') ||
    event.name.startsWith('JD_GENERATED');
  const isInbound = event.name === 'RESUME_DOWNLOADED' || event.name === 'REQUIREMENT_LOGGED' || event.name === 'CLARIFICATION_READY' || event.name === 'JD_REJECTED';
  const isMeta = event.name.startsWith('inngest/');

  const dirColor = isMeta
    ? 'text-ink-4'
    : isAoEmit
    ? 'text-ok'
    : isInbound
    ? 'text-accent'
    : 'text-ink-2';
  const dirLabel = isMeta ? "⚙" : isAoEmit ? "↗" : isInbound ? "↘" : "·";
  const dirTip = isMeta
    ? "Inngest meta"
    : isAoEmit
      ? "AO emit"
      : isInbound
        ? "RAAS → AO"
        : event.domain ?? "other";

  // Preview of payload (truncated)
  const preview = JSON.stringify(event.data ?? {}).slice(0, 120);

  return (
    <div className="border border-line rounded bg-surface">
      <button
        onClick={onToggle}
        className="w-full text-left p-2.5 flex items-start gap-3 hover:bg-surface-hover"
      >
        <span className={`text-[10px] mono font-medium shrink-0 mt-0.5 w-5 ${dirColor}`} title={dirTip}>
          {dirLabel}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[12px] font-semibold mono text-ink-1">{event.name}</span>
            <span className="text-[10px] mono text-ink-4">{event.id}</span>
            {event.domain && <HelpTip tip={event.domain} />}
          </div>
          <div className="text-[10px] mono text-ink-4 mt-0.5">{time}</div>
          {!expanded && (
            <div className="text-[10.5px] mono text-ink-3 mt-1 truncate">
              {preview}
              {preview.length >= 120 && '...'}
            </div>
          )}
        </div>
        <span className="text-ink-4 shrink-0 mt-1">{expanded ? '▴' : '▾'}</span>
      </button>

      {expanded && (
        <div className="border-t border-line p-3 space-y-3">
          {/* Actions row — replay */}
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleReplay}
              disabled={replaying || !event.id}
              title={t('monitor_detail_retry_warning')}
              className="text-[11px] px-2.5 py-1 rounded border border-accent text-accent hover:bg-accent-bg disabled:opacity-40 disabled:cursor-not-allowed font-medium"
            >
              ↺ {replaying ? t('monitor_run_retrying') : t('em_replay')}
            </button>
            {replayMsg && (
              <span className="text-[10.5px] text-ink-3">{replayMsg}</span>
            )}
          </div>

          {/* Payload JSON */}
          <div>
            <div className="text-[10px] uppercase text-ink-4 mb-1.5 tracking-wide">
              {t('monitor_events_payload_label')}
            </div>
            <pre className="text-[10.5px] mono bg-panel border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap break-words max-h-[400px] overflow-y-auto">
              {JSON.stringify(event.data, null, 2)}
            </pre>
          </div>

          {/* Triggered runs */}
          <div>
            <div className="text-[10px] uppercase text-ink-4 mb-1.5 tracking-wide">
              {t('monitor_events_triggered_runs')}
            </div>
            {runs === null ? (
              <div className="text-[11px] text-ink-3">{t('monitor_events_loading_runs')}</div>
            ) : runs.length === 0 ? (
              <div className="text-[11px] text-ink-4">{t('monitor_events_no_runs_triggered')}</div>
            ) : (
              <div className="space-y-1">
                {runs.map((r) => (
                  <a
                    key={r.run_id}
                    href={`/monitor/flows/${encodeURIComponent(
                      // Build a flow-id approximation; for upload-id flows we'd
                      // need to extract from payload. Simplest: link to run by id.
                      'evt:' + event.id,
                    )}`}
                    className="block p-2 border border-line rounded text-[11px] hover:bg-surface-hover"
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-1.5 h-1.5 rounded-full ${
                          r.status === 'Completed'
                            ? 'bg-ok'
                            : r.status === 'Failed'
                            ? 'bg-err'
                            : r.status === 'Running'
                            ? 'bg-warn'
                            : 'bg-ink-4'
                        }`}
                      />
                      <span className="font-mono">{r.run_id}</span>
                      <span
                        className={`text-[10px] mono font-medium ${
                          r.status === 'Completed'
                            ? 'text-ok'
                            : r.status === 'Failed'
                            ? 'text-err'
                            : 'text-warn'
                        }`}
                      >
                        {r.status}
                      </span>
                      <span className="ml-auto text-ink-4 text-[10px]">→</span>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
