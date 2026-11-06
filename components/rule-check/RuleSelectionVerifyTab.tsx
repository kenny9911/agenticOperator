"use client";
import React from "react";
import { Btn, Badge } from "@/components/shared/atoms";
import { Ic } from "@/components/shared/Ic";
import { RuleDefinitionPanel } from "@/components/rule-check/RuleDefinitionPanel";
import { CandidateProfileCard } from "@/components/rule-check/CandidateProfileCard";
import { buildRuleDisplayModel, type RuleDisplayRow } from "@/lib/rule-check/rule-display-model";
import { verdictLabel } from "@/components/rule-check/verdict-label";
import { fetchJson } from "@/lib/api/client";
import { useApp } from "@/lib/i18n";
import type { RuleCheckAuditDetail } from "@/app/api/rule-check-audits/[auditId]/route";
import type { RuleCheckVerifyResponse } from "@/app/api/rule-check-audits/[auditId]/verify/route";
import type {
  RuleSelectionVerification,
  VerifierVerdict,
  SecondVerdict,
  RuleOpinion,
} from "@/lib/rule-check/verify-prompt";

const SERIF = 'ui-serif, Charter, "Iowan Old Style", Palatino, "Times New Roman", serif';

type Status = "idle" | "running" | "error";
// 'not_applicable' = deterministic rule-check (no LLM to cross-validate) — shown
// as a neutral info panel, not a red error.
type VerifyError = { kind: "gateway" | "parse" | "llm" | "generic" | "not_applicable"; msg: string };

export type VerifyState = {
  status: Status;
  stage: number;
  error: VerifyError | null;
  result: RuleSelectionVerification | null;
  primaryModel: string | null;
  verifierModel: string | null;
  durationMs: number | null;
  /** bumps per successful run so result blocks remount → gauge/bars re-animate. */
  runId: number;
  rerun: () => void;
};

/**
 * Owns the cross-validation fetch lifecycle. Lifted to the drawer Body so the
 * 「规则筛选」(selection-only) and 「规则判断」(full) tabs share ONE LLM call.
 * Auto-runs once when `enabled` (the audit finished loading); resets per auditId.
 */
export function useVerifyRun(auditId: string, enabled: boolean): VerifyState {
  const { t } = useApp();
  const [status, setStatus] = React.useState<Status>("idle");
  const [error, setError] = React.useState<VerifyError | null>(null);
  const [stage, setStage] = React.useState(0);
  const [runId, setRunId] = React.useState(0);
  const [ok, setOk] = React.useState<{
    verification: RuleSelectionVerification;
    primary_model: string;
    verifier_model: string;
    duration_ms: number;
  } | null>(null);
  const stageTimer = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const ran = React.useRef(false);

  const stopStageTimer = React.useCallback(() => {
    if (stageTimer.current) {
      clearInterval(stageTimer.current);
      stageTimer.current = null;
    }
  }, []);
  React.useEffect(() => stopStageTimer, [stopStageTimer]);

  const run = React.useCallback(async () => {
    setStatus("running");
    setError(null);
    setStage(0);
    stopStageTimer();
    // Fake-progress the 3 stages — a single fetch gives no real progress, but
    // the staged reveal communicates what's happening (load → judge → score).
    let s = 0;
    stageTimer.current = setInterval(() => {
      s = Math.min(2, s + 1);
      setStage(s);
    }, 1100);
    try {
      const r = await fetchJson<RuleCheckVerifyResponse>(
        `/api/rule-check-audits/${encodeURIComponent(auditId)}/verify`,
        { method: "POST", timeoutMs: 120_000 },
      );
      stopStageTimer();
      if (r.ok) {
        setOk({
          verification: r.verification,
          primary_model: r.primary_model,
          verifier_model: r.verifier_model,
          duration_ms: r.duration_ms,
        });
        setRunId((x) => x + 1);
        setStatus("idle");
      } else {
        setError(mapReason(r.reason, r.error, t));
        setStatus("error");
      }
    } catch (e) {
      stopStageTimer();
      setError({ kind: "generic", msg: (e as { message?: string })?.message ?? t("rc_verify_err_generic") });
      setStatus("error");
    }
  }, [auditId, stopStageTimer, t]);

  // Reset when the audit changes.
  React.useEffect(() => {
    ran.current = false;
    setOk(null);
    setStatus("idle");
    setError(null);
    setStage(0);
  }, [auditId]);

  // Auto-run once the audit is loaded and there's no result yet.
  React.useEffect(() => {
    if (!enabled || ran.current || ok) return;
    ran.current = true;
    void run();
  }, [enabled, ok, run]);

  return {
    status,
    stage,
    error,
    result: ok?.verification ?? null,
    primaryModel: ok?.primary_model ?? null,
    verifierModel: ok?.verifier_model ?? null,
    durationMs: ok?.duration_ms ?? null,
    runId,
    rerun: run,
  };
}

/**
 * 规则判断 tab — 全量复核:候选人/岗位画像 + 适配规则(含 PASS/FAIL + next_action +
 * 第二模型逐条验证)+ 整体置信度。总结了所有(含前面规则筛选的内容)。
 */
export function RuleJudgmentTab({ detail, verify }: { detail: RuleCheckAuditDetail; verify: VerifyState }) {
  const validation =
    verify.status === "error" && verify.error ? (
      <ErrorState error={verify.error} onRetry={verify.rerun} />
    ) : verify.result ? (
      <ResultView
        key={verify.runId}
        v={verify.result}
        primaryModel={verify.primaryModel ?? ""}
        verifierModel={verify.verifierModel ?? ""}
        durationMs={verify.durationMs ?? 0}
        onRerun={verify.rerun}
      />
    ) : (
      <RunningState stage={verify.stage} />
    );
  // 确定性族(查重/归属/能源):不套 matchResume 的「适配规则:过滤→选中→注入提示词」,
  // 改用判定阶梯/结论版式。二次验证(交叉复核)仍保留。
  if (detail.deterministic) {
    return (
      <div className="flex flex-col" style={{ gap: 16 }}>
        <DeterministicRules detail={detail} mode="judgment" />
        {validation}
      </div>
    );
  }
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      {/* Deterministic ontology audits (energy / 费控) have no candidate — skip the
          recruitment profile card so the tab isn't dominated by an empty panel. */}
      {!detail.deterministic && <CandidateProfileCard detail={detail} />}
      <AdaptedRules mode="full" detail={detail} verification={verify.result} verifying={verify.status === "running"} />
      {validation}
    </div>
  );
}

/**
 * 规则筛选 tab — 流程第一步:根据 (client × bg × executor) 筛选出适用规则,大模型
 * 再独立判断「这条该不该选 / 为什么选对了」。**不做 PASS/FAIL 判断**(那在规则判断 tab)。
 */
export function RuleSelectionTab({ detail, verify }: { detail: RuleCheckAuditDetail; verify: VerifyState }) {
  // 确定性族:用 DeterministicRules,不显示「规则库→过滤→选中→注入提示词」那套语义。
  if (detail.deterministic) {
    return (
      <div className="flex flex-col" style={{ gap: 16 }}>
        <DeterministicRules detail={detail} mode="selection" />
      </div>
    );
  }
  return (
    <div className="flex flex-col" style={{ gap: 16 }}>
      {!detail.deterministic && <CandidateProfileCard detail={detail} />}
      <AdaptedRules mode="selection" detail={detail} verification={verify.result} verifying={verify.status === "running"} />
      <SelectionSummary verify={verify} />
    </div>
  );
}

