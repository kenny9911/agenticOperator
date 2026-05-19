/**
 * Hardcoded `ruleId → InstanceSpec` mapping for the Full impl (含义 A1 locked).
 *
 * Sibling copy of `lib/simple-rule-check/rule-instance-map.ts` — separate
 * module so the two impls can evolve independently per SPEC §15 locked
 * decision (MVP module isolation). When a new matchResume rule needs
 * additional Ontology data dependencies, extend this switch (or, in v1.1,
 * migrate to `rule.dependencies` read from the Ontology API).
 *
 * 含义 B (agentic tool-calling) is deferred — see SPEC §14.1.
 *
 * Note on Resume vs Candidate:
 *   In the real ontology, `work_experience` and `skill_tags` live on the
 *   `Resume` DataObject, not on `Candidate`. Rules that examine work history
 *   (10-17 / 10-18 / 10-25) therefore need `needsResume: true`. (For Full
 *   impl, Resume is already loaded into `## 运行时输入` via the matchResume
 *   runtime adapter — but if a rule needs additional candidate-tied data
 *   beyond what runtime-input provides, declare it here.)
 */

import type { InstanceSpec } from "./types";

/**
 * Returns the instance spec for a rule, or `null` if the rule needs no
 * additional Ontology data beyond what `## 运行时输入` (Job + Resume) already
 * supplies. `null` is the safe default: the rule judgment will rely on
 * runtime-input only.
 */
export function instancesNeededForRule(ruleId: string): InstanceSpec | null {
  switch (ruleId) {
    // 10-7 期望薪资校验 — Candidate_Expectation.expected_salary_range vs Job.salary_range
    case "10-7":
      return {
        needsCandidate: true,
        needsCandidateExpectation: true,
        needsJob: true,
      };

    // 10-17 高风险回流人员 — Resume.work_experience departure_code inspection
    case "10-17":
    // 10-18 EHS 风险人员 — same shape
    case "10-18":
    // 10-25 华为荣耀竞对 — Resume.work_experience company + end_date (temporal)
    case "10-25":
      return { needsCandidate: true, needsResume: true };

    // 10-32 岗位冷冻期 — Application filtered by (candidate, target job, lookback 3mo)
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
      // No spec registered → rule will operate on runtime-input only.
      // Acceptable: any rule whose data needs are wholly satisfied by
      // Job + Resume (matchResume's RuntimeInput) doesn't need an entry here.
      return null;
  }
}
