"use client";
/**
 * Right-hand preview panel for the Runs aggregate page.
 *
 * Fetches a slim projection of the selected run via `getRunPreview` server
 * action and caches results in a Map to avoid refetch on re-select. Content
 * is a strict subset of audit JSON per SPEC §9.3 D7 + D8 — no
 * reformulation, no LLM re-invocation.
 *
 * Sections (top → bottom):
 *   1. Header: short runId + timestamp
 *   2. Verdict block (DecisionBadge + ConfidenceRing + rule/cand/job/client)
 *   3. 结论 (rootCauseSections.conclusion, 3-line clamp)
 *   4. 关键证据 (top-3 decisive evidence)
 *   5. validation (4-light mini)
 *   6. ★ 候选人主信息 (D8) — Candidate or Resume key fields card
 *   7. ★ 其他 Neo4j Instances (D8) — collapsed list of remaining instances
 *   8. [Open full detail →]
 */

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { Badge, Btn, Card } from "@/components/shared/atoms";
import { DecisionBadge } from "./DecisionBadge";
import { ConfidenceRing } from "./ConfidenceRing";
import { ValidationLight } from "./ValidationLight";
import { getRunPreview, type RunPreview } from "@/app/rule-check/actions";
import { useApp } from "@/lib/i18n";
import type { Instance } from "@/lib/rule-check";

export interface RunsPreviewProps {
  runId: string | undefined;
}