/** 确定性 rule-check(查重 9-15 / 归属 / 能源)的规则面板 —— 不套 matchResume 的
 *  「规则库→过滤→选中→注入用户提示词」(确定性引擎判、规则恒纳入)。展示:模式说明 +
 *  (查重时)三级判定阶梯 + 关联候选人;每条规则 = 结论徽章 + 纳入依据 + 原规则定义。 */
function DeterministicRules({
  detail,
  mode,
}: {
  detail: RuleCheckAuditDetail;
  /** selection=「规则筛选」(为什么选了这条规则);judgment=「规则判断」(候选人×规则的匹配/违反检查)。 */
  mode: "selection" | "judgment";
}) {
  const { t } = useApp();
  const sel = ((detail as unknown as { selection?: Record<string, unknown> }).selection ?? {}) as Record<
    string,
    unknown
  >;
  const isIdentity = sel.ontologyRuleId === "9-15";
  return (
    <div className="rounded-md" style={{ border: "1px solid var(--c-line)", overflow: "hidden" }}>
      <div
        className="flex items-center"
        style={{ gap: 8, padding: "10px 12px", background: "var(--c-panel)", borderBottom: "1px solid var(--c-line)" }}
      >
        <Badge variant="default">{t("rc_det_mode_badge")}</Badge>
        <span className="text-ink-2" style={{ fontSize: 11.5 }}>
          {mode === "selection" ? t("rc_det_select_desc") : t("rc_det_mode_desc")}
        </span>
      </div>
      {/* 三级判定阶梯 = 候选人×规则的匹配检查 → 只在「规则判断」(judgment)出现 */}
      {isIdentity && mode === "judgment" ? <IdentityLadder sel={sel} /> : null}
      {detail.flags.map((f) => (
        <DeterministicRuleRow key={f.rule_id} flag={f} mode={mode} isIdentity={isIdentity} />
      ))}
    </div>
  );
}

