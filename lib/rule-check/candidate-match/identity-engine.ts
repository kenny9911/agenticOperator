// Identity engine — given two candidate records, decide "same person?" by applying
// the identity rules in priority order (rule 1 phone → rule 2 name+email → rule 3 the
// 6-field set). The first rule whose every field is equivalent wins; a rule marked
// needsHumanReview (rule 3, the weak signal) routes its match to human review.
//
// The rule STRUCTURE comes from data (rules-data.ts). The AI judge is injected and
// used ONLY for a rule's fuzzyFields, only when the exact path fails — so this engine
// is fully unit-testable without a network call.

import type { IdentityRule } from './rules-data';
import type { CandidateRecord } from './types';
import { fieldRawValue } from './types';
import {
  fieldEquivalent,
  type AiFieldJudge,
  type FieldEquivResult,
} from './field-equivalence';

export interface IdentityRuleOutcome {
  ruleId: string;
  ruleName: string;
  priority: number;
  matched: boolean;
  needsHumanReview: boolean;
  fieldResults: FieldEquivResult[];
}

export interface IdentityMatchResult {
  samePerson: boolean;
  /** The first rule that fired (null when no rule matched). */
  matchedRule: IdentityRuleOutcome | null;
  /** True when the matched rule is a weak signal requiring human confirmation. */
  needsHumanReview: boolean;
  /** Rules actually evaluated, in priority order (up to + including the match). */
  ruleOutcomes: IdentityRuleOutcome[];
}

export interface IdentityEngineOpts {
  aiThreshold?: number;
}

export async function applyIdentityRules(
  a: CandidateRecord,
  b: CandidateRecord,
  rules: IdentityRule[],
  judge?: AiFieldJudge,
  opts: IdentityEngineOpts = {},
): Promise<IdentityMatchResult> {
  const ordered = [...rules].sort((x, y) => x.priority - y.priority);
  const ruleOutcomes: IdentityRuleOutcome[] = [];

  for (const rule of ordered) {
    const fieldResults: FieldEquivResult[] = [];
    for (const field of rule.matchFields) {
      fieldResults.push(
        await fieldEquivalent(field, fieldRawValue(a, field), fieldRawValue(b, field), {
          fuzzy: rule.fuzzyFields.includes(field),
          judge,
          aiThreshold: opts.aiThreshold,
        }),
      );
    }
    const matched = fieldResults.every((f) => f.equivalent);
    const outcome: IdentityRuleOutcome = {
      ruleId: rule.id,
      ruleName: rule.businessLogicRuleName,
      priority: rule.priority,
      matched,
      needsHumanReview: rule.needsHumanReview,
      fieldResults,
    };
    ruleOutcomes.push(outcome);

    if (matched) {
      return {
        samePerson: true,
        matchedRule: outcome,
        needsHumanReview: rule.needsHumanReview,
        ruleOutcomes,
      };
    }
  }

  return { samePerson: false, matchedRule: null, needsHumanReview: false, ruleOutcomes };
}
