// The GOLD STANDARD — the 招聘-v1 production agents, reverse-engineered into a
// comparable contract so the factory's regeneration (in the Agents-generation
// domain, reading the SAME Neo4j ontology) can be graded against "what good looks
// like". The 6 real recruitment agents ARE the answer key.
//
// Honest reverse-engineering (no hand-keyed expectations):
//   · each ontology action is paired to its real agent by EVENT SIGNATURE (the same
//     signature scoring the Selection Harness uses) — so the pairing itself is
//     derived, not declared;
//   · trigger/emit (the decision-branch outcomes) come from AGENT_MAP, the
//     authoritative registry of the real agents;
//   · the real tool calls are scanned out of the actual agent source (.ts) — this is
//     the "reverse-engineer the code" part.
//
// The scorer is pure + deterministic; the source scan is best-effort (graceful when
// a file path can't be resolved → tool dimension simply doesn't count).

import { AGENT_MAP } from "@/lib/agent-mapping";
import { scoreAgent } from "./selection";
import { extractAgentTools } from "./agent-source-scan";
import type { RegistryAgent } from "./types";

export { extractAgentTools };

export interface GoldStandardAgent {
  /** the ontology action this real agent is the standard for. */
  action: string;
  short: string;
  inngestId: string;
  trigger: string[];
  /** emitted events = the decision-branch outcomes the real agent produces. */
  emit: string[];
  /** namespaced tool calls scanned from the real agent source (robohire.*, …). */
  tools: string[];
  /** how confidently this action was paired to this real agent (signature score). */
  pairConfidence: number;
  sourceRef: string;
}

/** The real recruitment agents, as RegistryAgent (signature from AGENT_MAP, tools
 *  reverse-engineered from source). These are the standard-bearers. */
export function realAgentsWithTools(): Array<RegistryAgent & { tools: string[] }> {
  return AGENT_MAP
    .filter((a) => a.inngestId && ((a.triggersEvents?.length ?? 0) + (a.emitsEvents?.length ?? 0) > 0))
    .map((a) => ({
      id: a.inngestId!, name: a.short, source: "handwritten" as const, domain: a.domain,
      capability: a.short, triggerEvents: a.triggersEvents ?? [], emitEvents: a.emitsEvents ?? [],
      tools: extractAgentTools(a.inngestId!, a.short),
      codeRef: `@/server/inngest (${a.inngestId})`, status: "preset", sandboxProven: true,
    }));
}

/** Build the gold standard for a domain: for each ontology agent-action, pair it to
 *  the best-matching real agent BY SIGNATURE (derived, not declared). Actions with
 *  no signature-similar real agent get no standard (the factory is on its own there
 *  — and the comparison will say so). */
export function buildGoldStandard(
  actions: Array<{ action: string; triggerEvents: string[]; emitEvents: string[] }>,
  reals: Array<RegistryAgent & { tools: string[] }> = realAgentsWithTools(),
  minConfidence = 0.4,
): GoldStandardAgent[] {
  const out: GoldStandardAgent[] = [];
  for (const act of actions) {
    let best: (RegistryAgent & { tools: string[] }) | null = null;
    let bestScore = 0;
    for (const r of reals) {
      const s = scoreAgent(r, { triggerEvents: act.triggerEvents, emitEvents: act.emitEvents, capability: act.action });
      if (s.score > bestScore) { bestScore = s.score; best = r; }
    }
    if (!best || bestScore < minConfidence) continue;
    out.push({
      action: act.action, short: best.name, inngestId: best.id,
      trigger: best.triggerEvents, emit: best.emitEvents, tools: best.tools,
      pairConfidence: Number(bestScore.toFixed(2)), sourceRef: best.codeRef,
    });
  }
  return out;
}

export interface StandardScore {
  action: string;
  /** trigger+emit signature alignment (Jaccard over the union). */
  signatureMatch: number;
  /** fraction of the standard's decision-branch outcomes (emit events) the
   *  generated agent also produces — the key "did it cover all the cases" metric. */
  branchCoverage: number;
  /** fraction of the standard's tools the generated agent binds (0..1, or null when
   *  the standard's tools couldn't be scanned → dimension excluded). */
  toolCoverage: number | null;
  total: number;
  notes: string[];
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a), B = new Set(b);
  if (A.size === 0 && B.size === 0) return 1;
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni === 0 ? 0 : inter / uni;
}

