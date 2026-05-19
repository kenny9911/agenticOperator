/**
 * Single-call orchestrator — MVP pipeline.
 *
 * fetchRule → fetchInstances → buildPrompt → LLM → validate → compute final
 * decision → persist → return.
 *
 * Throws minimally — most error paths translate to a `RuleCheckRun` with
 * `finalDecision.decision = "pending_human"` + overrideReason so the audit
 * record captures the failure. Only true infrastructure problems (no API
 * base, no LLM key) bubble.
 */

import { v7 as uuidv7 } from "uuid";

import { fetchAllRules, selectRule } from "../fetch-rules";
import {
  fetchCandidate,
  fetchJob,
  listApplications,
  listCandidateExpectations,
  listResumes,
} from "../fetch-instances";
import { instancesNeededForRule } from "../rule-instance-map";
import { extractedRulePromptStrategy } from "../prompt";
import { evaluate, LLMUnreachableError } from "../llm-client";
import { runValidation } from "../validation";
import { llmSelfReportedCalculator } from "../confidence";
import { filesystemRunStore } from "../store";
import type {
  CheckRuleInput,
  FetchedData,
  FetchedRule,
  Instance,
  LLMRawResponse,
  RuleCheckRun,
  RuleDecision,
  ValidationReport,
} from "../types";

import type { Orchestrator } from "./index";

const DEFAULT_DOMAIN = "RAAS-v1";

export const singleCallOrchestrator: Orchestrator = {
  name: "single-call",
  async run(input: CheckRuleInput): Promise<RuleCheckRun> {
    const apiBase = input.apiBase ?? process.env["ONTOLOGY_API_BASE"];
    if (!apiBase) {
      throw new Error(
        "Missing ONTOLOGY_API_BASE (set in .env.local or pass via input.apiBase)",
      );
    }
    const apiToken = input.apiToken ?? process.env["ONTOLOGY_API_TOKEN"] ?? "";
    const domain = input.domain ?? DEFAULT_DOMAIN;

    const runId = newRunId();
    const timestamp = nowBeijingIso();
    const currentTime = timestamp; // used in prompt

    // ── Stage 1: fetch rule definition.
    const { rules: allRules } = await fetchAllRules({
      actionRef: input.actionRef,
      domain,
      client: input.scope.client,
      clientDepartment: input.scope.department,
      apiBase,
      apiToken,
      timeoutMs: input.timeoutMs,
    });
    const rule = selectRule(allRules, input.ruleId);

    // ── Stage 2: fetch instances per rule spec.
    const spec = instancesNeededForRule(input.ruleId);
    const ctx = { apiBase, apiToken, domain, timeoutMs: input.timeoutMs };

    const candidate = await fetchCandidate(input.candidateId, ctx);

    let resumes: Instance[] | undefined;
    if (spec.needsResume) {
      resumes = await listResumes(input.candidateId, ctx);
    }

    let expectations: Instance[] | undefined;
    if (spec.needsCandidateExpectation) {
      expectations = await listCandidateExpectations(input.candidateId, ctx);
    }

    let job: Instance | undefined;
    if (spec.needsJob) {
      if (!input.jobRef) {
        throw new Error(
          `Rule ${rule.id} requires a job (jobRef), but none was provided.`,
        );
      }
      job = await fetchJob(input.jobRef, ctx);
    }

    let applications: Instance[] | undefined;
    if (spec.needsApplications) {
      const lookback = spec.needsApplications.lookbackMonths;
      const sinceDate = lookback ? subtractMonthsIso(currentTime, lookback) : undefined;
      applications = await listApplications(
        {
          candidateId: input.candidateId,
          jobRequisitionId: spec.needsApplications.byJob ? input.jobRef : undefined,
          // `byClient` is reserved — client_id on Application FKs the Client table;
          // mapping our scope.client (name) to client_id is out of scope for MVP.
          sinceDate,
        },
        ctx,
      );
      const onlyStatuses = spec.needsApplications.onlyStatuses;
      if (onlyStatuses && onlyStatuses.length > 0) {
        applications = applications.filter((inst) => {
          const s = inst.data["status"];
          return typeof s === "string" && onlyStatuses.includes(s);
        });
      }
    }

    const instances: Instance[] = [candidate];
    if (resumes) instances.push(...resumes);
    if (expectations) instances.push(...expectations);
    if (job) instances.push(job);
    if (applications) instances.push(...applications);

    const fetched: FetchedData = { rule, instances };

    // ── Stage 3: build prompt.
    const { system, user } = extractedRulePromptStrategy.build({
      rule,
      scope: input.scope,
      candidate,
      resumes,
      expectations,
      job,
      applications,
      currentTime,
      actionRef: input.actionRef,
    });
    const promptText = `[system]\n${system}\n\n[user]\n${user}`;

    // ── Stage 4: LLM call.
    let llmRaw: LLMRawResponse;
    let llmRawContent: unknown;
    try {
      const out = await evaluate({
        system,
        user,
        apiKey: input.openaiApiKey,
        baseUrl: input.openaiBaseUrl,
        model: input.llmModel,
      });
      llmRaw = {
        model: out.model,
        response: out.response,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        latencyMs: out.latencyMs,
      };
      llmRawContent = out.contentJson;
    } catch (err) {
      // LLM unreachable / hard failure → persist a pending run, don't throw.
      return persistRunAndReturn({
        runId,
        timestamp,
        input,
        fetched,
        prompt: promptText,
        llmRaw: {
          model: input.llmModel ?? process.env["OPENAI_MODEL"] ?? "unknown",
          response: { error: serializeError(err) },
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
          failures: [
            err instanceof LLMUnreachableError
              ? `llm_unreachable:${err.message}`
              : `llm_unknown_error:${(err as Error).message}`,
          ],
        },
        finalDecision: {
          decision: "pending_human",
          overrideReason: "llm_unreachable",
        },
      });
    }

    // ── Stage 5: validation (deterministic).
    const { report: validation, parsedJudgment } = runValidation({
      llmRawContent,
      fetchedRules: allRules,
      fetchedInstances: instances,
    });

    // ── Stage 6: confidence (MVP: pass-through from LLM).
    if (parsedJudgment) {
      const conf = llmSelfReportedCalculator.calculate({
        llmReportedConfidence: parsedJudgment.confidence,
        evidence: parsedJudgment.evidence,
      });
      parsedJudgment.confidence = conf.value;
    }

    // ── Stage 7: final decision.
    const finalDecision = computeFinalDecision(parsedJudgment, validation);

    // ── Stage 8: persist + return.
    return persistRunAndReturn({
      runId,
      timestamp,
      input,
      fetched,
      prompt: promptText,
      llmRaw,
      llmParsed: parsedJudgment,
      validation,
      finalDecision,
    });
  },
};

