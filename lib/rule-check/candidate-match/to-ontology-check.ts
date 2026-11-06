// Map engine results → the generic OntologyRuleCheck shape, so the /rule-check facet
// page renders them via passOf (PASS iff !redlineFlag && selectionOk && decision===
// 'VALIDATED'). One CandidateEval per rule → an OntologyRuleCheckEval row; FAIL evals
// surface as "flags" on the page.

import type { IdentityMatchResult, IdentityRuleOutcome } from './identity-engine';
import type { OwnershipDecision } from './ownership-engine';
import type { OwnershipRule } from './rules-data';

export interface CandidateEval {
  ruleId: string;
  ruleName: string;
  ruleGroup: string;
  hardSoft: 'hard' | 'soft';
  result: 'PASS' | 'FAIL' | 'NA';
  checkPoint?: string;
  evidence?: string;
}

export interface CandidateOntologyCheck {
  decision: 'VALIDATED' | 'VIOLATED';
  redlineFlag: boolean;
  selectionOk: boolean;
  rulesTotal: number;
  rulesSelected: number;
  rulesExpected: number;
  rulesEvaluated: number;
  evals: CandidateEval[];
}

function evidenceOf(o: IdentityRuleOutcome): string {
  return o.fieldResults
    .map((f) => `${f.field}:${f.method}${f.equivalent ? '✓' : '✗'}`)
    .join(' · ');
}

/** Who the dedup linked this candidate to — woven into the matched rule's checkPoint
 *  so the /rule-check detail drawer (which renders checkPoint) shows it without a
 *  drawer/API change. */
export interface IdentityLinkInfo {
  matchedCandidateId?: string | null;
  matchedCandidateName?: string | null;
  dedupAction?: 'auto-merged' | 'pending-review' | 'new-candidate';
}

/** The single ontology rule (9-15「同一候选人判定规则」) this check is fetched from /
 *  attributed to in Neo4j. When provided, the audit shows 9-15 as THE rule (its three
 *  tiers are sub-judgments folded into the checkPoint) instead of the bundled
 *  IDENTITY-1/2/3 — so "调取的规则" reads 9-15, matching the ontology. */
export interface IdentityOntologyRule {
  id: string; // '9-15'
  name: string; // '同一候选人判定规则'
}

/** Identity result → check. A confident outcome (strong-rule dup, or no dup) is
 *  VALIDATED (PASS); a weak rule-3 dup needs human review → VIOLATED (surfaces as a
 *  flag). The matched rule's eval is PASS (clean) / FAIL (needs review); rules tried
 *  but not fired are NA. `link` (optional) surfaces the matched candidate in the UI.
 *  `ontologyRule` (optional) — when the agent fetched 9-15 from Neo4j/Allmeta, render
 *  the audit AS 9-15 (one eval), folding the matched tier into the checkPoint. */
export function identityToCheck(
  res: IdentityMatchResult,
  rulesTotal: number,
  link: IdentityLinkInfo = {},
  ontologyRule?: IdentityOntologyRule,
  llmRationale?: string | null,
): CandidateOntologyCheck {
  const linkSuffix =
    res.samePerson && link.matchedCandidateId
      ? ` · 关联到候选人 ${link.matchedCandidateName ?? '(未知名)'}（${link.matchedCandidateId}）· 去重动作 ${link.dedupAction ?? ''}`
      : '';

  // 本体抓取模式:9-15 是唯一原规则,命中的三级(手机号/姓名+邮箱/六字段)折进 checkPoint。
  if (ontologyRule) {
    const matched = res.ruleOutcomes.find((o) => o.matched) ?? null;
    const tier = matched
      ? `命中第${matched.ruleId.replace(/\D/g, '') || '?'}级(${matched.ruleName})`
      : '三级均未命中';
    const result: CandidateEval['result'] = res.samePerson
      ? res.needsHumanReview
        ? 'FAIL'
        : 'PASS'
      : 'NA';
    // 纳入依据:优先用大模型生成的业务文案;LLM 不可达时回退机械文案。机械判定依据 +
    // 字段证据始终留在 evidence,大模型文案上位也不丢失可审计的确定性依据。
    const mechanical = `${matched ? '命中' : '未命中'}规则 ${ontologyRule.id} · ${tier}${linkSuffix}`;
    const fieldEvidence = matched ? evidenceOf(matched) : res.ruleOutcomes.map(evidenceOf).join(' | ');
    const llm = llmRationale?.trim();
    return {
      decision: res.needsHumanReview ? 'VIOLATED' : 'VALIDATED',
      redlineFlag: false,
      selectionOk: true,
      rulesTotal: 1, // 9-15 是一条本体规则(三级是它的内部判定)
      rulesSelected: 1,
      rulesExpected: 1,
      rulesEvaluated: 1,
      evals: [
        {
          ruleId: ontologyRule.id,
          ruleName: ontologyRule.name,
          ruleGroup: '身份去重',
          hardSoft: res.needsHumanReview ? 'soft' : 'hard',
          result,
          checkPoint: llm || mechanical,
          evidence: llm ? `${mechanical} · ${fieldEvidence}` : fieldEvidence,
        },
      ],
    };
  }

  const evals: CandidateEval[] = res.ruleOutcomes.map((o) => ({
    ruleId: o.ruleId,
    ruleName: o.ruleName,
    ruleGroup: '身份去重',
    hardSoft: o.needsHumanReview ? 'soft' : 'hard',
    result: o.matched ? (o.needsHumanReview ? 'FAIL' : 'PASS') : 'NA',
    checkPoint: o.matched ? `命中规则 ${o.ruleId}${linkSuffix}` : `未命中规则 ${o.ruleId}`,
    evidence: evidenceOf(o),
  }));
  return {
    decision: res.needsHumanReview ? 'VIOLATED' : 'VALIDATED',
    redlineFlag: false,
    selectionOk: true,
    rulesTotal,
    rulesSelected: res.ruleOutcomes.length,
    rulesExpected: res.ruleOutcomes.length,
    rulesEvaluated: res.ruleOutcomes.length,
    evals,
  };
}

/** Ownership decision → check. proceed → VALIDATED (PASS); conflict → VIOLATED +
 *  redline (a hard ownership block). One eval for the deciding rule. */
export function ownershipToCheck(
  decision: OwnershipDecision,
  ownershipRules: OwnershipRule[],
): CandidateOntologyCheck {
  const ruleName =
    ownershipRules.find((r) => r.id === decision.matchedRuleId)?.businessLogicRuleName ??
    decision.matchedRuleId;
  const evals: CandidateEval[] = [
    {
      ruleId: decision.matchedRuleId,
      ruleName,
      ruleGroup: '归属',
      hardSoft: 'hard',
      result: decision.conflict ? 'FAIL' : 'PASS',
      checkPoint: decision.reason,
      evidence: decision.reason,
    },
  ];
  return {
    decision: decision.conflict ? 'VIOLATED' : 'VALIDATED',
    redlineFlag: decision.conflict,
    selectionOk: true,
    rulesTotal: ownershipRules.length,
    rulesSelected: 1,
    rulesExpected: 1,
    rulesEvaluated: 1,
    evals,
  };
}
