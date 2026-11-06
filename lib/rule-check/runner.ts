// Rule check orchestrator — neo4j-aware matchResume evaluation.
//
//   buildRuleCheckInput()   -- 5-block input builder (unchanged)
//   runRuleCheck()          -- full pipeline:
//     dims → fetch rules → filter → build graph context →
//     compose prompt → chatComplete (with tools) → fold to MatchResumeCheckResult

import { extractDims } from './ontology';
import { fetchRulesViaOntologyApi, RuleFetchApiError } from './api-rule-fetcher';
import { buildGraphContext, createDispatcher } from './graph-context';
import {
  composeMatchResumePrompt,
  MATCH_RESUME_SYSTEM_PROMPT,
} from './prompt';
import type {
  MatchResumeCheckResult,
  MatchResumeCheckStats,
  MatchResumeStepGroup,
  Rule,
  RuleCheckInput,
  RuleCheckRuntimeContext,
  RuleExplanation,
  RuleNextAction,
  RuleResult,
  RuleStatus,
  Severity,
} from './types';
import { chatComplete } from '@/server/llm/gateway';
import { ruleCheckLog } from './log';
import { createNullLogger, type AgentLogger } from '@/lib/agent-logger';

const TOOL_SCHEMA = [
  {
    type: 'function' as const,
    function: {
      name: 'get_instance',
      description: 'Fetch one ontology instance by label + primary key value.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['label', 'value'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_instances',
      description: 'List instances of a label filtered by property equality.',
      parameters: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          filters: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['label'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_links',
      description: 'List ontology links by from/to/type filters.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          type: { type: 'string' },
        },
      },
    },
  },
];

export interface BuildInputArgs {
  runtime_context: RuleCheckRuntimeContext;
  parsed_resume: Record<string, unknown> | null | undefined;
  job_requisition: Record<string, unknown>;
  job_requisition_specification?: Record<string, unknown> | null;
  hsm_feedback?: Record<string, unknown> | null;
}

export function buildRuleCheckInput(args: BuildInputArgs): RuleCheckInput {
  const jr = args.job_requisition;
  const jrid =
    typeof jr.job_requisition_id === 'string' && jr.job_requisition_id.trim()
      ? (jr.job_requisition_id as string)
      : '';
  return {
    runtime_context: args.runtime_context,
    resume: args.parsed_resume ?? {},
    job_requisition: { ...jr, job_requisition_id: jrid },
    job_requisition_specification: args.job_requisition_specification ?? null,
    hsm_feedback: args.hsm_feedback ?? null,
  };
}


function emptyStats(): MatchResumeCheckStats {
  return {
    total: 0,
    pass: 0,
    fail: 0,
    pending: 0,
    insufficient_info: 0,
    not_triggered: 0,
    not_executed: 0,
  };
}

function failSafe(
  reason: MatchResumeCheckResult['audit']['fail_reason'],
  base: Partial<MatchResumeCheckResult['audit']> = {},
  graph_context?: import('./graph-context').GraphContext,
): MatchResumeCheckResult {
  return {
    decision: 'FAIL',
    stats: emptyStats(),
    rule_results: [],
    explanations: [],
    graph_context,
    audit: {
      rules_evaluated: base.rules_evaluated ?? 0,
      graph_calls: base.graph_calls ?? 0,
      llm_model: base.llm_model ?? 'unknown',
      llm_duration_ms: base.llm_duration_ms ?? 0,
      llm_round_trips: base.llm_round_trips ?? 0,
      llm_prompt_tokens: base.llm_prompt_tokens,
      llm_completion_tokens: base.llm_completion_tokens,
      rule_source: base.rule_source ?? 'json-fallback',
      fail_reason: reason,
      raw_llm_text: base.raw_llm_text,
      llm_raw_text: base.llm_raw_text ?? base.raw_llm_text,
      llm_finish_reason: base.llm_finish_reason,
      llm_error_detail: base.llm_error_detail,
      parse_error: base.parse_error,
      user_prompt: base.user_prompt,
      system_prompt: base.system_prompt,
      // Carry the fetched-rules evidence through an infra failSafe so the
      // /rule-check page can still show WHICH rules were fetched even though
      // the LLM never produced a per-rule judgment (没钱 / 故障 / parse-error).
      rule_provenance: base.rule_provenance,
      client_name_resolved: base.client_name_resolved,
      business_group_resolved: base.business_group_resolved,
    },
  };
}

