/**
 * Per-rule instance prefetch (含义 A1, locked 2026-05-12 per SPEC §15).
 *
 * For each active rule, look up its `InstanceSpec` via `instancesNeededForRule`
 * and prefetch any Ontology instances NOT already covered by the matchResume
 * runtime input (Job + Resume). The result is the flat `extraInstances[]`
 * threaded into `generatePrompt()`'s `extraInstances` option, which gets
 * rendered into the `## 额外数据 (按 rule 依赖预取)` section.
 *
 * fetchedInstanceIndex contract (locked):
 *   - position 0 = Job (in 运行时输入)
 *   - position 1 = Resume (in 运行时输入)
 *   - positions 2..N = entries of this function's return value, in stable
 *     order (sorted by `${objectType}/${objectId}`)
 *
 * Stability is REQUIRED so audit JSON references remain reproducible. Two
 * runs with identical input yield identical extraInstances ordering.
 *
 * All fetches go through `tracedGetJson` (via the underlying fetcher) so the
 * orchestrator's `ontologyApiTrace[]` captures every HTTP exchange.
 */

import { rcDebug, rcInfo, rcWarn } from "./debug";
import {
  fetchCandidate,
  listApplications,
  listBlacklist,
  listCandidateExpectations,
  type FetchInstanceCtx,
} from "./fetch-instances";
import { instancesNeededForRule } from "./rule-instance-map";
import type { FetchedRuleClassified, Instance } from "./types";

export interface FetchExtraInstancesInput {
  /** Filtered active rules (post `--rules` filter). */
  activeRules: FetchedRuleClassified[];
  /** Shared fetch context (env + traceCtx). */
  ctx: FetchInstanceCtx;
  /** Used for Application filter `jobRequisitionId` when rule needs `byJob`. */
  jobRef: string;
  candidateId: string;
  /**
   * Current Beijing time (ISO-8601 with +08:00). Used to compute
   * `Application.push_timestamp` lookback windows.
   */
  currentTimeIso: string;
}

/**
 * Returns the prefetched `extraInstances[]` sorted deterministically. May
 * be empty if no active rule declares additional dependencies (e.g. all
 * rules are satisfied by Job + Resume alone).
 */
export async function fetchExtraInstancesForRules(
  input: FetchExtraInstancesInput,
): Promise<Instance[]> {
  // Collect the union of required (label, fetch-arg) keys.
  // A key uniquely identifies a fetch operation.
  type FetchKey =
    | { kind: "candidate"; candidateId: string }
    | { kind: "candidate_expectation"; candidateId: string }
    | { kind: "application"; candidateId: string; jobRef?: string; sinceDate?: string; onlyStatuses?: string[] }
    | { kind: "blacklist"; candidateId: string };

  const fetchKeys: FetchKey[] = [];
  const seenKeyStrings = new Set<string>();
  const skippedRules: string[] = [];

  for (const rule of input.activeRules) {
    const spec = instancesNeededForRule(rule.id);
    if (!spec) {
      skippedRules.push(rule.id);
      continue;
    }

    if (spec.needsCandidate) {
      pushUnique({ kind: "candidate", candidateId: input.candidateId });
    }
    if (spec.needsCandidateExpectation) {
      pushUnique({ kind: "candidate_expectation", candidateId: input.candidateId });
    }
    if (spec.needsApplications) {
      const a = spec.needsApplications;
      const sinceDate = a.lookbackMonths
        ? subtractMonthsIso(input.currentTimeIso, a.lookbackMonths)
        : undefined;
      pushUnique({
        kind: "application",
        candidateId: input.candidateId,
        jobRef: a.byJob ? input.jobRef : undefined,
        sinceDate,
        onlyStatuses: a.onlyStatuses,
      });
    }
    if (spec.needsBlacklist) {
      pushUnique({ kind: "blacklist", candidateId: input.candidateId });
    }
    // Note: Resume and Job are already loaded via runtime-input — skip here.
    // `needsLocks` is reserved and not implemented in MVP.
  }

  function pushUnique(key: FetchKey): void {
    const s = JSON.stringify(key);
    if (seenKeyStrings.has(s)) return;
    seenKeyStrings.add(s);
    fetchKeys.push(key);
  }

  rcInfo("fetch-extra", "dependency union computed", {
    activeRules: input.activeRules.length,
    rulesWithoutSpec: skippedRules.length,
    distinctFetches: fetchKeys.length,
  });
  if (skippedRules.length > 0) {
    rcDebug("fetch-extra", "rules with no instance-map spec", {
      ruleIds: skippedRules,
    });
  }

  // Dispatch fetches in parallel; collect into a typed bucket per key.
  const fetchResults = await Promise.all(
    fetchKeys.map(async (key): Promise<Instance[]> => {
      try {
        switch (key.kind) {
          case "candidate":
            return [await fetchCandidate(key.candidateId, input.ctx)];
          case "candidate_expectation":
            return await listCandidateExpectations(key.candidateId, input.ctx);
          case "application": {
            const apps = await listApplications(
              {
                candidateId: key.candidateId,
                jobRequisitionId: key.jobRef,
                sinceDate: key.sinceDate,
              },
              input.ctx,
            );
            if (key.onlyStatuses && key.onlyStatuses.length > 0) {
              const allowed = new Set(key.onlyStatuses);
              return apps.filter((inst) => {
                const s = inst.data["status"];
                return typeof s === "string" && allowed.has(s);
              });
            }
            return apps;
          }
          case "blacklist":
            return await listBlacklist({ candidateId: key.candidateId }, input.ctx);
        }
      } catch (err) {
        rcWarn("fetch-extra", "fetch failed for key — continuing without it", {
          key: JSON.stringify(key),
          error: (err as Error).message,
        });
        return [];
      }
    }),
  );

  // Flatten + deduplicate by (objectType, objectId) across all fetch results.
  // Multiple rules may declare the same Application instance — keep one copy.
  const dedup = new Map<string, Instance>();
  for (const list of fetchResults) {
    for (const inst of list) {
      const k = `${inst.objectType}/${inst.objectId}`;
      if (!dedup.has(k)) dedup.set(k, inst);
    }
  }

  // Stable order: sort by objectType, then objectId. Reproducible across calls.
  const sorted = Array.from(dedup.values()).sort((a, b) => {
    if (a.objectType !== b.objectType) return a.objectType.localeCompare(b.objectType);
    return a.objectId.localeCompare(b.objectId);
  });

  rcInfo("fetch-extra", "extra instances prefetched", {
    totalInstances: sorted.length,
    byType: summarizeByType(sorted),
  });

  return sorted;
}

function summarizeByType(instances: Instance[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const inst of instances) {
    out[inst.objectType] = (out[inst.objectType] ?? 0) + 1;
  }
  return out;
}

function subtractMonthsIso(iso: string, months: number): string {
  const d = new Date(iso);
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}
