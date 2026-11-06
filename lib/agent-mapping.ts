import type { DomainId } from './domains';
import { RECRUITMENT_DOMAIN_ID } from './domain-ids';

export type Stage =
  | 'system'
  | 'requirement'
  | 'jd'
  | 'resume'
  | 'match'
  | 'interview'
  | 'eval'
  | 'package'
  | 'submit';

export type AgentKind = 'auto' | 'hitl' | 'hybrid';

export type AgentMeta = {
  short: string;
  wsId: string;
  /**
   * Top-level domain container — see lib/domains.tsx. All current 22 agents
   * are 'raas'. Future R7 agents should go into AGENT_MAP_R7 below. Codegen
   * Phase 1+ scopes its tool/event registries by this field.
   */
  domain: DomainId;
  stage: Stage;
  kind: AgentKind;
  ownerTeam: string;
  version: string;
  triggersEvents: string[];
  emitsEvents: string[];
  terminal: boolean;
  /**
   * Human-readable name as registered in Inngest (server/inngest/agents/*.ts).
   * When present this is what the Fleet / Monitor UIs show as the primary
   * identifier so AO mirrors the Inngest dashboard. Falls back to `short`.
   * Shells (registered via stub-factory) use `short` directly.
   */
  inngestName?: string;
  /**
   * Explicit Inngest function id override. Use ONLY when an agent's
   * Inngest function id can't be derived from `short` via the two
   * conventions in lib/inngest-registry.ts (stub-factory `agent.<short>`
   * or real-agent kebab `<kebab-short>-agent`). The 4 real agents'
   * file names map cleanly to kebab IDs, but they predate the convention
   * so we annotate explicitly for clarity + zero ambiguity.
   */
  inngestId?: string;
  /**
   * Audit-only agent (e.g. CandidateDedup): has a real Inngest function but is
   * NOT a deployable main-chain agent — excluded from hasRealInngestFn (Fleet
   * deploy panel / canonical workflow graph) while still merging as 'real'.
   */
  auditOnly?: boolean;
};