/**
 * Strip a leading ```json (or ```) fence and a trailing ``` if present. LLMs
 * (Gemini especially) often wrap JSON in a markdown code fence even when the
 * prompt forbids it. This is a single-line tolerance layer.
 */
function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  // ```json\n ... \n``` or ```\n ... \n```
  const m = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (m) return m[1].trim();
  return trimmed;
}

function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, '$1');
}

function parseLlmJson(
  text: string,
): { decision?: unknown; stats?: unknown; rule_results?: unknown } | null {
  const cleaned = stripCodeFence(text);
  const candidates = [cleaned];
  const embedded = extractFirstJsonObject(cleaned);
  if (embedded && embedded !== cleaned) candidates.push(embedded);
  const repaired = removeTrailingCommas(embedded ?? cleaned);
  if (repaired !== cleaned && repaired !== embedded) candidates.push(repaired);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof parsed !== 'object' || parsed === null) continue;
      const ruleResults =
        parsed.rule_results ??
        parsed.ruleResults ??
        parsed.results ??
        parsed.rules;
      return {
        decision: parsed.decision,
        stats: parsed.stats,
        rule_results: ruleResults,
      };
    } catch {
      // Try the next tolerance layer.
    }
  }
  return null;
}

/** status → 下一步动作的默认映射(LLM 没给或给了非法值时兜底)。 */
export function defaultNextAction(status: RuleStatus): RuleNextAction {
  switch (status) {
    case 'fail':
      return 'block';
    case 'insufficient_info':
      return 'supplement';
    case 'pending':
      return 'review';
    default:
      return 'continue'; // pass / not_triggered / not_executed
  }
}

const NEXT_ACTIONS = new Set<RuleNextAction>(['continue', 'block', 'supplement', 'review']);

export function coerceRuleResults(
  raw: unknown,
  steps: MatchResumeStepGroup[],
): RuleResult[] {
  // rule_name and step_id are derived server-side from the steps catalog rather
  // than emitted by the LLM. This saves ~30 tokens per rule entry — critical
  // when the gateway clamps max_tokens aggressively and we're emitting one
  // entry per evaluated rule.
  const lookup = new Map<string, {
    rule_name: string;
    step_id: string;
    enforcement_level?: Rule['enforcementLevel'];
    failure_policy?: Rule['failurePolicy'];
    severity: Severity;
  }>();
  for (const s of steps) {
    for (const r of s.rules) {
      lookup.set(r.id, {
        rule_name: r.businessLogicRuleName,
        step_id: s.step_id,
        enforcement_level: r.enforcementLevel,
        failure_policy: r.failurePolicy,
        severity: severityOfRule(r),
      });
    }
  }

  if (!Array.isArray(raw)) return [];
  const allowed = new Set<RuleStatus>([
    'pass',
    'fail',
    'pending',
    'insufficient_info',
    'not_triggered',
    'not_executed',
  ]);
  const out: RuleResult[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (
      typeof r.rule_id !== 'string' ||
      typeof r.status !== 'string' ||
      !allowed.has(r.status as RuleStatus)
    ) {
      continue;
    }
    const meta = lookup.get(r.rule_id);
    if (!meta) continue;
    const status = r.status as RuleStatus;
    const reason = typeof r.reason === 'string' ? r.reason : undefined;
    const reasonRequired = status !== 'pass' && status !== 'not_triggered';
    if (reasonRequired && !reason) continue;
    const referenceOnly = meta.severity === 'flag_only';
    // Governance is server-owned. An LLM may honestly return status=fail for
    // an optional rule, but it must never smuggle `next_action=block` into the
    // persisted result. Optional findings are review/reference signals only.
    const next_action: RuleNextAction = referenceOnly
      ? status === 'pass' || status === 'not_triggered'
        ? 'continue'
        : 'review'
      : NEXT_ACTIONS.has(r.next_action as RuleNextAction)
        ? (r.next_action as RuleNextAction)
        : defaultNextAction(status);
    out.push({
      rule_id: r.rule_id,
      rule_name: meta.rule_name,
      step_id: meta.step_id,
      status,
      reason,
      next_action,
      enforcement_level: meta.enforcement_level,
      failure_policy: meta.failure_policy,
      severity: meta.severity,
      blocking: !referenceOnly,
    });
  }
  return out;
}

