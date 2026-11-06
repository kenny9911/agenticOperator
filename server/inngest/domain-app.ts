// Per-domain Inngest app.
//
// Each business domain can register its own Inngest app (id
// `agentic-operator-<domain>`) served at the dynamic route /api/inngest/<domain>.
// Ontology-generated agents that are DEPLOYED (AgentVersion status='active') in
// that domain become live stub functions on this app — they actually run:
// trigger on the agent's triggerEvent, simulate work, emit the emitEvent.
//
// This is fully separate from the real production app (agentic-operator-main):
// distinct app id, distinct serve route, og- function slugs — so registering or
// offlining a domain app can never affect the RAAS-v1 6 real functions.

import { Inngest } from "inngest";
import { serve } from "inngest/next";
import { WriteThroughMiddleware } from "@/server/inngest/write-through-middleware";
import { prisma } from "@/server/db";
import { ensureWorkflowRun, markRunComplete, createAgentLogger } from "@/server/agent-logger";
import { getInngestUrl } from "@/lib/inngest-url";
import { ONTOLOGY_GEN_SOURCE } from "@/lib/ontology-generator/draft-store";
import { RECRUITMENT_DOMAIN_ID, ENERGY_DOMAIN_ID, COST_CONTROL_DOMAIN_ID, isRecruitmentDomain } from "@/lib/domain-ids";
import { isSandboxDomain } from "@/lib/tools/resolve-registry";
import { buildEnergyFunctions } from "@/server/inngest/domains/energy";
import { buildCostControlFunctions } from "@/server/inngest/domains/feikong";
import { executeGeneratedAgent } from "@/server/inngest/factory/agent-executor";
import { loadGeneratedAgentFunction } from "@/lib/agent-factory-v3/load-generated";
import type { GeneratedAgentSpec } from "@/lib/agent-factory-gen/types";
import type { ShellCardData } from "@/lib/ontology-generator/types";

/** Parse the deployed spec's LLM-execution fields from specJson. */
function parseAgentSpec(specJson: string | null): { actionName: string; domainId?: string; systemPrompt: string; userPrompt: string; tools: string[] } | null {
  if (!specJson) return null;
  try {
    const s = JSON.parse(specJson) as { actionName?: string; short?: string; domainId?: string; systemPrompt?: string; userPrompt?: string; tools?: unknown };
    return { actionName: s.actionName ?? s.short ?? "", domainId: s.domainId, systemPrompt: s.systemPrompt ?? "", userPrompt: s.userPrompt ?? "", tools: Array.isArray(s.tools) ? (s.tools as string[]) : [] };
  } catch { return null; }
}

// The `raas` (业务领域) domain is ALREADY served by the main app
// (agentic-operator-main, /api/inngest) which hosts the RAAS-v1 6 real
// functions. It must never get its own per-domain app.
const MAIN_DOMAIN = RECRUITMENT_DOMAIN_ID;
const MAIN_APP_ID = "agentic-operator-main";

function domainAppId(domain: string): string {
  return `agentic-operator-${domain}`;
}

function domainServePath(domain: string): string {
  return `/api/inngest/${encodeURIComponent(domain)}`;
}

function parseCard(configJson: string | null): ShellCardData | null {
  if (!configJson) return null;
  try {
    return JSON.parse(configJson) as ShellCardData;
  } catch {
    return null;
  }
}

// ── functions ──────────────────────────────────────────────────────────────

type ShellRow = { short: string; slug: string; configJson: string | null; specJson: string | null };

/** The full trigger/emit event sets for a shell — drawn from specJson (arrays),
 *  falling back to the card's single primary event. Multi-event so the WHOLE
 *  generated chain traverses (the card only keeps `trigger[0]`/`emit[0]`, which
 *  stops the chain at the first branch). */
function shellEvents(specJson: string | null, card: ShellCardData): { triggers: string[]; emits: string[] } {
  const clean = (arr: unknown, fallback: string): string[] => {
    const list = Array.isArray(arr) && arr.length ? (arr as string[]) : [fallback];
    return [...new Set(list.filter((e) => typeof e === "string" && e && e !== "—"))];
  };
  try {
    const s = JSON.parse(specJson || "{}") as { trigger?: unknown; emit?: unknown };
    return { triggers: clean(s.trigger, card.triggerEvent), emits: clean(s.emit, card.emitEvent) };
  } catch {
    return { triggers: clean(null, card.triggerEvent), emits: clean(null, card.emitEvent) };
  }
}