export function RunsPreview({ runId }: RunsPreviewProps) {
  const { t } = useApp();
  const cacheRef = useRef<Map<string, RunPreview>>(new Map());
  const [preview, setPreview] = useState<RunPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setError(null);
    if (!runId) {
      setPreview(null);
      return;
    }
    const cached = cacheRef.current.get(runId);
    if (cached) {
      setPreview(cached);
      return;
    }
    startTransition(async () => {
      const res = await getRunPreview(runId);
      if (!mountedRef.current) return;
      if (res.ok) {
        cacheRef.current.set(runId, res.preview);
        setPreview(res.preview);
      } else {
        setPreview(null);
        setError(res.error);
      }
    });
  }, [runId]);

  if (!runId) {
    return (
      <Card>
        <div className="p-6 text-center text-[12px] text-ink-3">
          Select a run to preview.
        </div>
      </Card>
    );
  }
  if (isPending && !preview) {
    return (
      <Card>
        <div className="p-6 text-center text-[12px] text-ink-3">Loading…</div>
      </Card>
    );
  }
  if (error || !preview) {
    return (
      <Card>
        <div className="p-6 text-center text-[12px] text-err">
          {error ?? "Run not found"}
        </div>
      </Card>
    );
  }

  const candidateMain = pickCandidateMain(preview.fetchedInstances);
  const otherInstances = preview.fetchedInstances.filter(
    (i) =>
      i.objectType !== "Candidate" &&
      i.objectType !== "Resume" &&
      i.objectType !== "Job_Requisition",
  );

  return (
    <Card>
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="font-mono text-[11.5px] text-ink-1">
            {preview.runId.slice(0, 12)}…
          </div>
          <div className="text-[10.5px] text-ink-3">{preview.timestamp}</div>
        </div>

        {preview.finalDecision.overrideReason?.startsWith("short_circuit:") && (
          <div className="rounded border border-warn bg-warn-bg px-3 py-2 text-[11px] text-warn">
            ↯ <strong>Skipped (short-circuit)</strong> — {preview.finalDecision.overrideReason}
          </div>
        )}

        <div className="flex items-center gap-3">
          <DecisionBadge
            value={preview.finalDecision.decision}
            size="md"
            overridden={!!preview.finalDecision.overrideReason}
          />
          {preview.confidence !== null && (
            <ConfidenceRing
              value={preview.confidence}
              size={56}
              label={t("rc_confidence")}
            />
          )}
          <div className="flex-1 flex flex-col gap-0.5 text-[11.5px]">
            <div>
              <span className="text-ink-3">rule</span>{" "}
              <span className="font-mono text-ink-1">
                {preview.input.ruleId}
              </span>{" "}
              <span className="text-ink-2">{preview.ruleName}</span>
            </div>
            <div>
              <span className="text-ink-3">cand</span>{" "}
              <span className="font-mono text-ink-1">
                {preview.input.candidateId}
              </span>
            </div>
            <div>
              <span className="text-ink-3">job</span>{" "}
              <span className="font-mono text-ink-2">
                {preview.input.jobRef ?? "—"}
              </span>
            </div>
            <div>
              <span className="text-ink-3">client</span>{" "}
              <span className="text-ink-2">{preview.input.scope.client}</span>
              {preview.input.scope.department && (
                <span className="text-ink-3"> / {preview.input.scope.department}</span>
              )}
            </div>
          </div>
        </div>

        {preview.conclusionText && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1">
              结论
            </div>
            <div className="text-[12px] text-ink-2 line-clamp-3 whitespace-pre-wrap">
              {preview.conclusionText}
            </div>
          </div>
        )}

        {preview.topDecisiveEvidence.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1">
              关键证据
            </div>
            <ul className="flex flex-col gap-1 text-[11px]">
              {preview.topDecisiveEvidence.map((e, i) => (
                <li key={i} className="font-mono text-ink-2 truncate">
                  · {e.objectType}.{e.objectId}.{e.field}
                  {e.grounded === false && (
                    <Badge variant="err" className="ml-2">
                      ⚠ not grounded
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1">
            validation
          </div>
          <ValidationLight report={preview.validation} variant="mini" />
        </div>

        {candidateMain && (
          <div className="border-t border-line pt-3">
            <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1.5">
              {t("rc_candidate_main_info")}
              <span className="ml-2 font-mono text-ink-4 normal-case tracking-normal">
                {candidateMain.objectType} · {candidateMain.objectId}
              </span>
            </div>
            <CandidateMainCard data={candidateMain.data} />
          </div>
        )}

        {otherInstances.length > 0 && (
          <div className="border-t border-line pt-3">
            <div className="text-[10px] uppercase tracking-wide text-ink-3 mb-1.5">
              {t("rc_other_instances")}
              <span className="ml-2 text-ink-4 normal-case tracking-normal">
                ({otherInstances.length})
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {otherInstances.map((inst, i) => (
                <CollapsibleInstance key={`${inst.objectType}-${inst.objectId}-${i}`} instance={inst} />
              ))}
            </div>
          </div>
        )}

        <div className="pt-2 border-t border-line">
          <Link href={`/rule-check/runs/${preview.runId}`} className="block">
            <Btn variant="primary" size="sm" className="w-full justify-center">
              {t("rc_open_full_detail")} →
            </Btn>
          </Link>
        </div>
      </div>
    </Card>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────

function pickCandidateMain(instances: Instance[]): Instance | null {
  return (
    instances.find((i) => i.objectType === "Candidate") ??
    instances.find((i) => i.objectType === "Resume") ??
    null
  );
}

function CandidateMainCard({ data }: { data: Record<string, unknown> }) {
  const fields = collectMainFields(data);
  if (fields.length === 0) {
    return (
      <div className="text-[11px] text-ink-3 italic">(no key fields)</div>
    );
  }
  return (
    <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-1 text-[11.5px]">
      {fields.map((f, i) => (
        <FieldRow key={i} label={f.label} value={f.value} />
      ))}
    </dl>
  );
}

interface MainField {
  label: string;
  value: React.ReactNode;
}

function collectMainFields(data: Record<string, unknown>): MainField[] {
  const fields: MainField[] = [];
  const pickStr = (key: string): string | null => {
    const v = data[key];
    return typeof v === "string" && v.trim().length > 0 ? v : null;
  };
  const pickNum = (key: string): number | null => {
    const v = data[key];
    return typeof v === "number" ? v : null;
  };

  // Identity
  const name = pickStr("name") ?? pickStr("candidate_name");
  if (name) fields.push({ label: "姓名", value: name });
  const candId = pickStr("candidate_id") ?? pickStr("id");
  if (candId) fields.push({ label: "candidate_id", value: <span className="font-mono">{candId}</span> });

  // Contact
  const email = pickStr("email");
  if (email) fields.push({ label: "email", value: <span className="font-mono">{email}</span> });
  const phone = pickStr("phone") ?? pickStr("phone_number");
  if (phone) fields.push({ label: "phone", value: <span className="font-mono">{phone}</span> });

  // Demographics
  const dob = pickStr("date_of_birth") ?? pickStr("birthday");
  if (dob) fields.push({ label: "出生", value: <span className="font-mono">{dob}</span> });
  const gender = pickStr("gender");
  if (gender) fields.push({ label: "性别", value: gender });
  const age = pickNum("age");
  if (age !== null) fields.push({ label: "年龄", value: String(age) });

  // Education
  const edu = data["highest_education"];
  if (edu && typeof edu === "object" && !Array.isArray(edu)) {
    const e = edu as Record<string, unknown>;
    const school = typeof e.school === "string" ? e.school : null;
    const degree = typeof e.degree === "string" ? e.degree : null;
    const major = typeof e.major === "string" ? e.major : null;
    const summary = [school, degree, major].filter(Boolean).join(" · ");
    if (summary) fields.push({ label: "学历", value: summary });
  }

  // Recent work experience
  const we = data["work_experience"];
  if (Array.isArray(we) && we.length > 0) {
    const first = we[0] as Record<string, unknown>;
    const company = typeof first.company === "string" ? first.company : null;
    const title = typeof first.title === "string" ? first.title : null;
    const start = typeof first.start_date === "string" ? first.start_date : null;
    const end = typeof first.end_date === "string" ? first.end_date : null;
    const summary = [
      company,
      title,
      start && end ? `${start} — ${end}` : start ?? end,
    ]
      .filter(Boolean)
      .join(" · ");
    if (summary) fields.push({ label: "最近经历", value: summary });
  }

  // Skills (truncate)
  const skills = data["skill_tags"];
  if (Array.isArray(skills) && skills.length > 0) {
    const head = skills
      .filter((s): s is string => typeof s === "string")
      .slice(0, 8)
      .join(" · ");
    const more = skills.length > 8 ? ` (+${skills.length - 8} more)` : "";
    if (head) fields.push({ label: "技能", value: head + more });
  }

  return fields;
}

function FieldRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className="text-ink-1 truncate">{value}</dd>
    </>
  );
}

function CollapsibleInstance({ instance }: { instance: Instance }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-line bg-bg">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-2.5 py-1.5 text-[11.5px] hover:bg-panel"
      >
        <span className="font-mono text-ink-2 truncate">
          <span className="text-ink-1">{instance.objectType}</span>
          <span className="text-ink-3 mx-1">·</span>
          {instance.objectId}
        </span>
        <span className="text-ink-3 text-[10px] ml-2">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <pre className="m-0 border-t border-line px-2.5 py-2 font-mono text-[10.5px] text-ink-2 whitespace-pre-wrap break-all max-h-64 overflow-auto">
          {JSON.stringify(instance.data, null, 2)}
        </pre>
      )}
    </div>
  );
}
