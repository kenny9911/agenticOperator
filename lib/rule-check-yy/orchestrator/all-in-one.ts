/**
 * AllInOneOrchestrator — Full impl pipeline (Path C locked 2026-05-13).
 *
 * Per-step sequential LLM calls with short-circuit on red-line. Replaces the
 * Path B "one envelope per run" approach because kimi-k2.6 via new-api proxy
 * 504s on the full-envelope output (~10-15K tokens × ~10ms/tok = ~150s).
 *
 * Stage order:
 *   A. fetchAllRules (filter by ruleIds)
 *   B. loadMatchResumeRuntimeInput → { job, resume }   (traced)
 *   C. fetchExtraInstancesForRules(activeRules)        (含义 A1 prefetch, traced)
 *   D. groupRulesByStep — only steps with rules.length > 0 are iterated
 *      (tool-only steps like generateMatchResult are naturally skipped)
 *   E. Per-step sequential loop:
 *        for each step:
 *          if shortCircuited → synthesize not_started rule_judgments, mark step skipped
 *          else: build slim prompt → evaluate (StepResultJsonSchema) → parse →
 *                per-judgment validation + composite confidence → results.push
 *                check short-circuit trigger (canBlock !== false ∧ decision=blocked)
 *   F. aggregateDecision (existing) + terminal/terminalAtStep (deterministic)
 *   G. persist via filesystemRunStore (writeRun × N + writeBatch)
 *
 * Semantics locked this session:
 *   - LLM judges per-rule `decision`; code does cascade aggregate (B1), flow
 *     control short-circuit (B3), synthesized `not_started` for skipped rules.
 *   - No LLM-claimed `final_output` (notifications / terminal / aggregate);
 *     dropped in v1 per SPEC §15 (2026-05-13).
 *
 * v3.1 update (2026-05-13, SPEC §15):
 *   `computeFinalDecision` now ONLY overrides on `parsed === null` (LLM
 *   output unparseable). All other validation flags are informational; LLM's
 *   decision is honored verbatim even if `ruleIdExists` / `schemaValid` /
 *   `blockSemanticCheck` / `evidenceGrounded` fail. Validation failures are
 *   still persisted to `validation.failures[]` for audit traceability.
 */

import { v7 as uuidv7 } from "uuid";

import { aggregateDecision } from "../aggregate-decision";
import { compositeCalculator } from "../confidence";
import { rcDebug, rcInfo, rcStopwatch, rcWarn, shortSha } from "../debug";
import { fetchAllRules } from "../fetch-rules";
import { fetchExtraInstancesForRules } from "../fetch-extra-instances";
import { evaluate, LLMUnreachableError } from "../llm-client";
import { StepResultJsonSchema, StepResultSchema } from "../output-schema-audited";
import { buildEvalPrompt } from "../prompt/build";
import { loadMatchResumeRuntimeInput } from "../prompt/runtime-input-loader";
import { filesystemRunStore } from "../store";
import type { TraceCtx } from "../store/ontology-trace-recorder";
import { runValidationAudited } from "../validation";
import type {
  CheckRulesInput,
  FetchedRuleClassified,
  Instance,
  LLMRawResponse,
  RuleDecision,
} from "../types";
import type {
  OntologyApiTraceEntry,
  PromptProvenance,
  RuleCheckBatchRunAudited,
  RuleCheckRunAudited,
  RuleJudgmentAudited,
  StepCallRecord,
} from "../types-audited";

import type { Orchestrator } from "./index";

const DEFAULT_DOMAIN = "RAAS-v1";

interface ShortCircuitState {
  stepOrder: number;
  byRuleId: string;
}