function makeShellFunction(
  client: Inngest,
  domain: string,
  shell: ShellRow,
  card: ShellCardData,
  events: { triggers: string[]; emits: string[] },
  spec: { actionName: string; domainId?: string; systemPrompt: string; userPrompt: string; tools: string[] } | null,
) {
  return client.createFunction(
    {
      id: shell.slug, // og-… → full slug agentic-operator-<domain>-og-…
      name: card.nameZh || card.agentId || shell.short,
      // Namespace each trigger as `${domain}/${event}` so a generated domain's
      // chain is isolated from production (which uses bare event names) AND
      // matches the namespaced entry events deploy.ts fireAndObserve sends.
      // Without namespacing the shell listens on a bare name nobody in this
      // domain fires → runs:[] (the observe gap). Multi-trigger so an agent that
      // consumes several events (e.g. jdGenerator on REQUIREMENT_LOGGED |
      // CLARIFICATION_READY) is reachable from any of them.
      triggers: events.triggers.map((e) => ({ event: `${domain}/${e}` })),
    },
    async ({ event, step }: { event: { id?: string; name: string; data?: unknown }; step: any }) => {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const runId =
        (typeof data._runId === "string" && data._runId) ||
        (typeof event.id === "string" && event.id) ||
        `${shell.slug}-${event.name}`;

      await step.run("ensure-run", () =>
        ensureWorkflowRun({
          runId,
          triggerEvent: event.name,
          triggerData: { agent: shell.short, domain, event: event.name },
        }),
      );

      const log = createAgentLogger({ agent: shell.short, nodeId: shell.slug, runId });
      await step.run("log-receive", async () => {
        await log.event("event_received", `Received ${event.name}`, { eventId: event.id });
        await log.log("agent_start", `${shell.short} started`, {});
      });

      // REAL execution: the agent runs its OWN LLM + tools on the actual case
      // and DECIDES which single outcome event to emit — genuinely dynamic per
      // case, not a sleep+emit stub. Degrades to the first event only if the
      // gateway is down or there's no spec.
      const decision = await step.run("reason", () =>
        executeGeneratedAgent(
          {
            actionName: spec?.actionName ?? shell.short,
            // spec.domainId drives the runtime registry + dry-run. Use the spec's
            // OWN domain when present (so a sandbox copy under `sandbox-X` still
            // binds X's real tool library); fall back to the serving domain.
            domainId: spec?.domainId ?? domain,
            systemPrompt: spec?.systemPrompt ?? "",
            userPrompt: spec?.userPrompt ?? "",
            tools: spec?.tools ?? [],
            emit: events.emits,
          },
          { eventName: event.name.replace(`${domain}/`, ""), eventData: data },
          // A dedicated sandbox app always runs dry-run — never fire real
          // external side effects (invites / DB writes) during a test.
          { forceDryRun: isSandboxDomain(domain) },
        ),
      );

      await step.run("decided", () =>
        log.log("agent_decision", `${shell.short} 判断 → 发出 ${decision.event || "(无)"}：${decision.reasoning}`, {
          chosen: decision.event,
          tools: decision.toolCalls.map((t: { name: string }) => t.name),
          degraded: decision.degraded,
        }),
      );

      if (decision.event) {
        await step.sendEvent("emit", {
          name: `${domain}/${decision.event}`,
          data: { _runId: runId, source: shell.short, reasoning: decision.reasoning, ...decision.payload },
        });
      }

      await step.run("done", async () => {
        await log.done(`${shell.short} done`, { emitted: decision.event });
        await markRunComplete(runId, "completed");
      });
      // `degraded` rides in the return so fireAndObserve can see it from the run
      // archive output — a degraded decision (gateway down → emits[0] fallback) is
      // NOT a real decision and must not count as a genuine chain hop.
      return { runId, emitted: decision.event, reasoning: decision.reasoning, degraded: decision.degraded };
    },
  );
}

// ── keep-alive sentinel ──────────────────────────────────────────────────────
//
// Inngest flags any app with 0 functions red ("No functions registered"). Rather
// than delete a generated domain's app whenever it has no deployed agents, we
// keep it registered as a stable SLOT by always serving one no-op sentinel
// function. Real agents attach/detach alongside it; the app is never empty, so
// it never errors and is always a ready registration target for `<domain>`.

