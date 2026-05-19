/**
 * Runtime input loader — assembles a `MatchResumeRuntimeInput { job, resume }`
 * from Ontology API fetches. Every fetch is recorded into the run's
 * `ontologyApiTrace[]` so the audit chain is complete.
 *
 * The shape returned here is plugged directly into `generatePrompt()`'s
 * `runtimeInput` parameter, which `fillRuntimeInput` substitutes into the
 * three placeholders: `{{CLIENT}}` / `{{JOB}}` / `{{RESUME}}`.
 */

import type { MatchResumeRuntimeInput } from "../../ontology-gen/v4/runtime-adapters/match-resume";
import { rcDebug, rcInfo } from "../debug";
import { fetchJob, listResumes, type FetchInstanceCtx } from "../fetch-instances";

export interface LoadMatchResumeRuntimeInputOptions {
  candidateId: string;
  jobRef: string;
  ctx: FetchInstanceCtx;
}

/**
 * Loads `MatchResumeRuntimeInput` by fetching:
 *   - Job_Requisition by jobRef → goes into `job`
 *   - Resume list filtered by candidateId → pick latest → goes into `resume`
 *
 * If no Resume exists for the candidate, throws — the matchResume action
 * fundamentally needs a resume to evaluate.
 */
export async function loadMatchResumeRuntimeInput(
  opts: LoadMatchResumeRuntimeInputOptions,
): Promise<MatchResumeRuntimeInput> {
  rcDebug("runtime-input", "fetching job + resumes", {
    jobRef: opts.jobRef,
    candidateId: opts.candidateId,
  });
  const [jobInst, resumeList] = await Promise.all([
    fetchJob(opts.jobRef, opts.ctx),
    listResumes(opts.candidateId, opts.ctx),
  ]);

  if (resumeList.length === 0) {
    throw new Error(
      `loadMatchResumeRuntimeInput: candidate ${opts.candidateId} has no Resume record`,
    );
  }

  // Pick latest resume by `update_timestamp` if present, else first.
  const resume = pickLatestResume(resumeList);
  rcInfo("runtime-input", "selected resume", {
    candidateId: opts.candidateId,
    totalResumes: resumeList.length,
    selectedResumeId: resume.data?.["resume_id"],
    selectedUpdate: resume.data?.["update_timestamp"],
    jobId: jobInst.objectId,
  });

  return {
    job: {
      job_requisition_id: jobInst.objectId,
      ...jobInst.data,
    },
    resume: {
      candidate_id: opts.candidateId,
      ...resume.data,
    },
  };
}

function pickLatestResume(list: Array<{ data: Record<string, unknown> }>): {
  data: Record<string, unknown>;
} {
  if (list.length === 1) return list[0]!;
  // Sort by `update_timestamp` desc when present; fall back to original order.
  const sorted = [...list].sort((a, b) => {
    const ta = parseTimestamp(a.data["update_timestamp"]);
    const tb = parseTimestamp(b.data["update_timestamp"]);
    return tb - ta;
  });
  return sorted[0]!;
}

function parseTimestamp(v: unknown): number {
  if (typeof v !== "string" && typeof v !== "number") return 0;
  const t = new Date(v as string | number).getTime();
  return Number.isFinite(t) ? t : 0;
}
