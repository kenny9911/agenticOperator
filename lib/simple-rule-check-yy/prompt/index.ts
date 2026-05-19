/**
 * PromptStrategy interface — pluggable prompt builders.
 *
 * MVP ships `extractedRulePrompt` (single-rule focused). FULL impl will add
 * `fullActionPrompt` (uses generatePrompt's complete output + focusing system
 * message). Both implement the same interface so the orchestrator can swap.
 */

import type { FetchedRule, Instance, CheckRuleInput } from "../types";

export interface PromptBuildInput {
  rule: FetchedRule;
  scope: { client: string; department?: string };
  candidate: Instance;
  resumes?: Instance[];
  expectations?: Instance[];
  job?: Instance;
  applications?: Instance[];
  blacklist?: Instance[];
  /** ISO-8601, e.g. "2026-05-12T10:30:00+08:00". */
  currentTime: string;
  actionRef: CheckRuleInput["actionRef"];
}

export interface PromptBuildOutput {
  system: string;
  user: string;
}

export interface PromptStrategy {
  name: string;
  build(input: PromptBuildInput): PromptBuildOutput;
}

export { extractedRulePromptStrategy } from "./extractor";
export { fullActionPromptStrategy } from "./full";