// Raw rows (no `domain` field — auto-injected as 'raas' below). When R7
// onboards, add its agents to AGENT_MAP_R7 with explicit `domain: 'r7'`.
const AGENT_MAP_RAAS_RAW: Omit<AgentMeta, 'domain'>[] = [
  { short: 'ReqSync',          wsId: '1-1',     stage: 'system',      kind: 'auto',   ownerTeam: 'HSM·交付',  version: 'v1.4.2', triggersEvents: ['SCHEDULED_SYNC'],                                emitsEvents: ['REQUIREMENT_SYNCED', 'SYNC_FAILED_ALERT'],                                  terminal: false },
  { short: 'ManualEntry',      wsId: '1-2',     stage: 'requirement', kind: 'hitl',   ownerTeam: 'HSM·交付',  version: 'v1.0.0', triggersEvents: ['CLARIFICATION_INCOMPLETE'],                       emitsEvents: ['REQUIREMENT_LOGGED'],                                                       terminal: false },
  { short: 'ReqAnalyzer',      wsId: '2',       stage: 'requirement', kind: 'auto',   ownerTeam: 'HSM·交付',  version: 'v2.1.0', triggersEvents: ['REQUIREMENT_SYNCED', 'REQUIREMENT_LOGGED'],       emitsEvents: ['ANALYSIS_COMPLETED', 'ANALYSIS_BLOCKED'],                                   terminal: false },
  { short: 'Clarifier',        wsId: '3',       stage: 'requirement', kind: 'hybrid', ownerTeam: 'HSM·澄清',  version: 'v1.2.0', triggersEvents: ['ANALYSIS_COMPLETED'],                             emitsEvents: ['CLARIFICATION_INCOMPLETE', 'CLARIFICATION_READY'],                          terminal: false },
  { short: 'ReClarifier',      wsId: '3-2',     stage: 'requirement', kind: 'hitl',   ownerTeam: 'HSM·澄清',  version: 'v1.0.0', triggersEvents: ['CLARIFICATION_INCOMPLETE'],                       emitsEvents: ['CLARIFICATION_RETRY'],                                                      terminal: false },
  { short: 'JDGenerator',      wsId: '4',       stage: 'jd',          kind: 'auto',   ownerTeam: 'HSM·交付',  version: 'v1.9.4', triggersEvents: ['CLARIFICATION_READY', 'JD_REJECTED'],             emitsEvents: ['JD_GENERATED'],                                                             terminal: false, inngestName: 'Create JD Agent', inngestId: 'create-jd-agent' },
  { short: 'JDReviewer',       wsId: '5',       stage: 'jd',          kind: 'hitl',   ownerTeam: 'HSM·交付',  version: 'v1.0.0', triggersEvents: ['JD_GENERATED'],                                   emitsEvents: ['JD_APPROVED', 'JD_REJECTED'],                                               terminal: false },
  { short: 'TaskAssigner',     wsId: '6',       stage: 'jd',          kind: 'auto',   ownerTeam: '招聘运营', version: 'v1.0.0', triggersEvents: ['JD_APPROVED'],                                    emitsEvents: ['TASK_ASSIGNED'],                                                            terminal: false },
  { short: 'Publisher',        wsId: '7-1',     stage: 'jd',          kind: 'auto',   ownerTeam: '招聘运营', version: 'v1.2.0', triggersEvents: ['TASK_ASSIGNED'],                                  emitsEvents: ['CHANNEL_PUBLISHED', 'CHANNEL_PUBLISHED_FAILED'],                            terminal: true  },
  { short: 'ManualPublish',    wsId: '7-2',     stage: 'jd',          kind: 'hitl',   ownerTeam: '招聘运营', version: 'v1.0.0', triggersEvents: ['CHANNEL_PUBLISHED_FAILED'],                       emitsEvents: ['CHANNEL_PUBLISHED'],                                                        terminal: false },
  { short: 'ResumeCollector',  wsId: '8',       stage: 'resume',      kind: 'hybrid', ownerTeam: '招聘运营', version: 'v3.0.1', triggersEvents: ['CHANNEL_PUBLISHED'],                              emitsEvents: ['RESUME_DOWNLOADED'],                                                        terminal: false },
  { short: 'ResumeParser',     wsId: '9-1',     stage: 'resume',      kind: 'auto',   ownerTeam: '招聘运营', version: 'v2.8.0', triggersEvents: ['RESUME_DOWNLOADED'],                              emitsEvents: ['RESUME_PROCESSED', 'RESUME_PARSE_ERROR'],                                   terminal: false, inngestName: 'Resume Parser Agent', inngestId: 'resume-parser-agent' },
  { short: 'ResumeFixer',      wsId: '9-2',     stage: 'resume',      kind: 'hitl',   ownerTeam: '招聘运营', version: 'v1.0.0', triggersEvents: ['RESUME_PARSE_ERROR'],                             emitsEvents: ['RESUME_PROCESSED'],                                                         terminal: false },
  // Candidate identity (去重·是不是同一人) rule-check agent — an independent, AUDIT-ONLY
  // agent at the intake seam (between ResumeParser and RuleCheck). It consumes
  // RESUME_PROCESSED,调规则判断后写 OntologyRuleCheck 审计(/rule-check 面板),
  // 不 emit 任何事件 → 永不拦截主链路。实现见 server/inngest/agents/candidate-identity-agent.ts。
  // 2026-06-11 改名 RuleCheckCandidateIdentity → CandidateDedup:舰队页对齐 Inngest
  // 注册名「候选人查重」(中文主标),短英文 CandidateDedup 做副标。short 改了之后
  // kebab 推导(candidate-dedup-agent)不再命中真函数 ID,所以必须显式 inngestId
  // 保住 registry merge('real'),不进 "canonical 5 deployable"(hasRealInngestFn)。
  // (RuleCheckCandidateOwnership · 归属 withdrawn 2026-06-11 — not deployed, cleared
  //  from this roster; handler source kept at candidate-ownership-agent.ts.)
  { short: 'CandidateDedup',   wsId: '9-3',     stage: 'resume',      kind: 'auto',   ownerTeam: '合规',     version: 'v0.1.0', triggersEvents: ['CANDIDATE_IDENTITY_REQUESTED'],                              emitsEvents: ['CANDIDATE_IDENTITY_CHECKED'],                                                                           terminal: false, inngestName: '候选人查重', inngestId: 'rule-check-candidate-identity-agent' , auditOnly: true },
  // 2026-05-19 consolidation: matchResume 收敛成只订 MATCH_RULE_CHECK_PASSED;
  // 第一段(RESUME_PROCESSED → 拉 JR + 派发)整段并进 RuleCheck。
  // wsId 保持 '10' / '10-5' 以兼容 monitor / topology / workflow-graph 现有节点 ID;
  // 与 partner actions_v0_1_002 的 10-1 / 10-2 在事件名级别对齐(triggers / emits)。
  { short: 'Matcher',          wsId: '10',      stage: 'match',       kind: 'auto',   ownerTeam: '招聘运营', version: 'v3.0.0', triggersEvents: ['MATCH_RULE_CHECK_PASSED'],                       emitsEvents: ['MATCH_PASSED_NEED_INTERVIEW', 'MATCH_PASSED_NO_INTERVIEW', 'MATCH_FAILED'], terminal: false, inngestName: 'Match Resume Agent', inngestId: 'match-resume-agent' },
  // RuleCheck — independent Inngest function. 直接订 RESUME_PROCESSED,
  // 内部 fan-out per JR. 重派场景由 partner 重发 RESUME_PROCESSED 触发,无额外订阅。
  // 见 docs/superpowers/specs/2026-05-19-rule-check-consolidation-design.md
  { short: 'RuleCheck',        wsId: '10-5',    stage: 'match',       kind: 'auto',   ownerTeam: '合规',     version: 'v2.0.0', triggersEvents: ['RESUME_PROCESSED'],                              emitsEvents: ['MATCH_RULE_CHECK_PASSED', 'MATCH_RULE_CHECK_FAILED'],                        terminal: false, inngestName: 'Rule Check Agent', inngestId: 'rule-check-agent' },
  // MatchReviewer (wsId 10-HITL) removed: not in authoritative workflow JSON.
  // MATCH_FAILED is terminal in the canonical workflow spec.
  // 2026-05-25: 由 shell 升级为 real agent。trigger 改为 INTERVIEW_INVITATION_REQUESTED
  // —— matchResumeAgent emit MATCH_PASSED_NEED_INTERVIEW 后由 RaaS 端 HSM/审批
  // 消费,再回发 INTERVIEW_INVITATION_REQUESTED 触发本 agent 调 RoboHire
  // /api/v1/invite-candidate。emits 增加 _FAILED 路径(error_code 分类)。
  // terminal 改 false:本 agent emit 的 _SENT 会被下游 AIInterviewer (wsId 11-2) 接。
  { short: 'InterviewInviter', wsId: '11-1',    stage: 'interview',   kind: 'auto',   ownerTeam: '技术招聘', version: 'v1.0.0', triggersEvents: ['INTERVIEW_INVITATION_REQUESTED'],                  emitsEvents: ['INTERVIEW_INVITATION_SENT', 'INTERVIEW_INVITATION_FAILED'],                  terminal: false, inngestName: 'Interview Inviter Agent', inngestId: 'interview-inviter-agent' },
  { short: 'AIInterviewer',    wsId: '11-2',    stage: 'interview',   kind: 'hybrid', ownerTeam: '技术招聘', version: 'v0.7.2', triggersEvents: ['INTERVIEW_INVITATION_SENT'],                      emitsEvents: ['AI_INTERVIEW_COMPLETED'],                                                   terminal: false },
  { short: 'Evaluator',        wsId: '12',      stage: 'eval',        kind: 'auto',   ownerTeam: '技术招聘', version: 'v1.6.0', triggersEvents: ['AI_INTERVIEW_COMPLETED'],                         emitsEvents: ['EVALUATION_PASSED', 'EVALUATION_FAILED'],                                   terminal: false },
  { short: 'ResumeRefiner',    wsId: '13',      stage: 'resume',      kind: 'auto',   ownerTeam: '招聘运营', version: 'v1.1.0', triggersEvents: ['EVALUATION_PASSED', 'MATCH_PASSED_NO_INTERVIEW'], emitsEvents: ['RESUME_OPTIMIZED'],                                                         terminal: false },
  { short: 'PackageBuilder',   wsId: '14-1',    stage: 'package',     kind: 'auto',   ownerTeam: '招聘运营', version: 'v1.1.2', triggersEvents: ['RESUME_OPTIMIZED'],                               emitsEvents: ['PACKAGE_GENERATED', 'PACKAGE_MISSING_INFO'],                                terminal: false },
  { short: 'PackageFiller',    wsId: '14-2',    stage: 'package',     kind: 'hitl',   ownerTeam: '招聘运营', version: 'v1.0.0', triggersEvents: ['PACKAGE_MISSING_INFO'],                           emitsEvents: ['PACKAGE_GENERATED'],                                                        terminal: false },
  { short: 'PackageReviewer',  wsId: '15',      stage: 'package',     kind: 'hitl',   ownerTeam: 'HSM·交付',  version: 'v1.0.0', triggersEvents: ['PACKAGE_GENERATED'],                              emitsEvents: ['PACKAGE_APPROVED'],                                                         terminal: false },
  { short: 'PortalSubmitter',  wsId: '16',      stage: 'submit',      kind: 'auto',   ownerTeam: '招聘运营', version: 'v2.0.0', triggersEvents: ['PACKAGE_APPROVED'],                               emitsEvents: ['APPLICATION_SUBMITTED', 'SUBMISSION_FAILED'],                               terminal: true  },
  // System-level meta agent (not on workflow canvas). Registered so
  // /api/agents/Chatbot/explain + /api/agents/Chatbot/activity work and
  // chatbot audit rows surface in cross-agent UIs.
  // terminal=true because it emits no events and is outside the business
  // workflow chain (trigger-or-terminal invariant in agent-mapping.test.ts).
  { short: 'Chatbot',          wsId: 'system-chatbot', stage: 'system', kind: 'auto',   ownerTeam: 'AO·UI',     version: 'v1.0.0', triggersEvents: [],                                                 emitsEvents: [],                                                                           terminal: true  },
];

