// RAAS event bridge — pulls events from the shared Inngest (RAAS team's
// 10.100.0.70:8288) and re-emits them to AO's local Inngest. Solves the
// single-direction-routing problem: AO can reach 10.100.0.70 outbound,
// but 10.100.0.70 can't reach back to 172.16.1.83.
//
// One-way pull. Idempotent via a seen-set so the same event isn't
// re-dispatched.
//
// Started by app/api/raas-bridge/start/route.ts (or any other server-side
// boot path); polls every RAAS_BRIDGE_POLL_INTERVAL_MS.

import { prisma } from "../db";
import { em } from "../em";
import { getRaasInngestUrl } from "@/lib/inngest-url";
import { tlog } from "@/lib/terminal-log";

const SHARED_URL = getRaasInngestUrl();
const POLL_INTERVAL = Number(process.env.RAAS_BRIDGE_POLL_INTERVAL_MS ?? 5000);
const EVENT_NAMES = (process.env.RAAS_BRIDGE_EVENTS ?? "RESUME_DOWNLOADED")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

type SharedEvent = {
  id: string;
  internal_id?: string;
  name: string;
  data: unknown;
  ts?: number;
  received_at?: string;
};

let _started = false;
let _seenIds = new Set<string>();
let _lastPolledAt = "";
let _stats = {
  pollsCompleted: 0,
  eventsBridged: 0,
  // Refined per-result counters (since em.publish has 5 outcomes vs raw send's 2).
  // Sum of these always equals eventsBridged.
  accepted: 0,
  rejectedSchema: 0,
  rejectedFilter: 0,
  duplicate: 0,
  emDegraded: 0,
  errors: 0,
  lastError: null as string | null,
  lastEventBridgedAt: null as string | null,
};

export function getRaasBridgeStatus() {
  return {
    started: _started,
    sharedUrl: SHARED_URL,
    pollIntervalMs: POLL_INTERVAL,
    eventNames: EVENT_NAMES,
    lastPolledAt: _lastPolledAt,
    seenCount: _seenIds.size,
    ..._stats,
  };
}

export function startRaasBridge(): void {
  if (_started) return;
  if (process.env.RAAS_BRIDGE_ENABLED !== "1") {
    console.log("[raas-bridge] disabled (set RAAS_BRIDGE_ENABLED=1 to enable)");
    return;
  }
  _started = true;
  console.log(
    `[raas-bridge] starting. polling ${SHARED_URL}/v1/events every ${POLL_INTERVAL}ms for ${EVENT_NAMES.join(",")}`,
  );

  // Seed seen-set with the recent events so we don't re-fire historical
  // events when the bridge first starts.
  seedSeen()
    .then(() => {
      // Start poll loop
      tick();
    })
    .catch((e) => {
      console.error("[raas-bridge] seed failed:", e);
      tick();
    });
}

async function seedSeen(): Promise<void> {
  try {
    const r = await fetchSharedEvents(50);
    for (const e of r) _seenIds.add(e.id);
    _lastPolledAt = new Date().toISOString();
    console.log(`[raas-bridge] seeded ${r.length} historical events to skip`);
  } catch (e) {
    console.warn("[raas-bridge] seed: shared bus unreachable yet:", (e as Error).message);
  }
}

async function tick(): Promise<void> {
  try {
    const events = await fetchSharedEvents(20);
    _stats.pollsCompleted++;
    _lastPolledAt = new Date().toISOString();

    for (const e of events) {
      if (_seenIds.has(e.id)) continue;
      if (!EVENT_NAMES.includes(e.name)) {
        _seenIds.add(e.id);
        continue;
      }

      // New event from RAAS — push through em.publish so it gets schema
      // validation + audit + EventInstance row + EVENT_REJECTED on failure.
      // em.publish never throws; we always count the seen id so the bridge
      // can't get stuck retrying the same poison message.
      try {
        const result = await em.publish(e.name, e.data, {
          source: "raas-bridge",
          // Use upstream's shared id as both dedup key and Inngest idempotency key.
          // RAAS replays the same id when it thinks delivery failed; we collapse it.
          externalEventId: e.id,
        });
        _seenIds.add(e.id);
        _stats.eventsBridged++;
        _stats.lastEventBridgedAt = new Date().toISOString();
        if (result.accepted) {
          _stats.accepted++;
        } else {
          switch (result.reason) {
            case "schema":
            case "no_schema":
              _stats.rejectedSchema++;
              break;
            case "filter":
              _stats.rejectedFilter++;
              break;
            case "duplicate":
              _stats.duplicate++;
              break;
            case "em_degraded":
              _stats.emDegraded++;
              break;
          }
        }

        // Keep the legacy AgentActivity row for backwards-compat with the
        // /events stream view + /fleet AgentDetailPanel. Once those views
        // migrate to read EventInstance directly we can drop this.
        await prisma.agentActivity
          .create({
            data: {
              nodeId: "raas-bridge",
              agentName: "RAASBridge",
              type: "event_received",
              narrative: result.accepted
                ? `Bridged ${e.name} from RAAS · ${e.id}`
                : `Bridged ${e.name} from RAAS · ${e.id} · ${result.reason}`,
              metadata: JSON.stringify({
                source: "raas-bridge",
                shared_event_id: e.id,
                event_name: e.name,
                data: e.data,
                em_publish: result,
              }),
            },
          })
          .catch((err) => {
            console.warn("[raas-bridge] AgentActivity write failed:", err.message);
          });

        if (result.accepted) {
          tlog(`[raas-bridge] bridged ${e.name} (${e.id}) v${result.schemaVersionUsed}`);
        } else {
          console.warn(
            `[raas-bridge] bridged ${e.name} (${e.id}) → ${result.reason}`,
          );
        }
      } catch (publishErr) {
        // em.publish should never throw, but defend in depth so the poll
        // loop keeps making progress.
        _stats.errors++;
        _stats.lastError = `publish: ${(publishErr as Error).message}`;
        _seenIds.add(e.id);
        console.error("[raas-bridge] em.publish unexpected throw:", publishErr);
      }
    }

    // Cap seen-set so it doesn't grow unbounded.
    if (_seenIds.size > 5000) {
      const arr = [..._seenIds];
      _seenIds = new Set(arr.slice(-2500));
    }
  } catch (e) {
    _stats.errors++;
    _stats.lastError = `poll: ${(e as Error).message}`;
    if (_stats.errors % 10 === 1) {
      console.error("[raas-bridge] poll failed:", (e as Error).message);
    }
  } finally {
    setTimeout(tick, POLL_INTERVAL);
  }
}

async function fetchSharedEvents(limit: number): Promise<SharedEvent[]> {
  const ctl = AbortSignal.timeout(8_000);
  const res = await fetch(`${SHARED_URL}/v1/events?limit=${limit}`, { signal: ctl });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as { data?: SharedEvent[] };
  return Array.isArray(json.data) ? json.data : [];
}
