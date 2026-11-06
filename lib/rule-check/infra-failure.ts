// Distinguishes a rule-check `decision: 'FAIL'` that is an *infrastructure*
// failure (evaluation could not complete) from a *real* rule violation.
//
// failSafe() in runner.ts sets audit.fail_reason to one of these whenever the
// evaluation itself broke (LLM gateway down/401, graph unavailable, tool loop
// exhausted, unparseable LLM output). Those are NOT candidate rejections — the
// agent must retry/park + alert, never write 未通过 to the partner main table
// or emit MATCH_RULE_CHECK_FAILED. A real violation comes through the normal
// path with audit.fail_reason left undefined.

export const INFRA_FAIL_REASONS = [
  'llm-call-error',
  'gateway-unavailable',
  'ontology-graph-unavailable',
  'tool-use-loop-exceeded',
  'parse-error',
] as const;

export function isInfraFailure(reason: string | undefined | null): boolean {
  if (!reason) return false;
  return (INFRA_FAIL_REASONS as readonly string[]).includes(reason);
}

/**
 * User-facing (Chinese) explanation for an infra failSafe FAIL, shown on the
 * /rule-check audit when a run is parked. `depReason` refines an LLM-gateway
 * failure into 没钱(quota) / 密钥(auth) / 限流(rate_limit) / 故障(server…),
 * coming from the dependency-health classifier. Every variant makes clear the
 * candidate was NOT rejected — only the evaluation could not complete.
 */
export function friendlyInfraReason(
  failReason: string | undefined | null,
  depReason?: string,
): string {
  switch (failReason) {
    case 'llm-call-error':
    case 'gateway-unavailable':
      switch (depReason) {
        case 'quota':
          return 'AI 模型余额不足,需要充值额度后才能完成规则判定(候选人未被拒绝)';
        case 'auth':
          return 'AI 模型密钥失效或无权限,暂时无法完成规则判定(候选人未被拒绝)';
        case 'rate_limit':
          return 'AI 模型调用过于频繁被限流,稍后将自动重试(候选人未被拒绝)';
        default:
          return 'AI 模型服务暂时不可用,稍后将自动重试(候选人未被拒绝)';
      }
    case 'ontology-graph-unavailable':
      return '规则库暂时不可用,暂时无法完成规则判定(候选人未被拒绝)';
    case 'parse-error':
      return 'AI 模型返回的结果无法解析,稍后将自动重试(候选人未被拒绝)';
    case 'tool-use-loop-exceeded':
      return 'AI 模型推理超出步数限制,稍后将自动重试(候选人未被拒绝)';
    default:
      return '规则校验因基础设施故障未能完成(候选人未被拒绝)';
  }
}