export const allInOneOrchestrator: Orchestrator = {
  name: "all-in-one",
  async run(input: CheckRulesInput): Promise<RuleCheckBatchRunAudited> {
    const apiBase = input.apiBase ?? process.env["ONTOLOGY_API_BASE"];
    if (!apiBase) {
      throw new Error(
        "Missing ONTOLOGY_API_BASE (set in .env.local or pass via input.apiBase)",
      );
    }
    const apiToken = input.apiToken ?? process.env["ONTOLOGY_API_TOKEN"] ?? "";
    const domain = input.domain ?? DEFAULT_DOMAIN;
    const batchId = uuidv7();
    const timestamp = nowBeijingIso();
    const ontologyApiTrace: OntologyApiTraceEntry[] = [];
    const traceCtx: TraceCtx = { trace: ontologyApiTrace };
    const overallTimer = rcStopwatch();

    rcInfo("orchestrator", "batch begin", {
      batchId,
      actionRef: input.actionRef,
      candidate: input.candidateId,
      jobRef: input.jobRef,
      client: input.scope?.client,
      department: input.scope?.department,
      domain,
      ruleIds: input.ruleIds ?? "(all)",
      model: input.llmModel ?? process.env["OPENAI_MODEL"] ?? "(env default)",
      apiBase,
    });

    if (!input.candidateId) {
      throw new Error("AllInOneOrchestrator: input.candidateId is required");
    }
    if (!input.jobRef) {
      throw new Error(
        "AllInOneOrchestrator: input.jobRef is required (matchResume needs a job to evaluate against)",
      );
    }

    // ── Stage A: fetch all rules (with classification metadata).
    const tA = rcStopwatch();
    const { rules: allRules } = await fetchAllRules({
      actionRef: input.actionRef,
      domain,
      client: input.scope.client,
      clientDepartment: input.scope.department,
      apiBase,
      apiToken,
      timeoutMs: input.timeoutMs,
    });
    const targetRuleIds = input.ruleIds && input.ruleIds.length > 0
      ? new Set(input.ruleIds)
      : null;
    const activeRules = targetRuleIds
      ? allRules.filter((r) => targetRuleIds.has(r.id))
      : allRules;
    rcInfo("orchestrator", "stage A rules fetched", {
      total: allRules.length,
      active: activeRules.length,
      blockerRules: activeRules.filter((r) => r.canBlock === true).length,
      advisoryRules: activeRules.filter((r) => r.canBlock === false).length,
      unclassifiedRules: activeRules.filter((r) => r.canBlock === undefined).length,
      tookMs: tA(),
    });
    rcDebug("orchestrator", "active rule ids", { ids: activeRules.map((r) => r.id) });

    // ── Stage B: load matchResume runtime input (Job + Resume).
    const tB = rcStopwatch();
    const fetchCtx = {
      apiBase,
      apiToken,
      domain,
      timeoutMs: input.timeoutMs,
      traceCtx,
    };
    const runtimeInput = await loadMatchResumeRuntimeInput({
      candidateId: input.candidateId,
      jobRef: input.jobRef,
      ctx: fetchCtx,
    });
    rcInfo("orchestrator", "stage B runtime input loaded", {
      jobId: runtimeInput.job?.["job_requisition_id"],
      jobTitle: runtimeInput.job?.["title"] ?? runtimeInput.job?.["job_title"],
      candidateId: runtimeInput.resume?.["candidate_id"],
      resumeId: runtimeInput.resume?.["resume_id"],
      ontologyCalls: ontologyApiTrace.length,
      tookMs: tB(),
    });

    // ── Stage C: prefetch per-rule extra instances (含义 A1).
    const tC = rcStopwatch();
    const extraInstances = await fetchExtraInstancesForRules({
      activeRules,
      ctx: fetchCtx,
      jobRef: input.jobRef,
      candidateId: input.candidateId,
      currentTimeIso: timestamp,
    });
    rcInfo("orchestrator", "stage C extra instances prefetched", {
      extras: extraInstances.length,
      ontologyCalls: ontologyApiTrace.length,
      tookMs: tC(),
    });

    // Canonical fetchedInstances ordering for fetchedInstanceIndex:
    //   position 0 = Job, position 1 = Resume, positions 2..N = extraInstances
    // Mirrors `assemble-v4-4.ts:renderExtraInstances()` numbering.
    const fetchedInstances: Instance[] = [
      buildInstanceFromRuntimeJob(runtimeInput.job),
      buildInstanceFromRuntimeResume(runtimeInput.resume),
      ...extraInstances,
    ];

    // ── Stage D: group active rules by stepOrder (skip steps with 0 rules).
    const groupedSteps = groupRulesByStep(activeRules);
    rcInfo("orchestrator", "stage D rules grouped", {
      stepCount: groupedSteps.length,
      perStep: groupedSteps.map(([order, rs]) => `step_${order}:${rs.length}`).join(" "),
    });

    // ── Stage E: per-step sequential loop with short-circuit.
    const stepCalls: StepCallRecord[] = [];
    const results: RuleCheckRunAudited[] = [];
    let shortCircuitedAt: ShortCircuitState | null = null;

    const llmModel = input.llmModel ?? process.env["OPENAI_MODEL"] ?? "unknown";

    for (const [stepOrder, stepRules] of groupedSteps) {
      const stepKey = `step_${stepOrder}`;

      // ── Skipped step path (a previous step already triggered short-circuit).
      if (shortCircuitedAt) {
        for (const rule of stepRules) {
          results.push(
            buildSyntheticSkippedRun({
              rule,
              shortCircuitedAt,
              input,
              batchId,
              timestamp,
              ontologyApiTrace,
              fetchedInstances,
              llmModel,
            }),
          );
        }
        stepCalls.push({
          stepOrder,
          stepKey,
          shortCircuited: true,
          startedAt: null,
          llmRaw: null,
          promptProvenance: null,
        });
        rcInfo("orchestrator", "step skipped (short-circuit)", {
          step: stepKey,
          synthesizedRules: stepRules.length,
          shortCircuitedBy: `step_${shortCircuitedAt.stepOrder}/rule_${shortCircuitedAt.byRuleId}`,
        });
        continue;
      }

      // ── Live step path.
      const tStep = rcStopwatch();
      const stepStartedAt = nowBeijingIso();
      rcInfo("orchestrator", "stage E step begin", {
        step: stepKey,
        rules: stepRules.length,
      });

      const built = await buildEvalPrompt({
        actionRef: input.actionRef,
        client: input.scope.client,
        clientDepartment: input.scope.department,
        domain,
        runtimeInput,
        extraInstances: extraInstances.map((inst) => ({
          objectType: inst.objectType,
          objectId: inst.objectId,
          data: inst.data,
        })),
        apiBase,
        apiToken,
        timeoutMs: input.timeoutMs,
        focusStep: stepOrder,
      });
      const promptProvenance = built.provenance;
      const fullPrompt = `[system]\n${built.system}\n\n[user]\n${built.user}`;
      rcDebug("orchestrator", "step prompt built", {
        step: stepKey,
        systemChars: built.system.length,
        userChars: built.user.length,
        promptSha: shortSha(promptProvenance.promptSha256),
      });

      let llmRaw: LLMRawResponse;
      let rawContent: unknown;
      let logprobs;
      try {
        const out = await evaluate({
          system: built.system,
          user: built.user,
          apiKey: input.openaiApiKey,
          baseUrl: input.openaiBaseUrl,
          model: input.llmModel,
          jsonSchema: StepResultJsonSchema as unknown as object,
          schemaName: `StepResult_${stepKey}`,
        });
        llmRaw = {
          model: out.model,
          response: out.response,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
          latencyMs: out.latencyMs,
        };
        rawContent = out.contentJson;
        logprobs = out.logprobs;
        rcInfo("orchestrator", "stage E step LLM ok", {
          step: stepKey,
          model: out.model,
          inTokens: out.inputTokens,
          outTokens: out.outputTokens,
          latencyMs: out.latencyMs,
          logprobsAvailable: logprobs ? logprobs.length : 0,
          tookMs: tStep(),
        });
      } catch (err) {
        const errMsg = err instanceof LLMUnreachableError
          ? `llm_unreachable:${err.message}`
          : `llm_unknown_error:${(err as Error).message}`;
        rcWarn("orchestrator", "stage E step LLM FAILED", {
          step: stepKey,
          error: (err as Error).message,
          tookMs: tStep(),
        });
        for (const rule of stepRules) {
          results.push(
            buildFallbackRun({
              rule,
              input,
              batchId,
              timestamp,
              fullPrompt,
              promptProvenance,
              ontologyApiTrace,
              errMsg,
              llmModel,
              fetchedInstances,
            }),
          );
        }
        // Record the failed step call (no llmRaw — call didn't yield a usable response)
        stepCalls.push({
          stepOrder,
          stepKey,
          shortCircuited: false,
          startedAt: stepStartedAt,
          llmRaw: {
            model: llmModel,
            response: { error: errMsg },
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 0,
          },
          promptProvenance,
        });
        // LLM unreachable inside a step: continue to the next step rather than aborting
        // (other steps may still produce useful judgments). No short-circuit fired.
        continue;
      }

      // ── Parse the per-step envelope: { rule_judgments[] }
      const parsed = StepResultSchema.safeParse(rawContent);
      if (!parsed.success) {
        const errMsg = `envelope_invalid:${parsed.error.message}`;
        rcWarn("orchestrator", "stage E step envelope parse failed", {
          step: stepKey,
          error: parsed.error.message.slice(0, 200),
        });
        for (const rule of stepRules) {
          results.push(
            buildFallbackRun({
              rule,
              input,
              batchId,
              timestamp,
              fullPrompt,
              promptProvenance,
              ontologyApiTrace,
              errMsg,
              llmModel,
              fetchedInstances,
            }),
          );
        }
        stepCalls.push({
          stepOrder,
          stepKey,
          shortCircuited: false,
          startedAt: stepStartedAt,
          llmRaw,
          promptProvenance,
        });
        continue;
      }

      // ── Per-judgment validate + composite confidence + build per-rule run.
      for (let idx = 0; idx < parsed.data.rule_judgments.length; idx++) {
        const rj = parsed.data.rule_judgments[idx]!;
        const claimedRuleId = (rj as { ruleId?: string }).ruleId ?? "";
        const ruleClassified = stepRules.find((r) => r.id === claimedRuleId)
          ?? activeRules.find((r) => r.id === claimedRuleId);

        const valOut = runValidationAudited({
          rawJudgment: rj,
          ruleClassified,
          fetchedInstances,
          fetchedRules: allRules,
        });

        const parsedJudgment: RuleJudgmentAudited | null = valOut.parsedJudgment;
        const confidenceOut = parsedJudgment
          ? compositeCalculator.calculate({
              llmReportedConfidence: parsedJudgment.confidence,
              evidence: parsedJudgment.evidence,
              logprobs: logprobs ?? null,
            })
          : null;
        if (parsedJudgment && confidenceOut) {
          parsedJudgment.confidence = confidenceOut.value;
        }

        const finalDecision = computeFinalDecision(parsedJudgment, valOut.report);
        const ruleId = parsedJudgment?.ruleId ?? claimedRuleId;
        const v = valOut.report;
        const lights = `${v.ruleIdExists ? "✓" : "✗"}${v.evidenceGrounded ? "✓" : "✗"}${v.schemaValid ? "✓" : "✗"}${v.blockSemanticCheck === "ok" ? "✓" : v.blockSemanticCheck === "warning" ? "⚠" : "–"}`;
        rcInfo("orchestrator", "judgment", {
          step: stepKey,
          idxInStep: idx,
          ruleId,
          llmDecision: parsedJudgment?.decision ?? "(unparsed)",
          finalDecision: finalDecision.decision,
          validation: lights,
          evidence: parsedJudgment?.evidence?.length ?? 0,
          confidence: confidenceOut ? `${(confidenceOut.value * 100).toFixed(0)}%` : "—",
          confSource: confidenceOut?.breakdown.source ?? "—",
        });

        const run: RuleCheckRunAudited = {
          runId: uuidv7(),
          batchId,
          timestamp,
          input: { ...input, ruleId },
          fetched: {
            rule: ruleClassified
              ? {
                  id: ruleClassified.id,
                  name: ruleClassified.name,
                  sourceText: ruleClassified.sourceText,
                  stepOrder: ruleClassified.stepOrder,
                  applicableScope: ruleClassified.applicableScope,
                }
              : {
                  id: ruleId,
                  name: ruleId,
                  sourceText: "(rule not found in fetched set)",
                  stepOrder,
                  applicableScope: "unknown",
                },
            instances: fetchedInstances,
          },
          prompt: fullPrompt,
          promptProvenance,
          ontologyApiTrace,
          llmRaw,
          llmParsed: parsedJudgment,
          validation: valOut.report,
          confidenceBreakdown: confidenceOut?.breakdown ?? {
            evidenceCountFactor: 0,
            consistencyFactor: 0,
            logprobScore: null,
            source: "composite_degraded",
          },
          finalDecision,
        };
        results.push(run);
      }

      stepCalls.push({
        stepOrder,
        stepKey,
        shortCircuited: false,
        startedAt: stepStartedAt,
        llmRaw,
        promptProvenance,
      });

      // ── Short-circuit check (Path C): canBlock !== false ∧ decision=blocked.
      const trigger = parsed.data.rule_judgments.find((rj) => {
        const rule = stepRules.find((r) => r.id === rj.ruleId);
        return rule && rule.canBlock !== false && rj.decision === "blocked";
      });
      if (trigger) {
        shortCircuitedAt = { stepOrder, byRuleId: trigger.ruleId };
        stepCalls[stepCalls.length - 1]!.triggeredShortCircuit = {
          byRuleId: trigger.ruleId,
          reason: "canBlock+blocked",
        };
        rcInfo("orchestrator", "short-circuit triggered", {
          step: stepKey,
          byRuleId: trigger.ruleId,
        });
      }
    }

    // ── Stage F: deterministic aggregate + terminal fields.
    const baseAggregate = aggregateDecision(
      results.map((r) => ({
        ruleId: r.input.ruleId,
        decision: r.finalDecision.decision,
      })),
    );
    const aggregate = {
      ...baseAggregate,
      terminal: shortCircuitedAt !== null,
      ...(shortCircuitedAt ? { terminalAtStep: shortCircuitedAt.stepOrder } : {}),
    };
    rcInfo("orchestrator", "stage F aggregate decision", {
      decision: aggregate.decision,
      terminal: aggregate.terminal,
      terminalAtStep: shortCircuitedAt?.stepOrder,
      triggeredRules: aggregate.triggeredRules,
    });

    const batch: RuleCheckBatchRunAudited = {
      batchId,
      timestamp,
      input,
      results,
      aggregateDecision: aggregate,
      stepCalls,
      ontologyApiTrace,
    };

    // ── Stage G: persist.
    const persisted = await persistBatch(batch);
    rcInfo("orchestrator", "batch end", {
      batchId,
      aggregate: persisted.aggregateDecision.decision,
      terminal: persisted.aggregateDecision.terminal,
      results: persisted.results.length,
      stepCalls: stepCalls.length,
      ontologyCalls: ontologyApiTrace.length,
      auditPath: persisted.auditPath,
      tookMs: overallTimer(),
    });
    return persisted;
  },
};

