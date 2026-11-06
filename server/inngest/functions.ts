// AO-main Inngest function registry.
//
// p4 merge (kenny/steven 2026-05): 原 resume-parser-agent (port 3020) 的
// 3 个 agent 文件被搬进 server/inngest/agents/。Inngest dev server 至此
// 只同步一个 SDK 端点，所有 functions 在一个 dashboard 里看见。
//
// RAAS-v1 main app (real production agents 6 个):
//   REQUIREMENT_LOGGED       → createJdAgent       → JD_GENERATED
//   RESUME_DOWNLOADED        → resumeParserAgent   → RESUME_PROCESSED
//   RESUME_PROCESSED         → candidateIdentityAgent (invoke + audit)
//   RESUME_PROCESSED         → ruleCheckAgent (10-1, per-JR fan-out)
//                                                  → MATCH_RULE_CHECK_PASSED / MATCH_RULE_CHECK_FAILED
//   MATCH_RULE_CHECK_PASSED  → matchResumeAgent (10-2)
//                                                  → MATCH_PASSED_NO_INTERVIEW
//                                                    MATCH_PASSED_NEED_INTERVIEW
//                                                    MATCH_FAILED
//   INTERVIEW_INVITATION_REQUESTED → interviewInviterAgent
//                                                  → INTERVIEW_INVITATION_SENT / _FAILED
//
// 重派场景:partner 重发 RESUME_PROCESSED(带新 job_requisition_id)即触发
// ruleCheck path-A,无新订阅。详见 docs/superpowers/specs/2026-05-19-rule-check-consolidation-design.md
//
// 演示用 stub agent（可选，默认关）—— 给 fleet / workflow 可视化页面提供
// 模拟数据流。Stub 收事件 → 写 AgentActivity → sleep → emit 下游事件 →
// HITL 节点 5s 后自动 resolve。要开演示设 STUB_AGENTS=1 或跑 npm run dev:demo。
//
// Env gates:
//   STUB_AGENTS=1        — 开启 demo stub agents（默认关：只跑 RAAS-v1 6 real）
//   STUB_SUCCESS_RATE    — default 0.9（90% take happy path）
//   STUB_HITL_DELAY_MS   — default 5000ms（HITL auto-resolve delay）
//   STUB_RPA_OWNED=1     — 让 stub-factory 也为 wsId 4/9-1/10 生成 stub
//                          （会跟 real agent 抢同名事件，仅 dev 隔离测试用）

import { AGENT_MAP } from "@/lib/agent-mapping";
import { RAAS_V1_EXPECTED_FUNCTION_COUNT } from "@/lib/raas-v1-inngest";
import { assertRaasV1FunctionSet } from "./raas-v1";
import { createStubAgent } from "./agents/stub-factory";

// RAAS-v1 real production agents. This list is validated against
// lib/raas-v1-inngest.ts at module load so a stray cross-domain import fails
// loudly instead of silently registering into agentic-operator-main.
import { resumeParserAgent } from "./agents/resume-parser-agent";
import { createJdAgent } from "./agents/create-jd-agent";
import { matchResumeAgent } from "./agents/match-resume-agent";
import { ruleCheckAgent } from "./agents/rule-check-agent";  // NEW PR-4
import { interviewInviterAgent } from "./agents/interview-inviter-agent"; // 2026-05-25
// Candidate identity (去重) rule-check agent. Audit-only, registered by default.
// (The 归属/ownership rule-check agent was withdrawn 2026-06-11 — not deployed; its
//  source remains at agents/candidate-ownership-agent.ts for easy re-enable.)
import { candidateIdentityAgent } from "./agents/candidate-identity-agent";

// Energy-dispatch agents are intentionally NOT registered into this app.
// agentic-operator-main is the RECRUITMENT app — it must only ever serve the real
// recruitment agents. Energy (能源调度-v1) has its OWN per-domain Inngest app,
// `agentic-operator-能源调度-v1`, served at /api/inngest/<domain> (see
// server/inngest/domain-app.ts). This was previously gated behind ENERGY_AGENTS=1
// which double-registered energy into BOTH apps and polluted the recruitment app;
// the registration is removed here so a restart / re-sync can never bring it back,
// regardless of the ENERGY_AGENTS env flag. 2026-06-02.

