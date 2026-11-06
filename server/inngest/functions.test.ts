import { beforeEach, describe, expect, it, vi } from "vitest";
import { RAAS_V1_FUNCTION_IDS } from "@/lib/raas-v1-inngest";

const fakeFunction = vi.hoisted(() => (id: string) => ({ opts: { id }, id: () => id }));

vi.mock("./agents/create-jd-agent", () => ({
  createJdAgent: fakeFunction("create-jd-agent"),
}));
vi.mock("./agents/resume-parser-agent", () => ({
  resumeParserAgent: fakeFunction("resume-parser-agent"),
}));
vi.mock("./agents/candidate-identity-agent", () => ({
  candidateIdentityAgent: fakeFunction("rule-check-candidate-identity-agent"),
}));
vi.mock("./agents/rule-check-agent", () => ({
  ruleCheckAgent: fakeFunction("rule-check-agent"),
}));
vi.mock("./agents/match-resume-agent", () => ({
  matchResumeAgent: fakeFunction("match-resume-agent"),
}));
vi.mock("./agents/interview-inviter-agent", () => ({
  interviewInviterAgent: fakeFunction("interview-inviter-agent"),
}));

vi.mock("@/lib/agent-mapping", () => ({
  AGENT_MAP: [
    { short: "DemoA", wsId: "demo-a", triggersEvents: ["DEMO_A"] },
    { short: "Chatbot", wsId: "system-chatbot", triggersEvents: [] },
  ],
}));

vi.mock("./agents/stub-factory", () => ({
  createStubAgent: (agent: { short: string }) => fakeFunction(`agent.${agent.short.toLowerCase()}`),
}));

function functionIds(functions: readonly unknown[]): string[] {
  return functions.map((fn) => (fn as { opts?: { id?: string } }).opts?.id ?? "");
}

describe("RAAS-v1 Inngest function registry", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.STUB_AGENTS;
    delete process.env.STUB_RPA_OWNED;
  });

  it("registers exactly the six RAAS-v1 real functions by default", async () => {
    const mod = await import("./functions");

    expect(functionIds(mod.raasV1Functions)).toEqual([...RAAS_V1_FUNCTION_IDS]);
    expect(functionIds(mod.allFunctions)).toEqual([...RAAS_V1_FUNCTION_IDS]);
  });

  it("adds demo stubs only when STUB_AGENTS is explicitly enabled", async () => {
    process.env.STUB_AGENTS = "1";
    const mod = await import("./functions");

    expect(functionIds(mod.raasV1Functions)).toEqual([...RAAS_V1_FUNCTION_IDS]);
    expect(functionIds(mod.allFunctions)).toEqual([
      ...RAAS_V1_FUNCTION_IDS,
      "agent.demoa",
    ]);
  });
});