// ─── helpers ───

async function persistBatch(
  batch: RuleCheckBatchRunAudited,
): Promise<RuleCheckBatchRunAudited> {
  const t = rcStopwatch();
  try {
    for (const run of batch.results) {
      const auditPath = await filesystemRunStore.writeRun(run);
      run.auditPath = auditPath;
    }
    const batchPath = await filesystemRunStore.writeBatch(batch);
    batch.auditPath = batchPath;
    rcInfo("store", "persisted batch", {
      batchId: batch.batchId,
      runs: batch.results.length,
      batchPath,
      tookMs: t(),
    });
  } catch (err) {
    rcWarn("store", "filesystem store failed", {
      error: (err as Error).message,
    });
  }
  return batch;
}

function groupRulesByStep(
  rules: FetchedRuleClassified[],
): Array<[number, FetchedRuleClassified[]]> {
  const map = new Map<number, FetchedRuleClassified[]>();
  for (const rule of rules) {
    const bucket = map.get(rule.stepOrder) ?? [];
    bucket.push(rule);
    map.set(rule.stepOrder, bucket);
  }
  return Array.from(map.entries())
    .filter(([, rs]) => rs.length > 0)
    .sort((a, b) => a[0] - b[0]);
}

function buildSyntheticSkippedRun(opts: {
  rule: FetchedRuleClassified;
  shortCircuitedAt: ShortCircuitState;
  input: CheckRulesInput;
  batchId: string;
  timestamp: string;
  ontologyApiTrace: OntologyApiTraceEntry[];
  fetchedInstances: Instance[];
  llmModel: string;
}): RuleCheckRunAudited {
  const reason = `short_circuit:step_${opts.shortCircuitedAt.stepOrder}:rule_${opts.shortCircuitedAt.byRuleId}`;
  return {
    runId: uuidv7(),
    batchId: opts.batchId,
    timestamp: opts.timestamp,
    input: { ...opts.input, ruleId: opts.rule.id },
    fetched: {
      rule: {
        id: opts.rule.id,
        name: opts.rule.name,
        sourceText: opts.rule.sourceText,
        stepOrder: opts.rule.stepOrder,
        applicableScope: opts.rule.applicableScope,
      },
      instances: opts.fetchedInstances,
    },
    prompt: "",
    promptProvenance: {
      promptSha256: "",
      actionObjectSha256: "",
      generatePromptInput: {
        actionRef: opts.input.actionRef,
        client: opts.input.scope.client,
        clientDepartment: opts.input.scope.department,
        domain: opts.input.domain ?? DEFAULT_DOMAIN,
        runtimeInputDigest: "",
      },
      resolvedAt: opts.timestamp,
    },
    ontologyApiTrace: opts.ontologyApiTrace,
    llmRaw: {
      model: opts.llmModel,
      response: { skipped: reason },
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    },
    llmParsed: null,
    validation: {
      ruleIdExists: true,
      evidenceGrounded: false,
      schemaValid: false,
      blockSemanticCheck: "skipped",
      overallOk: false,
      failures: [`short_circuit_by_step_${opts.shortCircuitedAt.stepOrder}_rule_${opts.shortCircuitedAt.byRuleId}`],
    },
    confidenceBreakdown: {
      evidenceCountFactor: 0,
      consistencyFactor: 0,
      logprobScore: null,
      source: "composite_degraded",
    },
    finalDecision: {
      decision: "not_started",
      overrideReason: reason,
    },
  };
}

