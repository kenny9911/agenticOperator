// Candidate identity + ownership rules, loaded as DATA (not hardcoded if/else).
//
// P0 acceptance ("Rule 不再硬编码在代码里"): the rule STRUCTURE — which fields each
// rule compares, their priority order, and the client scope (通用 / 腾讯) — lives in
// rules.json (an ontology-shaped snapshot). The engine reads this; changing rule 3's
// field list is a data edit, no code change. The fuzzy SEMANTIC equivalence of field
// values (清华 vs 清华大学, 本科 vs Bachelor) is judged by AI — see ai-equivalence.ts.
//
// Today the source is the bundled snapshot. The shape mirrors the recruitment Rule
// records (businessLogicRuleName / applicableClient / enforcementLevel), so a future
// live Allmeta action (ruleCheckForCandidateIdentity / ...Ownership) can replace the
// snapshot without changing callers.

import rulesJson from './rules.json';

/** The candidate fields a rule can compare. */
export type MatchField =
  | 'phone'
  | 'name'
  | 'email'
  | 'gender'
  | 'school'
  | 'major'
  | 'degree'
  | 'graduationYear';

export interface IdentityRule {
  id: string;
  businessLogicRuleName: string;
  /** Lower = checked first (rule 1 phone, rule 2 name+email, rule 3 the 6-field set). */
  priority: number;
  applicableClient: string;
  /** All fields must be equivalent for the rule to fire. */
  matchFields: MatchField[];
  /** Subset of matchFields whose equivalence may fall back to the AI judge when
   *  exact-normalized comparison fails (e.g. 清华 vs 清华大学). */
  fuzzyFields: MatchField[];
  /** True for weak-signal rules (rule 3) — a match still routes to human review. */
  needsHumanReview: boolean;
  standardizedLogicRule: string;
  enforcementLevel: string;
}

export interface OwnershipRule {
  id: string;
  businessLogicRuleName: string;
  applicableClient: string;
  standardizedLogicRule: string;
  enforcementLevel: string;
}

export interface CandidateMatchRuleset {
  identityRules: IdentityRule[];
  ownershipRules: OwnershipRule[];
  /** Where the rules came from — 'snapshot' today; 'ontology-api' once live. */
  source: string;
}

/** Load the candidate identity + ownership rules. */
export function loadCandidateMatchRules(): CandidateMatchRuleset {
  return {
    identityRules: rulesJson.identityRules as IdentityRule[],
    ownershipRules: rulesJson.ownershipRules as OwnershipRule[],
    source: rulesJson.metadata?.source ?? 'snapshot',
  };
}

/** Identity rules in ascending priority order (rule 1 → 2 → 3). */
export function identityRulesByPriority(rs: CandidateMatchRuleset): IdentityRule[] {
  return [...rs.identityRules].sort((a, b) => a.priority - b.priority);
}
