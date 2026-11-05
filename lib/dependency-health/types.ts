// External Dependency Health — shared types.
//
// AO-side only: we can't change RoboHire or the LLM vendor. We read what they
// return us (status / error body / response content) and judge, on our side,
// whether a paid dependency is dead — and if so, whether it's 没钱了 (out of
// funds), 故障了 (a fault/outage), or 说不准 (we genuinely can't tell).
//
// See docs/superpowers/specs/2026-06-05-external-dependency-health-design.md.

/** Which paid dependency the signal is about. */
export type DepProvider = 'robohire' | 'llm' | 'rmhr';

/**
 * The machine-readable cause, derived from the vendor's response. This is the
 * raw classification of ONE call; the 没钱/故障/说不准 *judgment* is made later
 * by the monitor over a window of these (see DepLabel).
 *   quota      — out of funds / quota exhausted (the cleanest money signal)
 *   auth       — 401/403 (expired-or-revoked key? misconfig? genuinely ambiguous)
 *   rate_limit — 429 throttle
 *   empty      — 200 OK but the payload has nothing usable (silent degrade)
 *   server     — 5xx
 *   network    — unreachable / timeout / connection reset
 */
export type DepReason = 'quota' | 'auth' | 'rate_limit' | 'empty' | 'server' | 'network';

/**
 * The windowed judgment the monitor renders to the operator.
 *   fault_warning — a few clean 5xx/timeouts: 故障预警 (warn), not yet confirmed
 *   fault         — failures persisted past the confirm threshold: 故障 (critical)
 */
export type DepLabel = 'out_of_funds' | 'fault_warning' | 'fault' | 'unknown'; // 没钱了 / 故障预警 / 故障了 / 说不准

/** The result of classifying one external call. */
export type DepOutcome =
  | { ok: true }
  | { ok: false; provider: DepProvider; op: string; reason: DepReason; detail: string };

/** A single degraded-call signal, reconstructed from a LogEvent row by the read port. */
export interface DepFailure {
  provider: DepProvider;
  op: string;
  reason: DepReason;
  domain: string;
  runId: string | null;
  ts: Date;
  anchors?: Record<string, string>;
}

/**
 * A successful call to a dependency, reconstructed from a `dependency_ok`
 * LogEvent. Failures at/before the latest success for the same
 * (provider, domain) are dropped — the dependency has demonstrably recovered.
 */
export interface DepSuccess {
  provider: DepProvider;
  domain: string;
  ts: Date;
}