// Empty until R7 onboarding. New R7 agents go here with explicit domain.
const AGENT_MAP_R7: AgentMeta[] = [];

// Recruitment agents' domain is the live Allmeta recruitment domain id
// (RECRUITMENT_DOMAIN_ID) so they scope under the business-domain the switcher
// lists. Rename the domain in Allmeta → update lib/domain-ids.ts only.
export const AGENT_MAP: AgentMeta[] = [
  ...AGENT_MAP_RAAS_RAW.map((a): AgentMeta => ({ ...a, domain: RECRUITMENT_DOMAIN_ID })),
  ...AGENT_MAP_R7,
];

export function byShort(s: string): AgentMeta | undefined {
  return AGENT_MAP.find((a) => a.short === s);
}

export function byWsId(id: string): AgentMeta | undefined {
  return AGENT_MAP.find((a) => a.wsId === id);
}

/**
 * Resolve an AGENT_MAP entry from an Inngest function slug (kebab-case agent id).
 * Matches either an explicit `inngestId` OR the derived `<kebab-short>-agent`
 * convention. Used by codegen's save-as-version flow to map a generated slug
 * back to a known agent short — same algorithm as the version API route.
 */
export function byInngestSlug(slug: string): AgentMeta | undefined {
  return AGENT_MAP.find((a) => {
    if (a.inngestId === slug) return true;
    const derived =
      a.short.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() + '-agent';
    return derived === slug;
  });
}