/** Sentinel function id + its (never-fired) trigger event. */
const KEEPALIVE_FN_ID = "og-__keepalive__";
const KEEPALIVE_EVENT = "__ao_keepalive__";

/** Which domains carry a keep-alive sentinel: GENERATED per-domain apps only.
 *  Excluded — raas (served by the main app), energy/费控 (always ship real
 *  packs), and sandbox-* apps (ephemeral — they must fully delete on teardown,
 *  not linger on a placeholder). */
function wantsKeepalive(domain: string): boolean {
  if (isRecruitmentDomain(domain)) return false;
  if (domain === ENERGY_DOMAIN_ID || domain === COST_CONTROL_DOMAIN_ID) return false;
  if (isSandboxDomain(domain)) return false;
  return true;
}

/** A no-op function whose only job is to keep `agentic-operator-<domain>` from
 *  being an empty (erroring) app. It triggers on `<domain>/__ao_keepalive__`,
 *  an event nothing ever emits; even if it somehow fired it does nothing — no
 *  run side effects, no logs. Hidden from user-facing rosters/counts (the
 *  roster already skips per-domain app slugs; getDomainApp subtracts it). */
function makeKeepalivePlaceholder(client: Inngest, domain: string) {
  return client.createFunction(
    { id: KEEPALIVE_FN_ID, name: "（系统）注册占位 · keep-alive", triggers: [{ event: `${domain}/${KEEPALIVE_EVENT}` }] },
    async () => ({ keepalive: true }),
  );
}

/** Build the live functions for a domain from its DEPLOYED agents — WITHOUT the
 *  app-status gate. This is the raw, authoritative function set: used by the
 *  registrar to decide what to sync. For keep-alive domains it is NEVER empty
 *  (the sentinel is always prepended); for sandbox apps it can be empty, which
 *  makes the registrar delete the app instead of leaving it erroring. The
 *  status gate lives in `buildDomainFunctions` (the serve path) below. */
async function collectDomainFunctions(client: Inngest, domain: string) {
  // raas is served by agentic-operator-main, not a per-domain app.
  if (isRecruitmentDomain(domain)) return [];

  // Energy + 费控 ship REAL runnable agent packs (the make-agent factory:
  // deterministic rule-check agents + HITL human gates + LLM agents). Serve those
  // on the domain's own client — NOT the sleep+emit shells below — so each runs
  // for real in its OWN app (agentic-operator-<domain>) without ever polluting the
  // recruitment main app.
  if (domain === ENERGY_DOMAIN_ID) return buildEnergyFunctions(client);
  if (domain === COST_CONTROL_DOMAIN_ID) return buildCostControlFunctions(client);

  const shells = await prisma.agentVersion.findMany({
    where: { capturedFrom: ONTOLOGY_GEN_SOURCE, domain, status: "active" },
    orderBy: { createdAt: "desc" },
    select: { short: true, slug: true, configJson: true, specJson: true },
  });

  // Dedupe by slug (a domain may have re-deployed the same agent) — keep latest.
  const bySlug = new Map<string, ShellRow>();
  for (const s of shells) if (!bySlug.has(s.slug)) bySlug.set(s.slug, s);

  const fns: ReturnType<typeof makeShellFunction>[] = [];
  // Keep-alive sentinel first → the app is never empty even with 0 deployed
  // agents (all drafts), so it stays registered as a ready slot instead of
  // erroring. Sandbox apps are excluded (wantsKeepalive=false) so they still
  // fully delete on teardown.
  if (wantsKeepalive(domain)) {
    fns.push(makeKeepalivePlaceholder(client, domain) as ReturnType<typeof makeShellFunction>);
  }
  for (const shell of bySlug.values()) {
    const card = parseCard(shell.configJson);
    if (!card?.triggerEvent || card.triggerEvent === "—") continue;
    const events = shellEvents(shell.specJson, card);
    if (!events.triggers.length) continue;
    const spec = parseAgentSpec(shell.specJson);
    // ③ In the SANDBOX, run the agent's AI-WRITTEN .ts itself (full fidelity) rather
    // than a generic re-interpretation of the spec. Any compile/load failure falls
    // back to the shell executor below, so a bad codegen never bricks the sandbox.
    if (isSandboxDomain(domain) && shell.specJson) {
      try {
        const full = JSON.parse(shell.specJson) as GeneratedAgentSpec;
        if (full.generatedCode && full.codeSource === "ai") {
          const real = await loadGeneratedAgentFunction(full, domain, client);
          if (real) { fns.push(real as ReturnType<typeof makeShellFunction>); continue; }
        }
      } catch { /* fall back to the shell executor */ }
    }
    fns.push(makeShellFunction(client, domain, shell, card, events, spec));
  }
  return fns;
}

