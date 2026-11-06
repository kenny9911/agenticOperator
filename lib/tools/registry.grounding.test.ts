// Fix #2 — tool-name grounding. The factory's LLM authors per-agent tool picks
// from the catalog, but it invents lexical variants ("parseResumeFile") that the
// strict resolver couldn't bridge to the real namespaced names
// ("robohire.parseResume"), so every generated agent bound ZERO real tools.
//
// These tests pin two grounding mechanisms:
//   1. resolveToolName — conservative token-superset fuzzy fallback. Resolves a
//      near-miss ONLY when the catalog tool's whole meaningful name is contained
//      in the query (so it never binds a semantically-wrong tool).
//   2. suggestToolsForAction — ranks the real catalog against an action so
//      read_ontology can hand the brain grounded candidates + design_agent can
//      floor an agent with real tools when the LLM's picks don't resolve.

import { describe, it, expect } from "vitest";
import { ToolRegistry, resolveToolName, suggestToolsForAction, groundToolPicks, type ToolDescriptor } from "./registry";

// The real recruitment library names (the 18 the brain must ground to).
const NAMES: Array<[string, string, string]> = [
  ["minio.getResume", "下载简历原件", "从 MinIO 对象存储下载候选人简历原件"],
  ["robohire.parseResume", "解析简历", "把简历 PDF 解析为结构化字段"],
  ["robohire.matchResume", "简历匹配评分", "对候选人简历与岗位 JD 做匹配评分,返回总分与维度理由"],
  ["robohire.generateJd", "生成 JD", "由招聘需求生成 JD 文案"],
  ["robohire.inviteCandidate", "发送面试邀约", "向候选人发送面试邀约"],
  ["partnerpg.getRequirement", "读取招聘需求", "读取岗位需求明细 Job_Requisition"],
  ["partnerpg.getParsedResume", "读取已解析简历", "读取已结构化的候选人简历"],
  ["partnerpg.saveCandidate", "落库候选人", "把候选人+简历写入主表"],
  ["partnerpg.saveMatchResults", "落库匹配结果", "把匹配评分结果写入 Candidate_Match_Result"],
  ["partnerpg.saveRuleCheckFail", "落库规则未通过", "规则校验未通过时写入 match_status=未通过"],
  ["partnerpg.syncJd", "落库 JD", "把生成的 JD 写入 partner Postgres"],
  ["partnerpg.markInterview", "标记面试已邀约", "标记面试邀约已发送"],
  ["allmeta.getInstance", "读取本体实例", "按 label 主键读取一个实例"],
  ["allmeta.writeInstance", "写入本体实例", "把一个实例写入 Neo4j"],
  ["allmeta.searchEntities", "检索本体实体", "按类型关键字检索实体"],
  ["candidateLock.runLockCheck", "候选人锁定去重", "对候选人做三级去重与归属锁定判定"],
  ["llm.complete", "LLM 补全", "通用 LLM 调用"],
  ["llm.fieldJudge", "字段等价判定", "用 LLM 判定两个字段是否等价"],
];

function reg(): ToolRegistry {
  const r = new ToolRegistry();
  for (const [name, title, description] of NAMES) {
    r.register({
      name, title, description,
      domain: "recruit-gen-v1", sideEffect: "read",
      parameters: { type: "object" }, returns: { type: "object" },
    } as ToolDescriptor);
  }
  return r;
}

describe("resolveToolName — exact + strict (unchanged)", () => {
  const r = reg();
  it("exact name resolves to itself", () => {
    expect(resolveToolName("robohire.parseResume", r)).toBe("robohire.parseResume");
  });
  it("normalized contains still works", () => {
    expect(resolveToolName("robohire_parseResume", r)).toBe("robohire.parseResume");
  });
});