/** Inngest registers AO functions under an app-prefixed slug, e.g.
 *  `agentic-operator-main-rule-check-agent` — that prefixed slug is what the
 *  Inngest archive stores in WorkflowStep.nodeId / function_slug. */
export const INNGEST_APP_PREFIX = 'agentic-operator-main-';

/**
 * Resolve an AgentMeta from ANY identifier the system produces: a canonical
 * short ('RuleCheck'), a bare Inngest fn id ('rule-check-agent'), or the
 * app-prefixed Inngest slug ('agentic-operator-main-rule-check-agent'). This is
 * the resolver observability paths (run-summary, audit) must use — `byShort`
 * alone misses archive slugs and leaks the raw slug into user-facing output.
 * Returns undefined only for genuinely unknown ids.
 */
export function resolveAgentMeta(idOrSlug: string): AgentMeta | undefined {
  if (!idOrSlug) return undefined;
  return (
    byShort(idOrSlug) ??
    byInngestSlug(idOrSlug) ??
    byInngestSlug(
      idOrSlug.startsWith(INNGEST_APP_PREFIX)
        ? idOrSlug.slice(INNGEST_APP_PREFIX.length)
        : idOrSlug,
    )
  );
}

// Agent realness derivation moved to lib/inngest-registry.ts which queries
// Inngest live. These sync helpers read the LAST cached snapshot of that
// registry. First call returns 'unbuilt' until fetchLiveRegistry() populates
// the cache; routine UI flow always reads /api/agents which forces the cache
// fill in the server-side render path.
//
// The cache lives in lib/inngest-registry-cache.ts (one-direction import only)
// to avoid a cycle (lib/inngest-registry.ts already imports AGENT_MAP from here).
//
// Per spec 2026-05-24 §3.3.