function deriveExplanations(rule_results: RuleResult[]): RuleExplanation[] {
  return rule_results
    .filter((r) => r.status !== 'pass' && r.status !== 'not_triggered')
    .map((r) => ({
      rule_id: r.rule_id,
      rule_name: r.rule_name,
      step_id: r.step_id,
      status: r.status as RuleExplanation['status'],
      reason: r.reason ?? '',
      next_action: r.next_action,
      enforcement_level: r.enforcement_level,
      failure_policy: r.failure_policy,
      severity: r.severity,
      blocking: r.blocking,
    }));
}

function statsFromResults(results: RuleResult[]): MatchResumeCheckStats {
  const s = emptyStats();
  s.total = results.length;
  for (const r of results) {
    if (r.status === 'pass') s.pass++;
    else if (r.status === 'fail') s.fail++;
    else if (r.status === 'pending') s.pending++;
    else if (r.status === 'insufficient_info') s.insufficient_info++;
    else if (r.status === 'not_triggered') s.not_triggered++;
    else if (r.status === 'not_executed') s.not_executed++;
  }
  return s;
}

/** agent 无法自证「达标」的状态 —— 信息不足 / 需 HSM 主观判断 / 未能评估。 */
const BLOCK_WHEN_UNCONFIRMABLE: ReadonlySet<RuleStatus> = new Set<RuleStatus>([
  'insufficient_info',
  'pending',
  'not_executed',
]);

/** 取规则严重度:优先用 ontology governance 推导,legacy severity 只作回退。
 *  未知(字段全缺)→ terminal 兜底(fail-closed:无法判定就当底线规则)。 */
export function severityOfRule(r: Pick<Rule, 'severity' | 'enforcementLevel' | 'failurePolicy'>): Severity {
  // `optional` is an absolute non-blocking contract. This intentionally wins
  // over a stale/contradictory legacy severity or failurePolicy value.
  if (r.enforcementLevel === 'optional') return 'flag_only';
  if (r.enforcementLevel === 'mandatory' && r.failurePolicy === 'block') return 'terminal';
  if (r.enforcementLevel === 'mandatory' && r.failurePolicy === 'warn') return 'needs_human';
  if (r.severity) return r.severity;
  return 'terminal';
}

export function foldDecision(
  ruleResults: RuleResult[],
  severityByRuleId: Map<string, Severity>,
): MatchResumeCheckResult['decision'] {
  // 2026-06-01 fail-closed 政策(替代 2026-05-26 的全量折 PASS):
  //   - status='fail'(确认违反,已引用具体字段+数值)→ 仅 mandatory/底线规则 FAIL。
  //     optional/flag_only 仍保留真实 fail 结果作为参考,但不影响总闸门。
  //   - insufficient_info / pending / not_executed(agent 无法自证达标)→ 只要落在
  //     底线规则(severity≠flag_only,即 terminal/needs_human)上就 FAIL。提示类
  //     flag_only 不阻断。rule_id 查不到 severity →
  //     当 terminal 兜底(fail-closed)。
  //   - 只剩 pass / not_triggered / 命中 flag_only 的不确定状态 → PASS。
  // per-rule 真实 status 不在这里改(LLM 仍诚实分类),只改 server 端汇总。
  for (const r of ruleResults) {
    const sev = severityByRuleId.get(r.rule_id) ?? r.severity ?? 'terminal';
    if (r.status === 'fail' && sev !== 'flag_only') return 'FAIL';
    if (BLOCK_WHEN_UNCONFIRMABLE.has(r.status)) {
      if (sev !== 'flag_only') return 'FAIL';
    }
  }
  return 'PASS';
}

/** 2026-06-01:不通过原因里给「非确认违反」类状态加人工复核标注,让 reason 文本
 *  自带「需人工复核」信号(写主表/Neo4j/事件/审计都带)。 */
export function explanationTag(status: RuleExplanation['status']): string {
  switch (status) {
    case 'insufficient_info':
      return '（信息不足·需人工复核）';
    case 'pending':
      return '（需 HSM 人工复核）';
    case 'not_executed':
      return '（未能评估·需人工复核）';
    default:
      return ''; // 'fail' — 确认违反,已引用具体数值,无需标注
  }
}

/** 统一的不通过原因行 `[id] 名称（标注）: 理由`。四处落库/发事件共用,保证一致。 */
export function formatExplanation(e: RuleExplanation): string {
  return `[${e.rule_id}] ${e.rule_name}${explanationTag(e.status)}: ${e.reason ?? ''}`;
}

export type RunRuleCheckOptions = {
  /** Override the gateway's default model for this call only. */
  model?: string;
  /** Per-run agent logger — Ontology API 调用 + step 事件全部走它落到 logs/。 */
  logger?: AgentLogger;
};