// ─── helpers ───

async function persistRunAndReturn(
  partial: Omit<RuleCheckRun, "auditPath">,
): Promise<RuleCheckRun> {
  try {
    const auditPath = await filesystemRunStore.write({ ...partial });
    return { ...partial, auditPath };
  } catch (err) {
    // Storage failure is not fatal — return in-memory run with a note.
    process.stderr.write(
      `[simple-rule-check] filesystem store failed: ${(err as Error).message}\n`,
    );
    return { ...partial };
  }
}

function computeFinalDecision(
  parsed: { decision: RuleDecision } | null,
  validation: ValidationReport,
): RuleCheckRun["finalDecision"] {
  if (!parsed) {
    return {
      decision: "pending_human",
      overrideReason: "llm_output_unparseable: " + validation.failures.join("; "),
    };
  }
  if (validation.overallOk) {
    return { decision: parsed.decision };
  }
  return {
    decision: "pending_human",
    overrideReason: "validation_failed: " + validation.failures.join("; "),
  };
}

function newRunId(): string {
  try {
    return uuidv7();
  } catch {
    // Fallback if v7 unsupported.
    return `r-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** "2026-05-12T10:30:00+08:00" — Asia/Shanghai (UTC+8) wall clock. */
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

function subtractMonthsIso(iso: string, months: number): string {
  const d = new Date(iso);
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

function serializeError(err: unknown): { name: string; message: string; stack?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  return { name: "Unknown", message: String(err) };
}