/** The functions Inngest should see when it probes the serve endpoint. Gated on
 *  the app being `online` in the DB — an offline (or never-registered) domain
 *  serves zero functions so Inngest never dispatches to it. */
async function buildDomainFunctions(client: Inngest, domain: string) {
  if (isRecruitmentDomain(domain)) return [];
  const app = await prisma.domainInngestApp.findUnique({ where: { domain } });
  // Offline (or never registered) → serve zero functions.
  if (!app || app.status !== "online") return [];
  return collectDomainFunctions(client, domain);
}

// ── serve handler ────────────────────────────────────────────────────────────

// Cache the Inngest client per domain (stable config); rebuild functions from
// the DB on every request so deploy/offline take effect without a stale cache.
const clientCache = new Map<string, Inngest>();
function getDomainClient(domain: string): Inngest {
  let c = clientCache.get(domain);
  if (!c) {
    c = new Inngest({
      id: domainAppId(domain),
      eventKey: process.env.INNGEST_EVENT_KEY,
      middleware: [WriteThroughMiddleware],
    });
    clientCache.set(domain, c);
  }
  return c;
}

export async function getDomainServeHandler(domain: string): Promise<ReturnType<typeof serve>> {
  const client = getDomainClient(domain);
  const functions = await buildDomainFunctions(client, domain);
  // Explicit servePath so Inngest registers this app at /api/inngest/<domain>
  // (not the auto-detected /api/inngest, which would collide with the main app).
  return serve({ client, functions, servePath: domainServePath(domain) });
}

// ── registration ─────────────────────────────────────────────────────────────

/** Remove an app from the Inngest dev server entirely. This is the clean "no
 *  app" state — as opposed to a synced-but-empty app, which Inngest flags red
 *  ("No functions registered within your app", connected:false). Uses the
 *  `deleteAppByName` GraphQL mutation; idempotent — deleting a name that isn't
 *  registered is a harmless no-op. The app re-appears only if something
 *  PUT/POSTs its serve URL again (i.e. when it has functions to register). */
async function deleteInngestApp(appId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${getInngestUrl()}/v0/gql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "mutation DeleteApp($name: String!) { deleteAppByName(name: $name) }",
        variables: { name: appId },
      }),
      signal: AbortSignal.timeout(APP_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `Inngest GraphQL ${res.status}` };
    const body = (await res.json()) as { errors?: unknown };
    if (body.errors) return { ok: false, error: `Inngest GraphQL: ${JSON.stringify(body.errors)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Origin the Inngest dev server can reach the AO app at. Derived from the
 *  already-working main app registration (host.docker.internal in Docker), so
 *  per-domain apps reuse the exact reachable host. Falls back to env / default. */
async function resolveCallbackOrigin(): Promise<string> {
  // Prefer the explicit serve origin the SDK itself registers under — the host
  // the running Inngest can actually reach. With the native inngest-cli (this
  // setup) host.docker.internal is a dead IP, so when the main app isn't yet
  // registered the fallback below makes /fn/register fail with "App ID required".
  if (process.env.INNGEST_SERVE_ORIGIN) {
    try { return new URL(process.env.INNGEST_SERVE_ORIGIN).origin; } catch { /* fall through */ }
  }
  try {
    const res = await fetch(`${getInngestUrl()}/v0/gql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ apps { name url } }" }),
    });
    const body = (await res.json()) as { data?: { apps?: Array<{ name: string; url: string }> } };
    const main = body.data?.apps?.find((a) => a.name === "agentic-operator-main");
    if (main?.url) return new URL(main.url).origin;
  } catch {
    /* fall through */
  }
  const host = process.env.AO_LAN_IP ?? "host.docker.internal";
  const port = process.env.AO_PORT ?? "3002";
  return `http://${host}:${port}`;
}

async function callbackUrlFor(domain: string): Promise<string> {
  return `${await resolveCallbackOrigin()}${domainServePath(domain)}`;
}