function buildFallbackRun(opts: {
  rule: FetchedRuleClassified;
  input: CheckRulesInput;
  batchId: string;
  timestamp: string;
  fullPrompt: string;
  promptProvenance: PromptProvenance;
  ontologyApiTrace: OntologyApiTraceEntry[];
  errMsg: string;
  llmModel: string;
  fetchedInstances: Instance[];
}): RuleCheckRunAudited {
  return {
    runId: uuidv7(),
    batchId: opts.batchId,
    timestamp: opts.timestamp,
    input: { ...opts.input, ruleId: opts.rule.id },
    fetched: {
      rule: {
        id: opts.rule.id,
        name: opts.rule.name,
        sourceText: opts.rule.sourceText,
        stepOrder: opts.rule.stepOrder,
        applicableScope: opts.rule.applicableScope,
      },
      instances: opts.fetchedInstances,
    },
    prompt: opts.fullPrompt,
    promptProvenance: opts.promptProvenance,
    ontologyApiTrace: opts.ontologyApiTrace,
    llmRaw: {
      model: opts.llmModel,
      response: { error: opts.errMsg },
      inputTokens: 0,
      outputTokens: 0,
      latencyMs: 0,
    },
    llmParsed: null,
    validation: {
      ruleIdExists: false,
      evidenceGrounded: false,
      schemaValid: false,
      blockSemanticCheck: "skipped",
      overallOk: false,
      failures: [opts.errMsg],
    },
    confidenceBreakdown: {
      evidenceCountFactor: 0,
      consistencyFactor: 0,
      logprobScore: null,
      source: "composite_degraded",
    },
    finalDecision: {
      decision: "pending_human",
      overrideReason: opts.errMsg,
    },
  };
}

