/**
 * In-process adapter registry.
 *
 * Adapters are registered at module-load time from `runtime-adapters/index.ts`.
 * `registerAdapter` is reference-deduplicating and idempotent — registering
 * the same adapter object twice is a no-op, which keeps double-import via
 * different module paths safe (e.g. dev HMR re-evaluating the barrel).
 *
 * Lookup is by action identity only: callers pass `{ id, name }` (typically
 * sourced from `obj.meta` or a fetched `Action`), and the first adapter whose
 * `matches` predicate accepts that identity wins.
 */

import type { ActionRuntimeAdapter } from "./types";

const adapters: ActionRuntimeAdapter<unknown>[] = [];

export function registerAdapter<T>(adapter: ActionRuntimeAdapter<T>): void {
  const entry = adapter as ActionRuntimeAdapter<unknown>;
  if (adapters.includes(entry)) return;
  adapters.push(entry);
}

export function findAdapterByAction(
  action: { id?: string; name?: string },
): ActionRuntimeAdapter<unknown> | null {
  return adapters.find((a) => a.matches(action)) ?? null;
}

export function listAdapters(): readonly ActionRuntimeAdapter<unknown>[] {
  return adapters;
}