/** 查重专用:三级判定阶梯(命中即停)+ 结论 + 关联候选人。 */
function IdentityLadder({ sel }: { sel: Record<string, unknown> }) {
  const { t } = useApp();
  const TIERS = [t("rc_id_tier1"), t("rc_id_tier2"), t("rc_id_tier3")];
  const matched = typeof sel.matchedRule === "string" ? sel.matchedRule : null;
  const mIdx = matched ? Number(matched.replace(/\D/g, "")) - 1 : -1;
  const dedup = typeof sel.dedupAction === "string" ? sel.dedupAction : "";
  const name = typeof sel.matchedCandidateName === "string" ? sel.matchedCandidateName : null;
  const cid = typeof sel.matchedCandidateId === "string" ? sel.matchedCandidateId : null;
  const conclusion =
    dedup === "auto-merged"
      ? t("rc_id_concl_merged")
      : dedup === "pending-review"
        ? t("rc_id_concl_review")
        : t("rc_id_concl_new");
  return (
    <div style={{ padding: 12, borderBottom: "1px solid var(--c-line)" }}>
      <div className="text-ink-1" style={{ fontSize: 13, fontWeight: 600 }}>
        {t("rc_id_conclusion")}：{conclusion}
      </div>
      {name && cid ? (
        <div className="text-ink-2" style={{ fontSize: 12, marginTop: 4 }}>
          {t("rc_id_linked")}：{name}（{cid}）
        </div>
      ) : null}
      <div className="hint" style={{ marginTop: 10, marginBottom: 6 }}>
        {t("rc_id_ladder")}
      </div>
      <div className="flex flex-col" style={{ gap: 5 }}>
        {TIERS.map((label, i) => {
          const status =
            mIdx < 0 || i < mIdx ? t("rc_id_tier_miss") : i === mIdx ? t("rc_id_tier_hit") : t("rc_id_tier_skip");
          const active = i === mIdx;
          return (
            <div
              key={i}
              className="flex items-center"
              style={{ gap: 8, fontSize: 12, opacity: mIdx >= 0 && i > mIdx ? 0.5 : 1 }}
            >
              <span style={{ color: active ? "var(--c-ok)" : "var(--c-ink-3)", fontSize: 10 }}>
                {active ? "●" : "○"}
              </span>
              <span className="text-ink-1">{label}</span>
              <span className="mono" style={{ fontSize: 10.5, color: active ? "var(--c-ok)" : "var(--c-ink-3)" }}>
                {status}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 单条确定性规则。selection 模式 = 规则号+名 +「选取依据」(为什么纳入,无 PASS/FAIL);
 *  judgment 模式 = 规则号+名 + 结论徽章 +「判定依据」(候选人×规则的匹配检查结论)。 */
function DeterministicRuleRow({
  flag,
  mode,
  isIdentity,
}: {
  flag: RuleCheckAuditDetail["flags"][number];
  mode: "selection" | "judgment";
  isIdentity: boolean;
}) {
  const { t } = useApp();
  const color =
    flag.result === "PASS" ? "var(--c-ok)" : flag.result === "FAIL" ? "var(--c-err)" : "var(--c-ink-3)";
  // 规则筛选 → 选取依据(为什么选这条规则,确定性);规则判断 → 判定依据(命中检查结论=大模型文案)。
  const basisLabel =
    mode === "selection"
      ? isIdentity
        ? t("rc_id_select_basis")
        : t("rc_det_basis")
      : isIdentity
        ? t("rc_id_judge_basis")
        : t("rc_det_basis");
  const basisText =
    mode === "selection" && isIdentity ? t("rc_id_select_reason") : flag.evidence;
  return (
    <div style={{ padding: 12, borderBottom: "1px solid var(--c-line)" }}>
      <div className="flex items-center" style={{ gap: 8, marginBottom: 6 }}>
        <span className="mono text-ink-3" style={{ fontSize: 11 }}>
          {flag.rule_id}
        </span>
        <span className="text-ink-1" style={{ fontSize: 13, fontWeight: 600 }}>
          {flag.rule_name_snapshot}
        </span>
        {/* 结论徽章只在「规则判断」出现(规则筛选只解释为什么选,不下 PASS/FAIL) */}
        {mode === "judgment" ? (
          <span
            className="mono"
            style={{ fontSize: 10.5, color, border: `1px solid ${color}`, borderRadius: 4, padding: "1px 6px" }}
          >
            {verdictLabel(flag.result, t)}
          </span>
        ) : null}
      </div>
      <div className="hint" style={{ marginBottom: 3 }}>
        {basisLabel}
      </div>
      <div className="text-ink-2" style={{ fontSize: 12, lineHeight: 1.55, marginBottom: 8 }}>
        {basisText}
      </div>
      <RuleDefinitionPanel ruleId={flag.rule_id} />
    </div>
  );
}

/** 三层归属 tier → i18n 标签键(与 drawer 内 tierLabel 对齐)。 */
const TIER_KEY: Record<string, string> = {
  general: "rc_tier_general",
  client: "rc_tier_client",
  department: "rc_tier_department",
};

/** next_action → 中英文标签(决策方向:放行/阻断/补材料/待复核)。 */
function nextActionLabel(a: string, t: (k: string) => string): string {
  if (a === "block") return t("rc_action_block");
  if (a === "supplement") return t("rc_action_supplement");
  if (a === "review") return t("rc_action_review");
  return t("rc_action_continue");
}

/** 判定结果概览条 —— PASS / FAIL / 不适用 计数(继承自原「规则判定」概览)。 */
function RuleResultStrip({ flags }: { flags: RuleCheckAuditDetail["flags"] }) {
  const { t } = useApp();
  const pass = flags.filter((f) => f.result === "PASS").length;
  // 2026-06-01 fail-closed:信息不足 / 待复核(REVIEW)也计入「不通过」。
  const fail = flags.filter(
    (f) => f.result === "FAIL" || f.result === "INSUFFICIENT_INFO" || f.result === "REVIEW",
  ).length;
  const na = flags.filter((f) => !f.applicable || f.result === "NOT_APPLICABLE" || f.result === "NOT_TRIGGERED").length;
  const seg = (icon: string, n: number, color: string) =>
    n > 0 ? (
      <span className="inline-flex items-center gap-1" style={{ color }}>
        <span>{icon}</span>
        <span className="mono font-semibold tabular-nums">{n}</span>
      </span>
    ) : null;
  return (
    <div
      className="border border-line rounded-sm bg-panel flex items-center flex-wrap"
      style={{ padding: "6px 12px", gap: "4px 14px", fontSize: 12 }}
    >
      <span className="hint">{t("rc_overview_total").replace("{n}", String(flags.length))}</span>
      {seg("✓", pass, "var(--c-ok)")}
      {seg("✗", fail, "var(--c-err)")}
      {seg("⊘", na, "var(--c-ink-4)")}
    </div>
  );
}

/**
 * 适配规则 —— 运行时把 ontology 全量规则按 (client × business_group × executor)
 * 过滤,选中的规则注入用户提示词。每条规则可展开看三件事:
 *   ① 原规则(经图引擎抽取)
 *   ② 原模型(LLM)判断 + 证据 + 纳入依据
 *   ③ 第二模型验证(逐条第二意见,与原判定是否一致)
 * 选取链路本身是确定性数据;第二模型验证随交叉验证完成后填入。
 */
function AdaptedRules({
  mode,
  detail,
  verification,
  verifying,
}: {
  mode: "selection" | "full";
  detail: RuleCheckAuditDetail;
  verification: RuleSelectionVerification | null;
  verifying: boolean;
}) {
  const { t } = useApp();
  const [showFiltered, setShowFiltered] = React.useState(false);
  // Defensive ?? [] — a non-recruitment detail (e.g. energy ontology audit) may
  // omit these arrays; degrade gracefully instead of crashing on .map/.length.
  const provById = React.useMemo(
    () => new Map((detail.rule_provenance ?? []).map((p) => [p.rule_id, p])),
    [detail.rule_provenance],
  );
  const opinionById = React.useMemo(
    () => new Map((verification?.rule_opinions ?? []).map((o) => [o.rule_id, o])),
    [verification],
  );
  // 全量 provenance(含排除)→ 选中/排除两组 + 计数 + 每行筛选 verdict。
  const displayModel = React.useMemo(
    () =>
      buildRuleDisplayModel({
        provenance: detail.rule_provenance ?? [],
        opinions: (verification?.rule_opinions ?? []).map((o) => ({
          rule_id: o.rule_id,
          selection_ok: o.selection_ok,
        })),
      }),
    [detail.rule_provenance, verification],
  );
  const excludedRows = displayModel.excluded;
  const provTotal = displayModel.counts.total;
  const selected = detail.flags ?? [];
  const filtered = detail.filtered_out_rules ?? [];
  const total = detail.rules_total_in_ontology;
  // 因果链计数:有 provenance 时用全量派生(规则库=全量, 过滤=排除数);
  // 无 provenance(旧/能源 audit)回退旧字段。
  const chainTotal = provTotal > 0 ? provTotal : total;
  const chainFiltered = provTotal > 0 ? excludedRows.length : filtered.length;
  // Infra park (没钱/故障): no per-rule flags were written, but the rules WERE
  // fetched — surface them from provenance so the page still shows 抓取了哪些规则.
  const fetchedIncluded = React.useMemo(
    () => (detail.rule_provenance ?? []).filter((p) => p.included),
    [detail.rule_provenance],
  );
  const parked = selected.length === 0 && fetchedIncluded.length > 0;
  const selectedCount = parked ? fetchedIncluded.length : selected.length;

  return (
    <div
      className="rc-surface-panel rc-card-in"
      style={{
        padding: "14px 16px",
      }}
    >
      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 4 }}>
        <span className="text-ink-3">
          <Ic.branch />
        </span>
        <span className="text-ink-1" style={{ fontSize: 13.5, fontWeight: 600 }}>
          {t("rc_sel_title")}
        </span>
      </div>
      <div className="mono text-[12px] text-ink-1" style={{ marginBottom: 2 }}>
        {t("rc_sel_chain")
          .replace("{total}", String(chainTotal))
          .replace("{filtered}", String(chainFiltered))
          .replace("{selected}", String(selectedCount))}
      </div>
      <div className="hint" style={{ marginBottom: 10 }}>
        {t("rc_sel_dim").replace(
          "{client}",
          detail.client_display_name || detail.client_name || "?",
        )}
        {detail.business_group
          ? t("rc_sel_dim_bg").replace("{bg}", detail.business_group)
          : null}
      </div>

      {/* 判定结果概览(PASS / FAIL / 不适用 计数)只在「规则判断」全量视图显示 */}
      {mode === "full" ? <RuleResultStrip flags={selected} /> : null}

      {parked ? (
        <div
          className="text-[11.5px]"
          style={{
            margin: "10px 0",
            padding: "8px 10px",
            borderRadius: 4,
            background: "var(--c-warn-bg)",
            borderLeft: "3px solid var(--c-warn)",
            color: "var(--c-ink-1)",
            lineHeight: 1.55,
          }}
        >
          {detail.failure_reasons[0] ?? t("rc_sel_parked_generic")}
        </div>
      ) : null}
      <div className="hint" style={{ marginBottom: 6, marginTop: 12 }}>
        {parked ? t("rc_sel_fetched_title") : t("rc_sel_selected_title")} ({selectedCount})
      </div>
      {parked ? (
        <div className="flex flex-col" style={{ gap: 6 }}>
          {fetchedIncluded.map((p) => (
            <ParkedRuleRow key={p.rule_id} prov={p} t={t} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col" style={{ gap: 6 }}>
          {selected.map((f, i) => (
            <AdaptedRuleCard
              key={f.flag_id}
              mode={mode}
              index={i}
              flag={f}
              prov={provById.get(f.rule_id) ?? null}
              opinion={opinionById.get(f.rule_id) ?? null}
              verifying={verifying}
            />
          ))}
        </div>
      )}

      {/* 未选中 · 排除组:全量 provenance 驱动,每条 = 确定性排除理由 + AI 该不该纳入 */}
      {excludedRows.length > 0 ? (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--c-line)", paddingTop: 10 }}>
          <div className="hint" style={{ marginBottom: 6 }}>
            {t("rc_sel_excluded_group").replace("{n}", String(excludedRows.length))}
          </div>
          <div className="flex flex-col" style={{ gap: 6 }}>
            {excludedRows.map((row) => (
              <ExcludedRuleCard
                key={row.rule_id}
                row={row}
                opinion={opinionById.get(row.rule_id) ?? null}
                verifying={verifying}
              />
            ))}
          </div>
        </div>
      ) : null}

      {/* 旧/能源 audit(无 provenance)回退原折叠区;有 provenance 时已被上面排除组覆盖 */}
      {provTotal === 0 ? (
        filtered.length > 0 ? (
        <div style={{ marginTop: 12, borderTop: "1px solid var(--c-line)", paddingTop: 10 }}>
          <button
            type="button"
            className="w-full text-left hint"
            onClick={() => setShowFiltered((s) => !s)}
          >
            {showFiltered ? "▾" : "▸"} {t("rc_sel_filtered_title")} ({filtered.length})
          </button>
          {showFiltered ? (
            <div className="flex flex-col" style={{ gap: 5, marginTop: 6 }}>
              {filtered.map((r) => (
                <div
                  key={r.rule_id}
                  className="flex items-start"
                  style={{ gap: 10, padding: "6px 8px", background: "var(--c-panel)", borderRadius: 3 }}
                >
                  <span className="mono text-[11px] text-ink-3 flex-none" style={{ minWidth: 46 }}>
                    {r.rule_id}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="text-[11.5px] text-ink-2">{r.rule_name}</div>
                    <div className="mono text-[10.5px] text-ink-3" style={{ marginTop: 2, lineHeight: 1.5 }}>
                      {r.reason}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="hint" style={{ fontSize: 11, marginTop: 10 }}>
          {t("rc_sel_empty_filtered").replace("{total}", String(total))}
        </div>
        )
      ) : null}
    </div>
  );
}

/** 挂起态(没钱/故障)单条已抓取规则 — 无 LLM 逐条判定,只展示抓取证据 + 「未判定」。 */
function ParkedRuleRow({
  prov,
  t,
}: {
  prov: { rule_id: string; tier: string; reason: string };
  t: (k: string) => string;
}) {
  const tierKey = TIER_KEY[prov.tier];
  return (
    <div
      className="flex items-start"
      style={{ gap: 10, padding: "7px 9px", background: "var(--c-surface)", border: "1px solid var(--c-line)", borderRadius: 4 }}
    >
      <span className="mono text-[11px] text-ink-3 flex-none" style={{ minWidth: 46 }}>
        {prov.rule_id}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="flex items-center gap-2 flex-wrap">
          {tierKey ? <Badge variant="default">{t(tierKey)}</Badge> : null}
          <Badge variant="warn">{t("rc_verdict_parked")}</Badge>
        </div>
        <div className="mono text-[10.5px] text-ink-3" style={{ marginTop: 3, lineHeight: 1.5 }}>
          {prov.reason}
        </div>
      </div>
    </div>
  );
}

/** 筛选 verdict → i18n key + 色调(ok 绿 / err 红 / muted 灰)。 */
const FILTER_VERDICT_META: Record<string, { key: string; tone: "ok" | "err" | "muted" }> = {
  correct_included: { key: "rc_filter_correct_included", tone: "ok" },
  suspect_over: { key: "rc_filter_suspect_over", tone: "err" },
  correct_excluded: { key: "rc_filter_correct_excluded", tone: "ok" },
  suspect_missed: { key: "rc_filter_suspect_missed", tone: "err" },
  unknown: { key: "", tone: "muted" },
};

/** 单条「被排除规则」卡:确定性排除理由 + AI 该不该纳入(selection_ok)。无 PASS/FAIL。 */
function ExcludedRuleCard({
  row,
  opinion,
  verifying,
}: {
  row: RuleDisplayRow;
  opinion: RuleOpinion | null;
  verifying: boolean;
}) {
  const { t } = useApp();
  const [open, setOpen] = React.useState(false);
  const tierKey = TIER_KEY[row.tier];
  const meta = FILTER_VERDICT_META[row.filter_verdict];
  const tone =
    meta.tone === "ok" ? "var(--c-ok)" : meta.tone === "err" ? "var(--c-err)" : "var(--c-ink-4)";
  return (
    <div className="border border-line rounded-sm overflow-hidden" style={{ background: "var(--c-bg)" }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-left"
        style={{ padding: "8px 10px", cursor: "pointer" }}
      >
        <span
          className="text-ink-3 select-none flex-none"
          style={{ fontSize: 10, transform: open ? "rotate(90deg)" : "none", transition: "transform 160ms ease" }}
        >
          ▶
        </span>
        <span className="mono text-[11.5px] text-ink-1 font-semibold flex-none">{row.rule_id}</span>
        <span className="text-[12px] text-ink-1 flex-1 truncate">{row.rule_name}</span>
        {tierKey ? <Badge variant="default">{t(tierKey)}</Badge> : null}
        {meta.key ? (
          <span
            className="mono rounded-sm flex-none"
            style={{
              fontSize: 10,
              padding: "1px 6px",
              color: tone,
              background: `color-mix(in oklab, ${tone} 12%, var(--c-bg))`,
              border: `1px solid color-mix(in oklab, ${tone} 35%, var(--c-line))`,
            }}
          >
            {t(meta.key)}
          </span>
        ) : verifying ? (
          <span className="mono text-ink-3 flex-none" style={{ fontSize: 10 }}>
            {t("rc_sel_verifying")}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="rc-fade-in" style={{ borderTop: "1px solid var(--c-line)", padding: "10px 12px" }}>
          <div className="hint" style={{ marginBottom: 4 }}>
            {t("rc_sel_excluded_reason")}
            {tierKey ? `（${t(tierKey)}）` : ""}
          </div>
          <div className="text-ink-2" style={{ fontSize: 11.5, lineHeight: 1.55, marginBottom: opinion ? 8 : 0 }}>
            {row.reason}
          </div>
          {opinion ? (
            <div
              className="rounded-sm"
              style={{
                background:
                  row.filter_verdict === "suspect_missed"
                    ? "color-mix(in oklab, var(--c-err) 6%, var(--c-bg))"
                    : "var(--c-panel)",
                borderLeft: `3px solid ${tone}`,
                padding: "6px 8px",
              }}
            >
              <div className="hint" style={{ fontSize: 10, marginBottom: 3 }}>
                {t("rc_sel_llm_select_judge")}
              </div>
              <div className="text-ink-2" style={{ fontSize: 11, lineHeight: 1.5 }}>
                {opinion.selection_reasoning || "—"}
              </div>
            </div>
          ) : null}
          <div style={{ borderTop: "1px solid var(--c-line)", marginTop: 10 }}>
            <div className="hint" style={{ padding: "8px 0 0" }}>
              {t("rc_sel_orig_rule_title")}
            </div>
            <RuleDefinitionPanel ruleId={row.rule_id} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 单条适配规则卡 — 折叠头(id·名称·tier·原判定·一致/分歧),展开看 LLM 判断/证据 +
 *  第二模型验证 + 原规则(图引擎)。 */
function AdaptedRuleCard({
  mode,
  index,
  flag,
  prov,
  opinion,
  verifying,
}: {
  mode: "selection" | "full";
  index: number;
  flag: RuleCheckAuditDetail["flags"][number];
  prov: { tier: string; reason: string } | null;
  opinion: RuleOpinion | null;
  verifying: boolean;
}) {
  const { t } = useApp();
  const [open, setOpen] = React.useState(false);
  const tierKey = prov ? TIER_KEY[prov.tier] : undefined;
  // 2026-06-01:FAIL / INSUFFICIENT_INFO / REVIEW 都是「不通过」→ 红;PASS → 绿;NOT_TRIGGERED → 灰。
  const blocking =
    flag.result === "FAIL" || flag.result === "INSUFFICIENT_INFO" || flag.result === "REVIEW";
  const resultVariant: "ok" | "err" | "default" =
    flag.result === "PASS" ? "ok" : blocking ? "err" : "default";
  const agreeColor = opinion ? (opinion.agrees ? "var(--c-ok)" : "var(--c-err)") : null;

  return (
    <div
      className="rc-row-in border border-line rounded-sm overflow-hidden"
      style={{ background: "var(--c-bg)", ["--rc-i"]: Math.min(index, 10) } as React.CSSProperties}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-left"
        style={{ padding: "8px 10px", cursor: "pointer" }}
      >
        <span
          className="text-ink-3 select-none flex-none"
          style={{ fontSize: 10, transform: open ? "rotate(90deg)" : "none", transition: "transform 160ms ease" }}
        >
          ▶
        </span>
        <span className="mono text-[11.5px] text-ink-1 font-semibold flex-none">{flag.rule_id}</span>
        <span className="text-[12px] text-ink-1 flex-1 truncate">{flag.rule_name_snapshot || ""}</span>
        {mode === "full" ? (
          <>
            <Badge variant={flag.severity === "flag_only" ? "default" : "err"}>
              {flag.severity === "flag_only" ? t("rc_flag_severity_tip") : t("rc_flag_severity_bottomline")}
            </Badge>
            <Badge variant={resultVariant}>{verdictLabel(flag.result, t)}</Badge>
            <Badge variant={flag.next_action === "block" ? "err" : flag.next_action === "continue" ? "ok" : "default"}>
              {nextActionLabel(flag.next_action, t)}
            </Badge>
          </>
        ) : tierKey ? (
          <Badge variant="default">{t(tierKey)}</Badge>
        ) : null}
        {opinion && mode === "selection" ? (
          <span
            className="inline-flex items-center gap-1 mono rounded-sm flex-none"
            style={{
              fontSize: 10,
              padding: "1px 6px",
              color: opinion.selection_ok ? "var(--c-ok)" : "var(--c-err)",
              background: `color-mix(in oklab, ${opinion.selection_ok ? "var(--c-ok)" : "var(--c-err)"} 12%, var(--c-bg))`,
              border: `1px solid color-mix(in oklab, ${opinion.selection_ok ? "var(--c-ok)" : "var(--c-err)"} 35%, var(--c-line))`,
            }}
          >
            {opinion.selection_ok ? <Ic.check /> : <Ic.cross />}
            {opinion.selection_ok ? t("rc_sel_should_select") : t("rc_sel_should_not_select")}
          </span>
        ) : opinion && agreeColor && mode === "full" ? (
          <>
            <span
              className="mono rounded-sm flex-none tabular-nums"
              style={{
                fontSize: 10,
                padding: "1px 6px",
                color: scoreColor(opinion.confidence),
                background: `color-mix(in oklab, ${scoreColor(opinion.confidence)} 12%, var(--c-bg))`,
                border: `1px solid color-mix(in oklab, ${scoreColor(opinion.confidence)} 35%, var(--c-line))`,
              }}
              title={t("rc_rule_conf")}
            >
              {opinion.confidence}%
            </span>
            <span
              className="inline-flex items-center gap-1 mono rounded-sm flex-none"
              style={{
                fontSize: 10,
                padding: "1px 6px",
                color: agreeColor,
                background: `color-mix(in oklab, ${agreeColor} 12%, var(--c-bg))`,
                border: `1px solid color-mix(in oklab, ${agreeColor} 35%, var(--c-line))`,
              }}
            >
              {opinion.agrees ? <Ic.check /> : <Ic.cross />}
              {opinion.agrees ? t("rc_verify_agrees") : t("rc_verify_disagrees")}
            </span>
          </>
        ) : verifying ? (
          <span className="mono text-ink-3 flex-none" style={{ fontSize: 10 }}>
            {t("rc_sel_verifying")}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="rc-fade-in" style={{ borderTop: "1px solid var(--c-line)" }}>
          {/* 纳入依据(硬编码过滤)+ 大模型二次判断该不该选 */}
          <div style={{ padding: "10px 12px" }}>
            <div className="hint" style={{ marginBottom: 5 }}>
              {t("rc_sel_incl_title")}
            </div>
            {prov ? (
              <div
                className="text-ink-2"
                style={{ fontSize: 11.5, lineHeight: 1.55, marginBottom: opinion || verifying ? 6 : 0 }}
              >
                <span className="hint">
                  {t("rc_sel_why")}
                  {tierKey ? `(${t(tierKey)})` : ""}:{" "}
                </span>
                {prov.reason}
              </div>
            ) : null}
            {opinion ? (
              <div
                className="rounded-sm"
                style={{
                  background: opinion.selection_ok
                    ? "var(--c-panel)"
                    : "color-mix(in oklab, var(--c-err) 6%, var(--c-bg))",
                  borderLeft: `3px solid ${opinion.selection_ok ? "var(--c-ok)" : "var(--c-err)"}`,
                  padding: "6px 8px",
                }}
              >
                <div
                  className="flex items-center gap-1.5"
                  style={{ marginBottom: opinion.selection_reasoning ? 3 : 0 }}
                >
                  <span
                    style={{ color: opinion.selection_ok ? "var(--c-ok)" : "var(--c-err)", fontSize: 11 }}
                  >
                    {opinion.selection_ok ? <Ic.check /> : <Ic.cross />}
                  </span>
                  <span className="hint" style={{ fontSize: 10 }}>
                    {t("rc_sel_llm_select_judge")}
                  </span>
                  <span
                    className="text-[11px]"
                    style={{ color: opinion.selection_ok ? "var(--c-ok)" : "var(--c-err)" }}
                  >
                    {opinion.selection_ok ? t("rc_sel_should_select") : t("rc_sel_should_not_select")}
                  </span>
                </div>
                {opinion.selection_reasoning ? (
                  <div className="text-ink-2" style={{ fontSize: 11, lineHeight: 1.5 }}>
                    {opinion.selection_reasoning}
                  </div>
                ) : null}
              </div>
            ) : verifying ? (
              <span className="mono text-ink-3" style={{ fontSize: 11 }}>
                {t("rc_sel_verifying")}
              </span>
            ) : null}
          </div>

          {/* 原模型判断 + 证据 / 第二模型 PASS-FAIL 验证 —— 只在「规则判断」全量视图,
              「规则筛选」tab 不做 rule-check 判断。 */}
          {mode === "full" ? (
            <>
              <div style={{ padding: "0 12px 10px" }}>
                <div className="hint" style={{ marginBottom: 5 }}>
                  {t("rc_sel_llm_title")}
                </div>
                <div className="flex items-center gap-2" style={{ marginBottom: 5, flexWrap: "wrap" }}>
                  <Badge variant={resultVariant}>{verdictLabel(flag.result, t)}</Badge>
                  <Badge variant={flag.severity === "flag_only" ? "default" : "err"}>
                    {flag.severity === "flag_only" ? t("rc_flag_severity_tip") : t("rc_flag_severity_bottomline")}
                  </Badge>
                </div>
                <div className="text-[12px] text-ink-1" style={{ lineHeight: 1.6 }}>
                  {flag.evidence || t("rc_evidence_no_llm_short")}
                </div>
              </div>

              <div style={{ padding: "0 12px 10px" }}>
                <div className="hint" style={{ marginBottom: 5 }}>
                  {t("rc_sel_verify_title")}
                </div>
                {opinion ? (
                  <SecondOpinionBlock o={opinion} />
                ) : verifying ? (
                  <span className="mono text-ink-3" style={{ fontSize: 11 }}>
                    {t("rc_sel_verifying")}
                  </span>
                ) : (
                  <span className="hint" style={{ fontSize: 11 }}>
                    {t("rc_sel_no_opinion")}
                  </span>
                )}
              </div>
            </>
          ) : null}

          {/* 原规则(经图引擎抽取)— 懒加载 */}
          <div style={{ borderTop: "1px solid var(--c-line)" }}>
            <div className="hint" style={{ padding: "8px 12px 0" }}>
              {t("rc_sel_orig_rule_title")}
            </div>
            <RuleDefinitionPanel ruleId={flag.rule_id} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SecondOpinionBlock({ o }: { o: RuleOpinion }) {
  const { t } = useApp();
  const meta = SV_META[o.second_verdict];
  const accent = o.agrees ? "var(--c-ok)" : "var(--c-err)";
  return (
    <div
      className="rounded-sm"
      style={{
        background: o.agrees ? "var(--c-panel)" : "color-mix(in oklab, var(--c-err) 6%, var(--c-bg))",
        borderLeft: `3px solid ${accent}`,
        padding: "8px 10px",
      }}
    >
      {/* 原 → 二审 + 一致/分歧 + 本条置信 */}
      <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 7 }}>
        <span className="hint" style={{ fontSize: 10 }}>
          {t("rc_verify_orig")}
        </span>
        <Badge
          variant={
            o.original_result === "PASS"
              ? "ok"
              : o.original_result === "FAIL" ||
                  o.original_result === "INSUFFICIENT_INFO" ||
                  o.original_result === "REVIEW"
                ? "err"
                : "default"
          }
        >
          {verdictLabel(o.original_result, t)}
        </Badge>
        <span className="text-ink-4" style={{ fontSize: 10 }}>
          →
        </span>
        <span className="hint" style={{ fontSize: 10 }}>
          {t("rc_verify_second")}
        </span>
        <Badge variant={meta.variant}>{t(meta.key)}</Badge>
        <span className="mono" style={{ fontSize: 10, color: accent }}>
          {o.agrees ? t("rc_verify_agrees") : t("rc_verify_disagrees")}
        </span>
        <span
          className="mono tabular-nums"
          style={{ marginLeft: "auto", fontSize: 11, fontWeight: 600, color: scoreColor(o.confidence) }}
        >
          {t("rc_rule_conf")} {o.confidence}%
        </span>
      </div>

      {/* 本条多维度置信 mini-bars */}
      {o.dimensions.length > 0 ? (
        <div className="flex flex-col" style={{ gap: 5, marginBottom: o.judgment_reasoning ? 7 : 0 }}>
          {o.dimensions.map((d, i) => {
            const labelKey = RULE_DIM_LABEL_KEY[d.key];
            const label = labelKey ? t(labelKey) : d.key;
            const c = scoreColor(d.score);
            return (
              <div key={d.key + i} className="flex items-center gap-2">
                <span className="text-ink-3" style={{ fontSize: 10, minWidth: 64 }}>
                  {label}
                </span>
                <div
                  className="rounded-full overflow-hidden flex-1"
                  style={{ height: 4, background: "var(--c-bg)" }}
                >
                  <div style={{ height: "100%", width: `${d.score}%`, background: c }} />
                </div>
                <span
                  className="mono tabular-nums"
                  style={{ fontSize: 10, color: c, minWidth: 22, textAlign: "right" }}
                >
                  {d.score}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* 详细自然语言判定(候选人 + 岗位 + 证据) */}
      {o.judgment_reasoning ? (
        <div className="text-ink-1" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
          {o.judgment_reasoning}
        </div>
      ) : null}
    </div>
  );
}

function mapReason(
  reason: string,
  err: string | undefined,
  t: (k: string) => string,
): VerifyError {
  if (reason === "not_applicable") return { kind: "not_applicable", msg: t("rc_verify_deterministic") };
  if (reason === "gateway_unavailable") return { kind: "gateway", msg: t("rc_verify_err_gateway") };
  if (reason === "parse_error") return { kind: "parse", msg: err || t("rc_verify_err_parse") };
  if (reason === "llm_error") return { kind: "llm", msg: err || t("rc_verify_err_llm") };
  if (reason === "not_found") return { kind: "generic", msg: t("rc_verify_err_not_found") };
  return { kind: "generic", msg: err || t("rc_verify_err_generic") };
}

// ── running ──────────────────────────────────────────────────────────────
function RunningState({ stage }: { stage: number }) {
  const { t } = useApp();
  const stages = [t("rc_verify_stage_load"), t("rc_verify_stage_judge"), t("rc_verify_stage_score")];
  return (
    <div
      className="rc-fade-in border border-line rounded-md"
      style={{ padding: "30px 28px" }}
    >
      <div className="flex items-center gap-2.5" style={{ marginBottom: 20 }}>
        <span
          className="inline-block rounded-full"
          style={{
            width: 9,
            height: 9,
            background: "var(--c-accent)",
            animation: "pulse 1.1s ease-in-out infinite",
          }}
        />
        <span className="text-ink-1" style={{ fontSize: 13.5, fontWeight: 500 }}>
          {t("rc_verify_running")}
        </span>
      </div>
      <div className="flex flex-col" style={{ gap: 14 }}>
        {stages.map((label, i) => {
          const done = i < stage;
          const active = i === stage;
          return (
            <div key={i} className="flex items-center gap-3">
              <span
                className="mono flex items-center justify-center flex-none rounded-full"
                style={{
                  width: 20,
                  height: 20,
                  fontSize: 11,
                  background: done
                    ? "var(--c-ok)"
                    : active
                      ? "color-mix(in oklab, var(--c-accent) 22%, var(--c-bg))"
                      : "var(--c-panel)",
                  color: done ? "var(--c-bg)" : active ? "var(--c-accent)" : "var(--c-ink-4)",
                  border: active ? "1px solid var(--c-accent)" : "1px solid var(--c-line)",
                }}
              >
                {done ? "✓" : i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <div
                  className="text-[12.5px]"
                  style={{ color: done || active ? "var(--c-ink-1)" : "var(--c-ink-3)" }}
                >
                  {label}
                </div>
                <div
                  className="rounded-full overflow-hidden"
                  style={{ height: 3, marginTop: 6, background: "var(--c-line)" }}
                >
                  {active ? (
                    <div className="rc-verify-shimmer" style={{ height: "100%", width: "100%" }} />
                  ) : done ? (
                    <div style={{ height: "100%", width: "100%", background: "var(--c-ok)" }} />
                  ) : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── error ──────────────────────────────────────────────────────────────────
function ErrorState({ error, onRetry }: { error: VerifyError; onRetry: () => void }) {
  const { t } = useApp();
  // not_applicable = deterministic rule-check (energy) → neutral info, no retry.
  // gateway = warn, no retry. everything else = error, retry.
  const isNA = error.kind === "not_applicable";
  const isGateway = error.kind === "gateway";
  const accent = isNA ? "var(--c-accent)" : isGateway ? "oklch(0.5 0.14 75)" : "var(--c-err)";
  const bg = isNA ? "var(--c-accent-bg)" : isGateway ? "var(--c-warn-bg)" : "var(--c-err-bg)";
  return (
    <div
      className="rc-fade-in border rounded-md flex flex-col items-center text-center"
      style={{ padding: "34px 28px", borderColor: "var(--c-line)", borderLeft: `3px solid ${accent}`, background: bg }}
    >
      <div style={{ color: isNA ? "var(--c-accent)" : isGateway ? "oklch(0.45 0.14 75)" : "var(--c-err)", marginBottom: 10 }}>
        {isNA ? <Ic.shield /> : <Ic.alert />}
      </div>
      <div className="text-ink-1" style={{ fontSize: 13.5, fontWeight: 500, maxWidth: 480 }}>
        {error.msg}
      </div>
      {isNA ? (
        <div className="text-ink-3" style={{ fontSize: 11.5, marginTop: 8, maxWidth: 460, lineHeight: 1.6 }}>
          {t("rc_verify_deterministic_hint")}
        </div>
      ) : null}
      {isGateway ? (
        <div className="mono text-ink-3" style={{ fontSize: 11, marginTop: 8 }}>
          {t("rc_verify_err_gateway_hint")}
        </div>
      ) : null}
      {!isGateway && !isNA ? (
        <Btn size="sm" onClick={onRetry} style={{ marginTop: 16 }}>
          🔁 {t("rc_verify_retry")}
        </Btn>
      ) : null}
    </div>
  );
}

// ── result ───────────────────────────────────────────────────────────────
const VERDICT_META: Record<VerifierVerdict, { color: string; key: string }> = {
  trustworthy: { color: "var(--c-ok)", key: "rc_verdict_trustworthy" },
  needs_review: { color: "oklch(0.55 0.14 75)", key: "rc_verdict_needs_review" },
  untrustworthy: { color: "var(--c-err)", key: "rc_verdict_untrustworthy" },
};

const DIM_LABEL_KEY: Record<string, string> = {
  selection_coverage: "rc_dim_selection_coverage",
  candidate_jr_fit: "rc_dim_candidate_jr_fit",
  evidence_sufficiency: "rc_dim_evidence_sufficiency",
  filter_soundness: "rc_dim_filter_soundness",
};

/** Per-rule confidence dimension keys → i18n labels. */
const RULE_DIM_LABEL_KEY: Record<string, string> = {
  selection_fit: "rc_dim_selection_fit",
  judgment_correctness: "rc_dim_judgment_correctness",
  evidence_sufficiency: "rc_dim_evidence_sufficiency",
};

function scoreColor(score: number): string {
  if (score >= 80) return "var(--c-ok)";
  if (score >= 55) return "oklch(0.6 0.14 75)";
  return "var(--c-err)";
}

function ResultView({
  v,
  primaryModel,
  verifierModel,
  durationMs,
  onRerun,
}: {
  v: RuleSelectionVerification;
  primaryModel: string;
  verifierModel: string;
  durationMs: number;
  onRerun: () => void;
}) {
  const { t } = useApp();
  const sec = (i: number) =>
    ({ ["--rc-i"]: i }) as React.CSSProperties;
  return (
    <div className="flex flex-col" style={{ gap: 14 }}>
      <div className="rc-verify-reveal" style={sec(0)}>
        <ConfidenceHero
          v={v}
          primaryModel={primaryModel}
          verifierModel={verifierModel}
          onRerun={onRerun}
        />
      </div>

      <div className="rc-verify-reveal" style={sec(1)}>
        <DimensionBars dimensions={v.dimensions} />
      </div>

      {/* 逐条第二意见已折进上方「适配规则」每条卡片;此处只留整体 + 遗漏/多余规则。 */}
      {(v.missing_rules.length > 0 || v.over_included_rules.length > 0) && (
        <div className="rc-verify-reveal" style={sec(2)}>
          <SelectionConcerns missing={v.missing_rules} over={v.over_included_rules} />
        </div>
      )}

      <div className="hint mono" style={{ fontSize: 10.5, textAlign: "right" }}>
        {t("rc_verify_footer_via")
          .replace("{model}", verifierModel)
          .replace("{ms}", String(durationMs))}
      </div>
    </div>
  );
}

function ConfidenceHero({
  v,
  primaryModel,
  verifierModel,
  onRerun,
}: {
  v: RuleSelectionVerification;
  primaryModel: string;
  verifierModel: string;
  onRerun: () => void;
}) {
  const { t } = useApp();
  const meta = VERDICT_META[v.verdict];
  return (
    <div
      className="border border-line rounded-md flex items-center"
      style={{
        padding: "18px 20px",
        gap: 22,
        background: `color-mix(in oklab, ${meta.color} 7%, var(--c-bg))`,
        borderLeft: `4px solid ${meta.color}`,
        flexWrap: "wrap",
      }}
    >
      <ConfidenceGauge value={v.overall_confidence} color={meta.color} />
      <div className="flex-1" style={{ minWidth: 200 }}>
        <div className="flex items-center gap-2.5" style={{ marginBottom: 6 }}>
          <span
            style={{
              fontFamily: SERIF,
              fontSize: 20,
              fontWeight: 500,
              color: meta.color,
              letterSpacing: "-0.01em",
            }}
          >
            {t(meta.key)}
          </span>
          <span
            className="inline-block rounded-full"
            style={{ width: 7, height: 7, background: meta.color }}
          />
        </div>
        {v.summary ? (
          <div className="text-ink-1" style={{ fontSize: 12.5, lineHeight: 1.6, marginBottom: 10 }}>
            {v.summary}
          </div>
        ) : null}
        <div className="flex items-center" style={{ gap: "6px 14px", flexWrap: "wrap" }}>
          <ModelChip label={t("rc_verify_model_primary")} model={primaryModel} />
          <span className="text-ink-4" style={{ fontSize: 12 }}>
            ✕
          </span>
          <ModelChip label={t("rc_verify_model_verifier")} model={verifierModel} accent />
          {v.agreement_total > 0 ? (
            <span
              className="mono rounded-sm"
              style={{
                fontSize: 11,
                padding: "2px 8px",
                background: "var(--c-panel)",
                border: "1px solid var(--c-line)",
                color: "var(--c-ink-2)",
              }}
              title={t("rc_verify_agreement_detail")
                .replace("{count}", String(v.agreement_count))
                .replace("{total}", String(v.agreement_total))}
            >
              {t("rc_verify_agreement")} {v.agreement_rate}%
              <span className="text-ink-4">
                {" "}
                ({v.agreement_count}/{v.agreement_total})
              </span>
            </span>
          ) : null}
        </div>
      </div>
      <Btn size="sm" onClick={onRerun} title={t("rc_verify_rerun")}>
        🔁 {t("rc_verify_rerun")}
      </Btn>
    </div>
  );
}

function ModelChip({ label, model, accent }: { label: string; model: string; accent?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5" style={{ fontSize: 11 }}>
      <span className="hint" style={{ fontSize: 10 }}>
        {label}
      </span>
      <span
        className="mono rounded-sm"
        style={{
          padding: "1px 6px",
          fontSize: 10.5,
          background: accent
            ? "color-mix(in oklab, var(--c-accent) 14%, var(--c-bg))"
            : "var(--c-panel)",
          color: accent ? "var(--c-accent)" : "var(--c-ink-2)",
          border: `1px solid ${accent ? "color-mix(in oklab, var(--c-accent) 35%, var(--c-line))" : "var(--c-line)"}`,
        }}
      >
        {model}
      </span>
    </span>
  );
}

/** SVG ring gauge — stroke sweeps from empty to value on mount; number counts up. */
function ConfidenceGauge({ value, color }: { value: number; color: string }) {
  const reduced = usePrefersReducedMotion();
  const [armed, setArmed] = React.useState(reduced);
  React.useEffect(() => {
    if (reduced) {
      setArmed(true);
      return;
    }
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, [reduced]);
  const shown = useCountUp(value, !reduced);

  const r = 44;
  const circ = 2 * Math.PI * r;
  const offset = armed ? circ * (1 - Math.min(100, Math.max(0, value)) / 100) : circ;

  return (
    <div className="rc-gauge-in relative flex-none" style={{ width: 108, height: 108 }}>
      <svg width={108} height={108} viewBox="0 0 108 108">
        <circle cx={54} cy={54} r={r} fill="none" stroke="var(--c-line)" strokeWidth={9} />
        <circle
          className="rc-gauge-arc"
          cx={54}
          cy={54}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={9}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={offset}
          transform="rotate(-90 54 54)"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="tabular-nums"
          style={{ fontFamily: SERIF, fontSize: 27, fontWeight: 500, color, lineHeight: 1 }}
        >
          {shown}
          <span style={{ fontSize: 14 }}>%</span>
        </span>
      </div>
    </div>
  );
}

function DimensionBars({ dimensions }: { dimensions: RuleSelectionVerification["dimensions"] }) {
  const { t } = useApp();
  const reduced = usePrefersReducedMotion();
  const [armed, setArmed] = React.useState(reduced);
  React.useEffect(() => {
    if (reduced) {
      setArmed(true);
      return;
    }
    const id = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(id);
  }, [reduced]);

  if (dimensions.length === 0) return null;
  return (
    <div className="border border-line rounded-md" style={{ padding: "12px 16px" }}>
      <div className="hint" style={{ marginBottom: 10 }}>
        {t("rc_verify_dimensions_title")}
      </div>
      <div className="flex flex-col" style={{ gap: 12 }}>
        {dimensions.map((d, i) => {
          const labelKey = DIM_LABEL_KEY[d.key];
          const label = labelKey ? t(labelKey) : d.label || d.key;
          const c = scoreColor(d.score);
          return (
            <div key={d.key + i}>
              <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
                <span className="text-ink-1" style={{ fontSize: 12 }}>
                  {label}
                </span>
                <span className="mono tabular-nums" style={{ fontSize: 12, color: c, fontWeight: 600 }}>
                  {d.score}
                </span>
              </div>
              <div
                className="rounded-full overflow-hidden"
                style={{ height: 6, background: "var(--c-panel)" }}
              >
                <div
                  className="rc-dim-bar rounded-full"
                  style={{
                    height: "100%",
                    width: armed ? `${d.score}%` : "0%",
                    background: c,
                    transitionDelay: `${Math.min(i, 6) * 90}ms`,
                  }}
                />
              </div>
              {d.reasoning ? (
                <div className="text-ink-3" style={{ fontSize: 11, lineHeight: 1.55, marginTop: 5 }}>
                  {d.reasoning}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SV_META: Record<SecondVerdict, { key: string; variant: "ok" | "err" | "default" }> = {
  PASS: { key: "rc_sv_pass", variant: "ok" },
  FAIL: { key: "rc_sv_fail", variant: "err" },
  NOT_APPLICABLE: { key: "rc_sv_na", variant: "default" },
  INSUFFICIENT_INFO: { key: "rc_sv_insufficient", variant: "err" },
  UNSURE: { key: "rc_sv_unsure", variant: "default" },
};

/**
 * 「规则筛选」tab 的整体评估 —— 只看选取(为什么这批规则筛选是对的):筛选可信度仪表
 * + 选取相关维度 + 遗漏/多余规则。不含 PASS/FAIL 判定的置信(那在规则判断 tab)。
 */
function SelectionSummary({ verify }: { verify: VerifyState }) {
  const { t } = useApp();
  if (verify.status === "error" && verify.error) {
    return <ErrorState error={verify.error} onRetry={verify.rerun} />;
  }
  if (!verify.result) return <RunningState stage={verify.stage} />;
  const v = verify.result;
  // selection-relevant dimensions only (drop the verdict/evidence dimension).
  const dims = v.dimensions.filter((d) => d.key !== "evidence_sufficiency");
  // selection confidence = avg of per-rule selection_fit, else selection_coverage dim.
  const fits = v.rule_opinions
    .map((o) => o.dimensions.find((d) => d.key === "selection_fit")?.score)
    .filter((x): x is number => typeof x === "number");
  const selConf = fits.length
    ? Math.round(fits.reduce((a, b) => a + b, 0) / fits.length)
    : v.dimensions.find((d) => d.key === "selection_coverage")?.score ?? v.overall_confidence;
  const okCount = v.rule_opinions.filter((o) => o.selection_ok).length;
  const total = v.rule_opinions.length;
  const color = scoreColor(selConf);
  const sec = (i: number) => ({ ["--rc-i"]: i }) as React.CSSProperties;
  return (
    <div className="flex flex-col" style={{ gap: 14 }}>
      <div className="rc-verify-reveal" style={sec(0)}>
        <div
          className="border border-line rounded-md flex items-center"
          style={{
            padding: "16px 18px",
            gap: 20,
            background: `color-mix(in oklab, ${color} 7%, var(--c-bg))`,
            borderLeft: `4px solid ${color}`,
            flexWrap: "wrap",
          }}
        >
          <ConfidenceGauge value={selConf} color={color} />
          <div className="flex-1" style={{ minWidth: 200 }}>
            <div style={{ fontFamily: SERIF, fontSize: 18, fontWeight: 500, color, marginBottom: 6 }}>
              {t("rc_sel_assess_title")}
            </div>
            {total > 0 ? (
              <div className="text-ink-1" style={{ fontSize: 12.5, marginBottom: 8 }}>
                {t("rc_sel_assess_count").replace("{n}", String(okCount)).replace("{total}", String(total))}
              </div>
            ) : null}
            <div className="flex items-center" style={{ gap: "6px 14px", flexWrap: "wrap" }}>
              <ModelChip label={t("rc_verify_model_primary")} model={verify.primaryModel ?? ""} />
              <span className="text-ink-4" style={{ fontSize: 12 }}>✕</span>
              <ModelChip label={t("rc_verify_model_verifier")} model={verify.verifierModel ?? ""} accent />
            </div>
          </div>
          <Btn size="sm" onClick={verify.rerun} title={t("rc_verify_rerun")}>
            🔁 {t("rc_verify_rerun")}
          </Btn>
        </div>
      </div>
      <div className="rc-verify-reveal" style={sec(1)}>
        <DimensionBars dimensions={dims} />
      </div>
      {v.missing_rules.length > 0 || v.over_included_rules.length > 0 ? (
        <div className="rc-verify-reveal" style={sec(2)}>
          <SelectionConcerns missing={v.missing_rules} over={v.over_included_rules} />
        </div>
      ) : null}
      <div className="hint mono" style={{ fontSize: 10.5, textAlign: "right" }}>
        {t("rc_verify_footer_via")
          .replace("{model}", verify.verifierModel ?? "")
          .replace("{ms}", String(verify.durationMs ?? 0))}
      </div>
    </div>
  );
}

function SelectionConcerns({
  missing,
  over,
}: {
  missing: RuleSelectionVerification["missing_rules"];
  over: RuleSelectionVerification["over_included_rules"];
}) {
  const { t } = useApp();
  return (
    <div className="flex flex-col" style={{ gap: 10 }}>
      {missing.length > 0 ? (
        <div
          className="rounded-md"
          style={{
            padding: "10px 14px",
            background: "var(--c-warn-bg)",
            borderLeft: "3px solid oklch(0.55 0.14 75)",
          }}
        >
          <div className="hint flex items-center gap-1.5" style={{ color: "oklch(0.45 0.14 75)", marginBottom: 6 }}>
            <Ic.alert /> {t("rc_verify_missing_title")} ({missing.length})
          </div>
          <div className="flex flex-col" style={{ gap: 5 }}>
            {missing.map((m, i) => (
              <div key={i} className="text-[11.5px] text-ink-1" style={{ lineHeight: 1.55 }}>
                • {m.concern}
                {m.rule_hint ? <span className="text-ink-3"> — {m.rule_hint}</span> : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {over.length > 0 ? (
        <div
          className="rounded-md"
          style={{ padding: "10px 14px", background: "var(--c-panel)", borderLeft: "3px solid var(--c-line)" }}
        >
          <div className="hint" style={{ marginBottom: 6 }}>
            {t("rc_verify_over_title")} ({over.length})
          </div>
          <div className="flex flex-col" style={{ gap: 5 }}>
            {over.map((r, i) => (
              <div key={i} className="text-[11.5px] text-ink-1" style={{ lineHeight: 1.55 }}>
                <span className="mono text-ink-2">{r.rule_id}</span> — {r.reasoning}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ── hooks ──────────────────────────────────────────────────────────────────
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return reduced;
}

function useCountUp(target: number, run: boolean, ms = 1000): number {
  const [v, setV] = React.useState(run ? 0 : target);
  React.useEffect(() => {
    if (!run) {
      setV(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setV(Math.round(target * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, run, ms]);
  return v;
}
