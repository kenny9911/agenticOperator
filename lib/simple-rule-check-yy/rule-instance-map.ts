/**
 * Hardcoded `ruleId → InstanceSpec` mapping for MVP.
 *
 * For each MVP rule, declares which instance fetches the Checker should do
 * before calling the LLM. Future v1.1 replaces this switch with metadata
 * stored on the Rule node in the Ontology API (`required_instances` field).
 *
 * Note on Resume vs Candidate:
 *   In the real ontology, `work_experience` and `skill_tags` live on the
 *   `Resume` DataObject, not on `Candidate`. Rules that examine work history
 *   (10-17 / 10-18 / 10-25) therefore need `needsResume: true`.
 */

import type { InstanceSpec } from "./types";

export function instancesNeededForRule(ruleId: string): InstanceSpec {
  switch (ruleId) {
    // 10-7 期望薪资校验 — the real ontology stores expected-salary on
    // `Candidate_Expectation.expected_salary_range`, NOT on Candidate. We also
    // need the Job's `salary_range` (upper bound) to do the comparison.
    case "10-7":
      return {
        needsCandidate: true,
        needsCandidateExpectation: true,
        needsJob: true,
      };

    // 10-17 高风险回流人员 — reads `work_experience` (on Resume).
    case "10-17":
    // 10-18 EHS 回流人员 — same: Resume.work_experience departure_code inspection.
    case "10-18":
    // 10-25 华为荣耀竞对 — Resume.work_experience company + end_date (temporal).
    case "10-25":
      return { needsCandidate: true, needsResume: true };

    // 10-32 岗位冷冻期规则 — needs Application filtered by (candidate, target job,
    // last 3 months) with status in [筛选淘汰, 面试淘汰, 筛选通过未到面].
    // This is THE cross-object MVP rule.
    case "10-32":
      return {
        needsCandidate: true,
        needsJob: true,
        needsApplications: {
          byJob: true,
          lookbackMonths: 3,
          onlyStatuses: ["筛选淘汰", "面试淘汰", "筛选通过未到面"],
        },
      };

    default:
      throw new Error(
        `No instance spec for rule "${ruleId}". To support this rule, ` +
          `extend lib/simple-rule-check/rule-instance-map.ts with the appropriate ` +
          `instance dependencies.`,
      );
  }
}
