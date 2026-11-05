// Tool-call guard for the rule-check LLM loop.
//
// Why: "AI 模型推理超出步数限制" (fail_reason='tool-use-loop-exceeded') is NOT a
// timeout (that surfaces as llm-call-error) and NOT a max_tokens cut (that is
// finish_reason='length' → parse-error). It means the model kept asking for
// more ontology lookups round after round and never produced the final JSON.
// The usual pattern: a rule needs data that isn't in the prefetched
// GRAPH_CONTEXT (亲属关系 / 合规文档 …), the lookup returns null / [] / an error,
// and the model guesses another label or filter next round — until the budget
// is gone.
//
// This wrapper (around createDispatcher) makes the loop converge and makes the
// failure diagnosable:
//   - a repeated identical call is answered from the previous result plus a
//     "stop repeating" note (no new upstream fetch);
//   - an empty / error result carries an explicit "don't guess other labels,
//     mark the rule insufficient_info" note;
//   - every call is recorded so the audit shows WHY the budget ran out.
// Pure over the injected inner dispatcher.

import type { ToolDispatcher } from './graph-context';

export type ToolCallOutcome = 'hit' | 'empty' | 'error' | 'repeat';

export interface ToolTraceEntry {
  name: string;
  /** Compact JSON of the arguments (truncated). */
  args: string;
  outcome: ToolCallOutcome;
}

export const EMPTY_RESULT_NOTE =
  '未查到数据。不要更换 label / 过滤条件反复猜测;依赖该数据的规则请直接标记 insufficient_info,并在 reason 中说明缺少什么。';
export const ERROR_RESULT_NOTE =
  '查询失败。不要重复或换参数重试;依赖该数据的规则请直接标记 insufficient_info,并在 reason 中说明。';
export const REPEAT_RESULT_NOTE =
  '该查询之前已执行过,结果与上次相同(见 result)。不要重复调用;请基于已有信息继续判定或直接输出最终 JSON。';

const MAX_TRACE = 40;
const MAX_ARGS_CHARS = 160;

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (Array.isArray(v) && v.length === 0);
}

function isErrorEnvelope(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as { error?: unknown }).error === 'string'
  );
}

export interface GuardedDispatcher {
  dispatch: ToolDispatcher;
  /** Every call so far, in order (capped at MAX_TRACE entries). */
  trace: ToolTraceEntry[];
  /** Total calls (including ones beyond the trace cap). */
  callCount(): number;
  /** One-line human summary, e.g. "6 次调用 · 命中 2 · 空 3 · 重复 1 · 失败 0 · get_instance(...)→empty …". */
  summary(): string;
}

export function createGuardedDispatcher(inner: ToolDispatcher): GuardedDispatcher {
  const seen = new Map<string, unknown>();
  const trace: ToolTraceEntry[] = [];
  const counts: Record<ToolCallOutcome, number> = { hit: 0, empty: 0, error: 0, repeat: 0 };
  let calls = 0;

  const record = (name: string, argsKey: string, outcome: ToolCallOutcome) => {
    calls += 1;
    counts[outcome] += 1;
    if (trace.length < MAX_TRACE) {
      trace.push({
        name,
        args: argsKey.length > MAX_ARGS_CHARS ? `${argsKey.slice(0, MAX_ARGS_CHARS - 1)}…` : argsKey,
        outcome,
      });
    }
  };

  const dispatch: ToolDispatcher = async (name, args) => {
    const argsKey = stableStringify(args ?? {});
    const key = `${name}|${argsKey}`;
    if (seen.has(key)) {
      record(name, argsKey, 'repeat');
      return { result: seen.get(key), note: REPEAT_RESULT_NOTE };
    }
    // Inner dispatcher returns `{ error }` for HTTP failures and throws only on
    // unknown tool names — let that throw propagate (fail loudly, as before).
    const value = await inner(name, args);
    seen.set(key, value);
    if (isErrorEnvelope(value)) {
      record(name, argsKey, 'error');
      return { ...(value as Record<string, unknown>), note: ERROR_RESULT_NOTE };
    }
    if (isEmpty(value)) {
      record(name, argsKey, 'empty');
      return { result: value ?? null, note: EMPTY_RESULT_NOTE };
    }
    record(name, argsKey, 'hit');
    return value;
  };

  return {
    dispatch,
    trace,
    callCount: () => calls,
    summary: () => {
      const head = `${calls} 次调用 · 命中 ${counts.hit} · 空 ${counts.empty} · 重复 ${counts.repeat} · 失败 ${counts.error}`;
      if (calls === 0) return head;
      const tail = trace
        .slice(-8)
        .map((t) => `${t.name}(${t.args})→${t.outcome}`)
        .join(' ; ');
      return `${head} · 最近: ${tail}`;
    },
  };
}
