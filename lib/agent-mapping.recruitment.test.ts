import { describe, it, expect } from "vitest";
import { AGENT_MAP, hasRealInngestFn } from "@/lib/agent-mapping";
import { RECRUITMENT_DOMAIN_ID } from "@/lib/domain-ids";
import { RAAS_V1_FUNCTION_IDS } from "@/lib/raas-v1-inngest";

// Locks the RAAS-v1 recruitment invariants:
// - agentic-operator-main registers exactly 6 Inngest functions (including the
//   audit-only CandidateDedup function).
// - the Fleet「部署智能体」panel still exposes only the 5 deployable main-chain
//   agents; audit-only functions are manageable but not deploy targets.
describe("canonical real recruitment agents", () => {
  const reals = AGENT_MAP.filter((a) => a.domain === RECRUITMENT_DOMAIN_ID && hasRealInngestFn(a.short));
  const registered = AGENT_MAP.filter((a) => a.domain === RECRUITMENT_DOMAIN_ID && a.inngestId);

  it("maps exactly the 6 RAAS-v1 registered function ids", () => {
    expect(registered.map((a) => a.inngestId).sort()).toEqual([...RAAS_V1_FUNCTION_IDS].sort());
  });

  it("keeps the deploy panel scoped to the 5 non-audit real agents", () => {
    expect(reals.map((a) => a.short).sort()).toEqual(
      ["InterviewInviter", "JDGenerator", "Matcher", "ResumeParser", "RuleCheck"].sort(),
    );
  });

  it("each real agent carries an explicit inngestId (deterministic, registry-free)", () => {
    for (const a of reals) expect(a.inngestId).toBeTruthy();
  });

  it("excludes legacy design-era stub/unbuilt shorts", () => {
    for (const short of ["ReqSync", "ManualEntry", "Clarifier", "ReClarifier", "PortalSubmitter"]) {
      expect(hasRealInngestFn(short)).toBe(false);
    }
  });
});
