import { RECRUITMENT_DOMAIN_ID } from "@/lib/domain-ids";

export const RAAS_V1_APP_ID = "agentic-operator-main";
export const RAAS_V1_DOMAIN_ID = RECRUITMENT_DOMAIN_ID;

export const RAAS_V1_FUNCTION_IDS = [
  "create-jd-agent",
  "resume-parser-agent",
  "rule-check-candidate-identity-agent",
  "rule-check-agent",
  "match-resume-agent",
  "interview-inviter-agent",
] as const;

export type RaasV1FunctionId = (typeof RAAS_V1_FUNCTION_IDS)[number];

export const RAAS_V1_EXPECTED_FUNCTION_COUNT = RAAS_V1_FUNCTION_IDS.length;

export function raasV1FunctionSlug(id: RaasV1FunctionId | string): string {
  return `${RAAS_V1_APP_ID}-${id}`;
}

export const RAAS_V1_FUNCTION_SLUGS = RAAS_V1_FUNCTION_IDS.map(raasV1FunctionSlug);

export function isRaasV1FunctionId(id: string | null | undefined): id is RaasV1FunctionId {
  return Boolean(id && (RAAS_V1_FUNCTION_IDS as readonly string[]).includes(id));
}

export function isRaasV1FunctionSlug(slug: string | null | undefined): boolean {
  return Boolean(slug && RAAS_V1_FUNCTION_SLUGS.includes(slug));
}