/** Grade ONE generated agent against the standard for its action. */
export function scoreAgainstStandard(generated: RegistryAgent, std: GoldStandardAgent): StandardScore {
  const sigT = jaccard(generated.triggerEvents, std.trigger);
  const sigE = jaccard(generated.emitEvents, std.emit);
  const signatureMatch = (sigT + sigE) / 2;
  // branch coverage: of the standard's emit outcomes, how many does generated produce?
  const stdEmit = new Set(std.emit);
  const covered = std.emit.length ? std.emit.filter((e) => generated.emitEvents.includes(e)).length / std.emit.length : 1;
  const branchCoverage = covered;
  // tool coverage: of the standard's tools, how many does generated bind? (by tool
  // identifier OR same namespace — generated may name them slightly differently).
  let toolCoverage: number | null = null;
  if (std.tools.length) {
    const genNs = new Set(generated.tools.map((t) => t.toLowerCase()));
    const hit = std.tools.filter((t) => {
      const tl = t.toLowerCase();
      const ns = tl.split(".")[0];
      return genNs.has(tl) || [...genNs].some((g) => g.startsWith(ns + ".") || g === ns);
    }).length;
    toolCoverage = hit / std.tools.length;
  }
  const notes: string[] = [];
  const missingBranches = std.emit.filter((e) => !generated.emitEvents.includes(e));
  if (missingBranches.length) notes.push(`漏掉决策分支：${missingBranches.join("、")}`);
  if (!stdEmit.size) notes.push("标准无产出事件(终态 agent)");
  if (toolCoverage !== null && toolCoverage < 1) notes.push(`工具覆盖 ${Math.round(toolCoverage * 100)}%(标准用 ${std.tools.join("、")})`);
  // total: signature 0.4 + branch 0.4 + tool 0.2 (renormalized when tool excluded)
  const total = toolCoverage === null
    ? signatureMatch * 0.5 + branchCoverage * 0.5
    : signatureMatch * 0.4 + branchCoverage * 0.4 + toolCoverage * 0.2;
  return { action: std.action, signatureMatch: +signatureMatch.toFixed(2), branchCoverage: +branchCoverage.toFixed(2), toolCoverage: toolCoverage === null ? null : +toolCoverage.toFixed(2), total: +total.toFixed(2), notes };
}

export interface StandardComparison {
  domain: string;
  scores: Array<StandardScore & { matchedGenerated: string | null }>;
  /** actions with a standard that NOTHING generated covered. */
  uncovered: string[];
  /** mean total over scored actions. */
  meanTotal: number;
  summary: string;
}

/** Compare a whole generated set against the gold standard for a domain: pair each
 *  standard action to the best generated agent (by signature), grade it. */
export function compareToStandard(
  generated: RegistryAgent[],
  standard: GoldStandardAgent[],
  domain: string,
): StandardComparison {
  const scores: Array<StandardScore & { matchedGenerated: string | null }> = [];
  const uncovered: string[] = [];
  for (const std of standard) {
    // pick the generated agent that best fits this action's standard signature
    let best: RegistryAgent | null = null;
    let bestSig = -1;
    for (const g of generated) {
      const sig = (jaccard(g.triggerEvents, std.trigger) + jaccard(g.emitEvents, std.emit)) / 2;
      if (sig > bestSig) { bestSig = sig; best = g; }
    }
    if (!best || bestSig <= 0) { uncovered.push(std.action); continue; }
    scores.push({ ...scoreAgainstStandard(best, std), matchedGenerated: best.name });
  }
  const meanTotal = scores.length ? +(scores.reduce((s, x) => s + x.total, 0) / scores.length).toFixed(2) : 0;
  return {
    domain, scores, uncovered, meanTotal,
    summary: `对标 ${standard.length} 个标准动作：评分 ${scores.length} 个(均分 ${meanTotal})、未覆盖 ${uncovered.length} 个${uncovered.length ? `(${uncovered.join("、")})` : ""}。`,
  };
}