/**
 * v3.1 (locked 2026-05-13, SPEC §15): validation results are informational
 * only. The ONLY code-side override is the degenerate `parsed === null` case
 * (LLM output failed Zod schema → no decision exists to honor; pending_human
 * is the only sensible fallback). All other validation flags
 * (ruleIdExists / schemaValid per-field / blockSemanticCheck warning /
 * evidenceGrounded) are persisted to `validation.failures[]` for audit but
 * do NOT override `finalDecision`. Code does not replace the LLM as judge.
 */
function computeFinalDecision(
  parsed: RuleJudgmentAudited | null,
  validation: { overallOk: boolean; failures: string[] },
): RuleCheckRunAudited["finalDecision"] {
  if (!parsed) {
    return {
      decision: "pending_human",
      overrideReason: "llm_output_unparseable: " + validation.failures.join("; "),
    };
  }
  // Honor LLM's decision regardless of validation outcome. Failures are
  // surfaced in `validation.failures[]` (audit) and `validation.*Ok` flags
  // (UI L6 ValidationLight strip) — but never flip the decision.
  return { decision: parsed.decision };
}

function buildInstanceFromRuntimeJob(job: Record<string, unknown>): Instance {
  return {
    objectType: "Job_Requisition",
    objectId: String(job["job_requisition_id"] ?? ""),
    data: { ...job },
  };
}

function buildInstanceFromRuntimeResume(resume: Record<string, unknown>): Instance {
  return {
    objectType: "Resume",
    objectId: String(resume["resume_id"] ?? resume["candidate_id"] ?? ""),
    data: { ...resume },
  };
}

function nowBeijingIso(): string {
  const now = new Date();
  const utcMillis = now.getTime() + now.getTimezoneOffset() * 60_000;
  const beijing = new Date(utcMillis + 8 * 60 * 60_000);
  const y = beijing.getUTCFullYear();
  const m = String(beijing.getUTCMonth() + 1).padStart(2, "0");
  const d = String(beijing.getUTCDate()).padStart(2, "0");
  const hh = String(beijing.getUTCHours()).padStart(2, "0");
  const mm = String(beijing.getUTCMinutes()).padStart(2, "0");
  const ss = String(beijing.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}T${hh}:${mm}:${ss}+08:00`;
}