describe("resolveToolName — conservative token-superset fuzzy (Fix #2)", () => {
  const r = reg();
  // Real LLM-invented names from the failing run → must bridge to real tools.
  it("parseResumeFile → robohire.parseResume", () => {
    expect(resolveToolName("parseResumeFile", r)).toBe("robohire.parseResume");
  });
  it("generateJDContent → robohire.generateJd", () => {
    expect(resolveToolName("generateJDContent", r)).toBe("robohire.generateJd");
  });
  it("saveCandidateRecord → partnerpg.saveCandidate", () => {
    expect(resolveToolName("saveCandidateRecord", r)).toBe("partnerpg.saveCandidate");
  });
  it("queryCandidateLockStatus → candidateLock.runLockCheck", () => {
    expect(resolveToolName("queryCandidateLockStatus", r)).toBe("candidateLock.runLockCheck");
  });

  // MUST NOT bind a semantically-wrong tool (no blacklist tool exists).
  it("checkBlacklistStatus → undefined (no false bind)", () => {
    expect(resolveToolName("checkBlacklistStatus", r)).toBeUndefined();
  });
  it("getTencentEmploymentHistory → undefined (no such tool)", () => {
    expect(resolveToolName("getTencentEmploymentHistory", r)).toBeUndefined();
  });
  it("empty / junk → undefined", () => {
    expect(resolveToolName("", r)).toBeUndefined();
    expect(resolveToolName("xyz", r)).toBeUndefined();
  });
});

describe("suggestToolsForAction — rank real catalog against an action (Fix #2)", () => {
  const r = reg();
  it("matchResume action surfaces robohire.matchResume in the top picks", () => {
    const out = suggestToolsForAction(
      { name: "matchResume", target_objects: ["Resume", "Candidate", "Job_Requisition", "Application"] },
      r, 5,
    );
    expect(out).toContain("robohire.matchResume");
  });
  it("processResume action surfaces a parse/read resume tool", () => {
    const out = suggestToolsForAction(
      { name: "processResume", target_objects: ["Resume", "Candidate"] },
      r, 5,
    );
    expect(out.some((n) => n === "robohire.parseResume" || n === "minio.getResume" || n === "partnerpg.getParsedResume")).toBe(true);
  });
  it("returns at most `limit` tools, all real catalog names", () => {
    const out = suggestToolsForAction({ name: "createJD", target_objects: ["Job_Requisition"] }, r, 3);
    expect(out.length).toBeLessThanOrEqual(3);
    for (const n of out) expect(r.has(n)).toBe(true);
  });
});

// P1 — De-Hallucinator grounding signal. The fuzzy resolver still BRIDGES an
// invented variant onto the real tool (so agents bind real tools), but the bind
// must no longer be SILENT: the brain is told which picks were exact, which were
// bridged (LLM wrote a non-real name → real tool), and which had no tool at all,
// so it can confirm/re-pick instead of unknowingly shipping a guessed binding.
describe("groundToolPicks — exact / bridged / unresolved classification (P1)", () => {
  const r = reg();
  it("an exact real catalog name is grounded as exact (no bridge)", () => {
    const g = groundToolPicks(["robohire.parseResume"], r);
    expect(g.exact).toContain("robohire.parseResume");
    expect(g.bridged).toEqual([]);
    expect(g.unresolved).toEqual([]);
  });

  it("an invented variant is reported as BRIDGED with the real name (not silent)", () => {
    const g = groundToolPicks(["parseResumeFile"], r);
    expect(g.bridged).toContainEqual({ raw: "parseResumeFile", resolved: "robohire.parseResume" });
    expect(g.exact).toEqual([]);
    expect(g.unresolved).toEqual([]);
  });

  it("a name with no real tool is reported as unresolved (a gap to fill, not a wrong bind)", () => {
    const g = groundToolPicks(["checkBlacklistStatus"], r);
    expect(g.unresolved).toContain("checkBlacklistStatus");
    expect(g.bridged).toEqual([]);
  });

  it("classifies a mixed pick list", () => {
    const g = groundToolPicks(["robohire.matchResume", "saveCandidateRecord", "getTencentEmploymentHistory"], r);
    expect(g.exact).toEqual(["robohire.matchResume"]);
    expect(g.bridged).toContainEqual({ raw: "saveCandidateRecord", resolved: "partnerpg.saveCandidate" });
    expect(g.unresolved).toEqual(["getTencentEmploymentHistory"]);
  });
});