async function postRegister(callbackUrl: string): Promise<{ ok: boolean; status: number; body: string }> {
  // Trigger the SDK's self-sync by PUTting the per-domain serve endpoint — the
  // SDK then registers its app (id + functions + reachable callback URL) with
  // the Inngest dev server, exactly how the main app syncs. The older
  // `POST ${inngest}/fn/register {url}` is rejected by current Inngest with
  // "App ID required".
  const res = await fetch(callbackUrl, { method: "PUT" });
  return { ok: res.ok, status: res.status, body: await res.text() };
}

export type DomainAppState = {
  domain: string;
  appId: string;
  status: "online" | "offline";
  /** true when the domain is served by the main app (raas) — not its own app. */
  boundToMain: boolean;
  callbackUrl: string | null;
  registeredAt: string | null;
  sync: DomainAppSyncState | null;
};

export type DomainAppSyncState = {
  healthy: boolean;
  error: string | null;
  connected: boolean | null;
  functionCount: number | null;
  url: string | null;
  lastProbeAt: string;
};

const APP_PROBE_TIMEOUT_MS = 3000;

async function probeInngestApp(appId: string): Promise<DomainAppSyncState> {
  const lastProbeAt = new Date().toISOString();
  try {
    const res = await fetch(`${getInngestUrl()}/v0/gql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ apps { name url error connected functionCount } }" }),
      signal: AbortSignal.timeout(APP_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        healthy: false,
        error: `Inngest GraphQL ${res.status}`,
        connected: null,
        functionCount: null,
        url: null,
        lastProbeAt,
      };
    }
    const body = (await res.json()) as {
      data?: { apps?: Array<{ name: string; url?: string | null; error?: string | null; connected: boolean; functionCount: number }> };
      errors?: unknown;
    };
    if (body.errors) {
      return {
        healthy: false,
        error: `Inngest GraphQL: ${JSON.stringify(body.errors)}`,
        connected: null,
        functionCount: null,
        url: null,
        lastProbeAt,
      };
    }
    const app = body.data?.apps?.find((a) => a.name === appId);
    if (!app) {
      return {
        healthy: false,
        error: "App not registered in Inngest",
        connected: false,
        functionCount: null,
        url: null,
        lastProbeAt,
      };
    }
    const error = typeof app.error === "string" && app.error.length > 0 ? app.error : null;
    return {
      healthy: error === null,
      error,
      connected: app.connected,
      functionCount: app.functionCount,
      url: app.url ?? null,
      lastProbeAt,
    };
  } catch (e) {
    return {
      healthy: false,
      error: (e as Error).message,
      connected: null,
      functionCount: null,
      url: null,
      lastProbeAt,
    };
  }
}

export async function getDomainApp(domain: string): Promise<DomainAppState> {
  if (isRecruitmentDomain(domain)) {
    // Bound to the existing main app — always online, never a separate app.
    return {
      domain,
      appId: MAIN_APP_ID,
      status: "online",
      boundToMain: true,
      callbackUrl: `${await resolveCallbackOrigin()}/api/inngest`,
      registeredAt: null,
      sync: await probeInngestApp(MAIN_APP_ID),
    };
  }
  const row = await prisma.domainInngestApp.findUnique({ where: { domain } });
  const status = (row?.status as "online" | "offline") ?? "offline";
  const sync = status === "online" ? await probeInngestApp(domainAppId(domain)) : null;
  return {
    domain,
    appId: domainAppId(domain),
    status,
    boundToMain: false,
    callbackUrl: row?.callbackUrl ?? null,
    registeredAt: row?.registeredAt ? row.registeredAt.toISOString() : null,
    // Report the REAL function count: the keep-alive sentinel is infrastructure,
    // not an agent, so subtract it. This keeps user-facing counts honest and
    // keeps deploy.ts's "did the real functions register?" poll (functionCount>0)
    // meaningful — without it the sentinel would make the poll pass instantly.
    sync: sync && wantsKeepalive(domain) && typeof sync.functionCount === "number"
      ? { ...sync, functionCount: Math.max(0, sync.functionCount - 1) }
      : sync,
  };
}

/** Register (or re-register) the domain's Inngest app. */
export async function registerDomainApp(domain: string): Promise<{ ok: boolean; error?: string; callbackUrl: string }> {
  if (isRecruitmentDomain(domain)) {
    // raas is already the main app — registering a separate one is wrong.
    return { ok: true, callbackUrl: `${await resolveCallbackOrigin()}/api/inngest` };
  }
  const callbackUrl = await callbackUrlFor(domain);

  // An Inngest app must host ≥1 function or the dev server flags it red
  // ("No functions registered within your app", connected:false). Keep-alive
  // domains are never empty (the sentinel is always served), so they always
  // register here. This empty-guard therefore only bites SANDBOX apps (no
  // sentinel): if a sandbox has no real functions, delete it rather than leave
  // it erroring — it gets re-synced the moment it has functions.
  const client = getDomainClient(domain);
  const fns = await collectDomainFunctions(client, domain);
  if (fns.length === 0) {
    await prisma.domainInngestApp.upsert({
      where: { domain },
      create: { domain, appId: domainAppId(domain), status: "offline", callbackUrl },
      update: { status: "offline", callbackUrl },
    });
    await deleteInngestApp(domainAppId(domain));
    return { ok: false, error: "no active functions to register — app left unsynced", callbackUrl };
  }

  await prisma.domainInngestApp.upsert({
    where: { domain },
    create: { domain, appId: domainAppId(domain), status: "online", callbackUrl, registeredAt: new Date() },
    update: { status: "online", callbackUrl, registeredAt: new Date() },
  });
  try {
    const r = await postRegister(callbackUrl);
    if (!r.ok) return { ok: false, error: `Inngest SDK sync ${r.status}: ${r.body}`, callbackUrl };
    return { ok: true, callbackUrl };
  } catch (e) {
    return { ok: false, error: (e as Error).message, callbackUrl };
  }
}

/** Ensure a freshly-generated domain has its Inngest app slot registered, even
 *  when every agent is still a draft. Registers the keep-alive sentinel so the
 *  slot exists (green, ready) the moment agents are generated; real agents join
 *  it on deploy. Best-effort + non-throwing — called from the generation/persist
 *  path, where a transient Inngest outage must never fail the generation. No-op
 *  for non-keep-alive domains (raas / energy / 费控 / sandbox). */
export async function ensureDomainAppRegistered(domain: string): Promise<void> {
  if (!wantsKeepalive(domain)) return;
  try {
    await registerDomainApp(domain);
  } catch {
    /* best-effort — the slot will register on the next deploy/resync */
  }
}

/** Take the domain's app offline: serve zero functions + re-sync so Inngest
 *  drops them. The app row stays (status=offline) so it can be re-registered. */
export async function offlineDomainApp(domain: string): Promise<{ ok: boolean; error?: string }> {
  if (isRecruitmentDomain(domain)) {
    return { ok: false, error: "raas is bound to agentic-operator-main and cannot be taken offline" };
  }
  const existing = await prisma.domainInngestApp.findUnique({ where: { domain } });
  const callbackUrl = existing?.callbackUrl ?? (await callbackUrlFor(domain));
  await prisma.domainInngestApp.upsert({
    where: { domain },
    create: { domain, appId: domainAppId(domain), status: "offline", callbackUrl },
    update: { status: "offline" },
  });
  // DELETE the app from Inngest rather than re-syncing it with 0 functions
  // (which would leave it registered-but-empty → permanent "No functions
  // registered" error). The row stays (status=offline) so it can be re-synced.
  const del = await deleteInngestApp(domainAppId(domain));
  return { ok: del.ok, error: del.error };
}

/** Re-sync the domain app after a shell deploy/revert/teardown so Inngest tracks
 *  the changed function set. Self-healing: if the function set is now empty
 *  (agents reverted to draft or the sandbox was torn down) the app is DELETED
 *  from Inngest instead of left synced-but-empty. No-op if no row exists. */
export async function resyncDomainApp(domain: string): Promise<void> {
  const app = await prisma.domainInngestApp.findUnique({ where: { domain } });
  if (!app) return;
  const client = getDomainClient(domain);
  const fns = await collectDomainFunctions(client, domain);
  if (fns.length === 0) {
    // Dropped to empty → remove the app so it doesn't linger as a red error.
    if (app.status === "online") {
      await prisma.domainInngestApp.update({ where: { domain }, data: { status: "offline" } }).catch(() => {});
    }
    await deleteInngestApp(domainAppId(domain));
    return;
  }
  // Has functions but the operator deliberately took it offline → respect that.
  if (app.status !== "online") return;
  const callbackUrl = app.callbackUrl ?? (await callbackUrlFor(domain));
  try {
    await postRegister(callbackUrl);
  } catch {
    /* best-effort */
  }
}