// wsIds owned by the real agents above. Stub-factory MUST skip these to avoid
// double-handling of trigger events (race condition) AND a duplicate function in the
// Inngest dashboard (real fn + stub fn for the same AGENT_MAP row).
// "11-1" = interviewInviterAgent;AGENT_MAP wsId 11-1 已从 shell 升 real(见
// lib/agent-mapping.ts 2026-05-25 注释)。
// "9-3" = rule-check-candidate-identity-agent(real,下方注册)→ 不让 stub-factory
// 再为它生成同名 stub(否则 Inngest 上重复出现 候选人查重/CandidateDedup)。
// (9-4 / ownership withdrawn 2026-06-11 — no AGENT_MAP row, so no stub to suppress.)
const RPA_OWNED_WSIDS = new Set(["4", "9-1", "9-3", "10", "10-5", "11-1"]);

// Set STUB_RPA_OWNED=1 to re-enable stubs for these wsIds (dev/isolation).
const STUB_RPA_OWNED = process.env.STUB_RPA_OWNED === "1";

// Demo stubs are OFF by default so a production deployment has a clean event
// bus — only the 6 RAAS-v1 real agents react, driven by real RAAS-emitted events.
// Every business agent in AGENT_MAP (except real ones + Chatbot) CAN register
// as an empty-shell Inngest function that fakes a downstream event cascade,
// useful for /fleet · /monitor · /workflow visualisation demos. Opt in with
// STUB_AGENTS=1 or `npm run dev:demo`; normal dev/prod leave it off.
const STUB_AGENTS_ENABLED = process.env.STUB_AGENTS === "1";

// Build a stub per business agent with at least one trigger event.
// Chatbot has triggersEvents=[] so it is naturally excluded.
const businessAgents = AGENT_MAP.filter((a) => {
  if (a.short === "Chatbot") return false;
  if (a.triggersEvents.length === 0) return false;
  if (!STUB_RPA_OWNED && RPA_OWNED_WSIDS.has(a.wsId)) return false;
  return true;
});

const stubFunctions = STUB_AGENTS_ENABLED
  ? businessAgents
      .map(createStubAgent)
      .filter((fn): fn is NonNullable<typeof fn> => fn !== null)
  : [];

export const raasV1Functions = [
  createJdAgent,
  resumeParserAgent,
  // Candidate identity (去重) rule-check agent. Registered UNCONDITIONALLY so it
  // appears in the Inngest dashboard + Fleet (/api/agents surfaces live functions
  // even when not in AGENT_MAP). AUDIT-ONLY — writes OntologyRuleCheck rows for
  // /rule-check and emits NO events, so it never gates the recruitment pipeline.
  // Enabled by default; CANDIDATE_IDENTITY_ENABLED=0 no-ops it without unregistering.
  // (The 归属/ownership rule-check agent was withdrawn 2026-06-11 — see import note.)
  candidateIdentityAgent,
  ruleCheckAgent,
  matchResumeAgent,
  interviewInviterAgent,
];

assertRaasV1FunctionSet(raasV1Functions);

export const allFunctions = [
  ...raasV1Functions,
  ...stubFunctions,
];

// Server-side startup log so operators can confirm registration count.
// (energy-dispatch agents are NOT part of this app — see note above.)
if (typeof window === "undefined") {
  // eslint-disable-next-line no-console
  console.log(
    `[inngest] registered ${raasV1Functions.length}/${RAAS_V1_EXPECTED_FUNCTION_COUNT} RAAS-v1 real + ` +
      `${stubFunctions.length} stub = ${allFunctions.length} total ` +
      `(STUB_AGENTS=${STUB_AGENTS_ENABLED ? "1" : "0"})`,
  );
}