import { __getCachedRegistrySnapshotSync } from '@/lib/inngest-registry-cache';

export function isReal(short: string): boolean {
  const snap = __getCachedRegistrySnapshotSync();
  return snap.find((e) => e.short === short)?.realness === 'real';
}

/**
 * Deterministic, registry-cache-INDEPENDENT check: does this AGENT_MAP entry map
 * to a real, registered Inngest production function? The real agents are the only
 * entries carrying an explicit `inngestId`. Unlike isReal()/deploymentKind()
 * (which read the live-registry cache and return 'unbuilt' until it fills), this
 * is pure — safe to use server-side at boot and inside route handlers where the
 * registry snapshot may not be populated yet. Used to scope the Fleet「部署智能体」
 * deploy panel to the agents we actually have (vs the legacy design-era roster).
 */
export function hasRealInngestFn(short: string): boolean {
  const a = byShort(short);
  // auditOnly(如 CandidateDedup):有真函数但不属于「可部署的主链路 agent」——
  // 它有显式 inngestId 只是为了 registry merge,不进 Fleet 部署面板/canonical 图。
  return Boolean(a?.inngestId) && !a?.auditOnly;
}

/**
 * Display name used by Fleet / Monitor / Events / Workflow UIs as the primary
 * label. Mirrors the name registered in Inngest (see
 * server/inngest/agents/*.ts → createFunction({ name })). Falls back to short
 * for shells / unbuilt agents whose Inngest name is just the short.
 */
export function displayName(short: string): string {
  const meta = byShort(short);
  return meta?.inngestName ?? short;
}

// "Shell" = registered as an empty-shell Inngest function via stub-factory.
// Per spec 2026-05-24, this is now derived from the live registry rather
// than computed from AGENT_MAP heuristics.
export function isShell(short: string): boolean {
  const snap = __getCachedRegistrySnapshotSync();
  return snap.find((e) => e.short === short)?.realness === 'shell';
}

// Deployment kind for fleet / monitor UIs.
//   real    — production Inngest function with full business logic
//   shell   — registered empty-shell Inngest function (demo / placeholder)
//   unbuilt — no Inngest function (or registry cache not yet populated)
export type DeploymentKind = "real" | "shell" | "unbuilt";
export function deploymentKind(short: string): DeploymentKind {
  const snap = __getCachedRegistrySnapshotSync();
  return snap.find((e) => e.short === short)?.realness ?? 'unbuilt';
}