export async function runRuleCheck(
  input: RuleCheckInput,
  opts: RunRuleCheckOptions = {},
): Promise<MatchResumeCheckResult> {
  // dims 不再用于 rule filtering(新 fetcher 直接走 Neo4j client lookup),
  // 但保留 extractDims 调用做侧效验证(防御 ill-formed JR);return 不读它。
  void extractDims(input.job_requisition);
  const logger = opts.logger ?? createNullLogger();

  // 2026-05-20 重写:走 /actions/ruleCheckForMatchResume/rules + Neo4j client lookup,
  // 不再读 rules.json,不再 fallback。
  let sourceResult;
  try {
    // raw client_id / department 从 JR 上取(extractDims normalize 过的会丢失原始 ID,这里用原 JR)
    const jr = input.job_requisition;
    const rawClientId = typeof jr.client_id === 'string' ? jr.client_id : null;
    const rawDepartmentId =
      typeof jr.client_department_id === 'string' ? jr.client_department_id : null;
    const rawBusinessGroup =
      typeof jr.client_business_group === 'string' ? jr.client_business_group : null;
    const rawOrgName = typeof jr.sd_org_name === 'string' ? jr.sd_org_name : null;
    sourceResult = await fetchRulesViaOntologyApi({
      clientId: rawClientId,
      departmentId: rawDepartmentId,
      businessGroup: rawBusinessGroup,
      orgName: rawOrgName,
      logger,
    });
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    ruleCheckLog.error('rule-fetch.failed', { message: msg });
    logger.event('rule-fetch.failed', { message: msg });
    const reason = err instanceof RuleFetchApiError ? 'ontology-graph-unavailable' : 'llm-call-error';
    return failSafe(reason, { rule_source: 'ontology-api' });
  }

  const filteredSteps: MatchResumeStepGroup[] = sourceResult.steps;
  const expectedRuleCount = filteredSteps.reduce(
    (sum, s) => sum + s.rules.length,
    0,
  );

  // Fetched-rules evidence — attached to every infra failSafe AFTER this point
  // (graph-unavailable / llm-call-error / parse-error). Rules were already
  // resolved from the ontology API, so even a parked run records what we got.
  const fetchedAudit: Partial<MatchResumeCheckResult['audit']> = {
    rule_provenance: sourceResult.provenance,
    client_name_resolved: sourceResult.client_name_resolved,
    business_group_resolved: sourceResult.business_group_resolved,
  };

  ruleCheckLog.info('runRuleCheck.start', {
    candidate_id: input.runtime_context.candidate_id,
    resume_id: input.runtime_context.resume_id,
    job_requisition_id: input.job_requisition.job_requisition_id,
    model_override: opts.model,
    expected_rule_count: expectedRuleCount,
    rule_source: sourceResult.source,
    client_name_resolved: sourceResult.client_name_resolved,
    api_rule_count: sourceResult.api_rule_count,
    filtered_rule_count: sourceResult.filtered_rule_count,
  });
  logger.event('runRuleCheck.start', {
    candidate_id: input.runtime_context.candidate_id,
    resume_id: input.runtime_context.resume_id,
    job_requisition_id: input.job_requisition.job_requisition_id,
    client_id_raw: input.job_requisition.client_id ?? null,
    client_name_resolved: sourceResult.client_name_resolved,
    api_rule_count: sourceResult.api_rule_count,
    filtered_rule_count: sourceResult.filtered_rule_count,
    rule_ids: sourceResult.rules.map((r) => r.id),
  });

  // Pre-fetch graph context. Surface 401/502 as ontology-graph-unavailable.
  let graph;
  try {
    graph = await buildGraphContext({
      candidate_id: input.runtime_context.candidate_id,
      job_requisition_id:
        (input.job_requisition.job_requisition_id as string | undefined) ?? '',
    });
    ruleCheckLog.data('neo4j.graph.fetched', {
      candidate_id: input.runtime_context.candidate_id,
      fetch_count: graph.fetch_count,
      slots: {
        candidate: graph.candidate,
        resume: graph.resume,
        job_requisition: graph.job_requisition,
        applications: graph.applications,
        blacklist_hits: graph.blacklist_hits,
        employment_links: graph.employment_links,
      },
    });
  } catch (err) {
    ruleCheckLog.error('neo4j.graph.failed', {
      candidate_id: input.runtime_context.candidate_id,
      message: (err as Error).message,
    });
    return failSafe('ontology-graph-unavailable', {
      ...fetchedAudit,
      rules_evaluated: expectedRuleCount,
      rule_source: sourceResult.source,
    });
  }

  // resume now lives in graph.resume; the prompt no longer reads input.resume.
  const userPrompt = composeMatchResumePrompt({
    input,
    graph,
    steps: filteredSteps,
  });

  const dispatcher = createDispatcher(graph);

  ruleCheckLog.data('llm.request', {
    model: opts.model ?? null,
    system_chars: MATCH_RESUME_SYSTEM_PROMPT.length,
    user_chars: userPrompt.length,
    user_prompt: userPrompt,
    rules_in_prompt: expectedRuleCount,
  });
  // 2026-05-26 — 也走 agent fileLogger(带 run_id),让 LLM 入参进 per-run 审计.
  // ruleCheckLog 写 lib/rule-check/logs/ 无 run_id,审计页 /api/audit/runs 找不到.
  logger.event('llm.request', {
    from: '智能体 → AI 模型',
    to: 'AI 模型',
    model: opts.model ?? null,
    system_prompt: MATCH_RESUME_SYSTEM_PROMPT,   // 完整 system prompt
    user_prompt: userPrompt,                      // 完整 user prompt(简历+JD+规则)
    system_chars: MATCH_RESUME_SYSTEM_PROMPT.length,
    user_chars: userPrompt.length,
    rules_in_prompt: expectedRuleCount,
    max_tokens: 16000,
  });

  let llmResult;
  try {
    llmResult = await chatComplete({
      system: MATCH_RESUME_SYSTEM_PROMPT,
      user: userPrompt,
      // Rule check emits one rule_results entry per evaluated rule. With
      // 20-40 rules surviving the client filter (and each entry carrying a
      // Chinese-language reason — more bytes per token than English), the
      // output regularly exceeds 8000 tokens. 16k handles ~40 rules with
      // headroom; bump to 32k+ if deployments routinely have >60 rules.
      maxTokens: 16000,
      model: opts.model,
      // temperature + extra_body (Kimi thinking-disable) are model-aware in
      // the gateway; we let chatComplete pick the right defaults so the same
      // code works for Kimi K2.6 AND Gemini-3-flash-preview without changes.
      tools: {
        schema: TOOL_SCHEMA,
        onToolCall: dispatcher,
        maxIterations: 5,
      },
    });
  } catch (err) {
    const msg = (err as Error).message ?? '';
    const reason: MatchResumeCheckResult['audit']['fail_reason'] = /tool-use loop/.test(msg)
      ? 'tool-use-loop-exceeded'
      : 'llm-call-error';
    ruleCheckLog.error('llm.failed', { reason, message: msg });
    logger.event('llm.failed', { from: 'AI 模型', to: '智能体', reason, message: msg });
    return failSafe(reason, {
      ...fetchedAudit,
      rules_evaluated: expectedRuleCount,
      graph_calls: graph.fetch_count,
      rule_source: sourceResult.source,
      llm_error_detail: msg,
      user_prompt: userPrompt,
      system_prompt: MATCH_RESUME_SYSTEM_PROMPT,
    });
  }

  ruleCheckLog.data('llm.response', {
    model: llmResult.modelUsed,
    duration_ms: llmResult.durationMs,
    tool_rounds: llmResult.toolUseIterations,
    finish_reason: llmResult.finishReason,
    prompt_tokens: llmResult.usage?.promptTokens,
    completion_tokens: llmResult.usage?.completionTokens,
    text: llmResult.text,
  });
  // 也走 agent fileLogger(带 run_id),LLM 出参进 per-run 审计.
  logger.event('llm.response', {
    from: 'AI 模型',
    to: '智能体',
    model: llmResult.modelUsed,
    duration_ms: llmResult.durationMs,
    tool_rounds: llmResult.toolUseIterations,
    finish_reason: llmResult.finishReason,
    prompt_tokens: llmResult.usage?.promptTokens,
    completion_tokens: llmResult.usage?.completionTokens,
    total_tokens:
      (llmResult.usage?.promptTokens ?? 0) + (llmResult.usage?.completionTokens ?? 0) || null,
    text: llmResult.text,    // 完整 LLM 原始输出
  });

  const parsed = parseLlmJson(llmResult.text);
  const auditOnError = {
    ...fetchedAudit,
    rules_evaluated: expectedRuleCount,
    graph_calls: graph.fetch_count,
    llm_model: llmResult.modelUsed,
    llm_duration_ms: llmResult.durationMs,
    llm_round_trips: llmResult.toolUseIterations,
    llm_prompt_tokens: llmResult.usage?.promptTokens,
    llm_completion_tokens: llmResult.usage?.completionTokens,
    rule_source: sourceResult.source,
    // Postgres TEXT keeps the complete response so parse failures remain
    // reproducible; slicing JSON here would corrupt the audit artifact.
    raw_llm_text: llmResult.text,
    llm_raw_text: llmResult.text,
    user_prompt: userPrompt,
    system_prompt: MATCH_RESUME_SYSTEM_PROMPT,
    llm_finish_reason: llmResult.finishReason,
  };
  if (!parsed) {
    ruleCheckLog.error('parse.failed', { reason: 'not-json' });
    return failSafe('parse-error', { ...auditOnError, parse_error: 'LLM response is not valid JSON' }, graph);
  }

  const ruleResults = coerceRuleResults(parsed.rule_results, filteredSteps);
  const expectedRuleIds = filteredSteps.flatMap((step) => step.rules.map((rule) => rule.id));
  const actualRuleIds = ruleResults.map((rule) => rule.rule_id);
  const seenRuleIds = new Set<string>();
  const duplicateRuleIds = [...new Set(actualRuleIds.filter((id) => {
    if (seenRuleIds.has(id)) return true;
    seenRuleIds.add(id);
    return false;
  }))];
  const actualRuleIdSet = new Set(actualRuleIds);
  const missingRuleIds = expectedRuleIds.filter((id) => !actualRuleIdSet.has(id));
  if (
    ruleResults.length !== expectedRuleCount ||
    duplicateRuleIds.length > 0 ||
    missingRuleIds.length > 0
  ) {
    ruleCheckLog.error('parse.rule-set-mismatch', {
      expected: expectedRuleCount,
      got: ruleResults.length,
      duplicate_rule_ids: duplicateRuleIds,
      missing_rule_ids: missingRuleIds,
    });
    const detail = [
      `expected ${expectedRuleCount}, got ${ruleResults.length}`,
      duplicateRuleIds.length > 0 ? `duplicates=${duplicateRuleIds.join(',')}` : '',
      missingRuleIds.length > 0 ? `missing=${missingRuleIds.join(',')}` : '',
    ].filter(Boolean).join('; ');
    return failSafe(
      'parse-error',
      { ...auditOnError, parse_error: `rule_results set mismatch: ${detail}` },
      graph,
    );
  }

  const stats = statsFromResults(ruleResults);
  const explanations = deriveExplanations(ruleResults);
  // severity 取本次 fetch 到的规则(enforcement+failure 派生);fold 用它做底线规则门控。
  const severityByRuleId = new Map<string, Severity>(
    sourceResult.rules.map((r) => [r.id, severityOfRule(r)]),
  );
  const decision = foldDecision(ruleResults, severityByRuleId);
  ruleCheckLog.info('runRuleCheck.done', {
    candidate_id: input.runtime_context.candidate_id,
    decision, stats, expected_rule_count: expectedRuleCount,
  });

  return {
    decision,
    stats,
    rule_results: ruleResults,
    explanations,
    graph_context: graph,
    audit: {
      rules_evaluated: expectedRuleCount,
      graph_calls: graph.fetch_count,
      llm_model: llmResult.modelUsed,
      llm_duration_ms: llmResult.durationMs,
      llm_round_trips: llmResult.toolUseIterations,
      llm_prompt_tokens: llmResult.usage?.promptTokens,
      llm_completion_tokens: llmResult.usage?.completionTokens,
      rule_source: sourceResult.source,
      llm_finish_reason: llmResult.finishReason,
      // 解析好的可读客户名 — 透传给 agent 持久化进 audit 行(读时不再实时查 partner-pg)。
      client_name_resolved: sourceResult.client_name_resolved,
      // 解析好的 business group(图查 Client_Department + 字符串兜底)— 比 JR 自带的
      // bg 字段更全,透传给 agent 持久化,避免 JR 缺 bg 字段时 audit 落空(显示「?」)。
      business_group_resolved: sourceResult.business_group_resolved,
      // 2026-05-20: surface the prompts + raw response so the /rule-check
      // audit UI's User Prompt / LLM Response / Rule Flags tabs have data.
      user_prompt: userPrompt,
      system_prompt: MATCH_RESUME_SYSTEM_PROMPT,
      llm_raw_text: llmResult.text,
      rule_provenance: sourceResult.provenance,
    },
  };
}
