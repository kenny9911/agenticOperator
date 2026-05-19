/**
 * LLM client for the full `rule-check` impl — streaming + strict json_schema.
 *
 * Streaming + SSE logging stay locked in (2026-05-13 504 debug). The
 * `response_format` was briefly relaxed to `json_object` and then reverted to
 * `{ type: "json_schema", strict: true, schema: MatchResumeEvalEnvelopeJsonSchema }`
 * so the API-level shape constraint matches the in-prompt skeleton again.
 *
 *   - Always streams (`stream: true`); per-delta lines via rcDebug (gated by
 *     `RULE_CHECK_DEBUG=1`); key events (first_byte / stream_end / error) via
 *     rcInfo. Gives "proxy-died-before-first-byte" vs "LLM-died-mid-stream"
 *     diagnostic visibility.
 *   - `stream_options.include_usage` keeps token counts on the final chunk.
 *   - Logprobs (when enabled) accumulated chunk-by-chunk; `null` →
 *     composite confidence degrades.
 *
 * Knobs:
 *   - `RULE_CHECK_DEBUG=1` — show per-delta lines.
 *   - `RULE_CHECK_LOGPROBS=1` — request token logprobs (off by default; some
 *     providers hang when this is set).
 *   - `OPENAI_TIMEOUT_MS` — request timeout (default 600s).
 */

import OpenAI from "openai";

import { rcDebug, rcInfo, rcWarn } from "./debug";
import { MatchResumeEvalEnvelopeJsonSchema } from "./output-schema-audited";

export class LLMUnreachableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "LLMUnreachableError";
  }
}

export interface LLMEvaluateInput {
  system: string;
  user: string;
  /** Override model. Defaults to OPENAI_MODEL env or "gpt-4o". */
  model?: string;
  /** Override key. Defaults to OPENAI_API_KEY env. */
  apiKey?: string;
  /** Override base URL. Defaults to OPENAI_BASE_URL env or OpenAI default. */
  baseUrl?: string;
  /** Schema name to label the response_format JSON Schema. */
  schemaName?: string;
  /**
   * Enable `logprobs: true` on the chat-completions request. Default is OFF
   * (some providers hang on it). Falls back to env `RULE_CHECK_LOGPROBS=1`.
   * composite confidence degrades gracefully when logprobs are absent — see
   * `lib/rule-check/confidence/composite.ts`.
   */
  enableLogprobs?: boolean;
  /**
   * Override the `response_format.json_schema.schema`. Defaults to
   * `MatchResumeEvalEnvelopeJsonSchema` (full Path B envelope). Path C callers
   * pass `StepResultJsonSchema` per-step.
   */
  jsonSchema?: object;
}

export interface LogprobToken {
  token: string;
  logprob: number;
}

export interface LLMEvaluateOutput {
  /** Plain-object form of the (synthetic) chat-completion response (RSC-safe). */
  response: unknown;
  model: string;
  contentJson: unknown;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  /** null when provider didn't return logprobs (composite confidence degrades). */
  logprobs: LogprobToken[] | null;
}

const DEFAULT_MODEL = "gpt-4o";
let loggedLogprobWarning = false;

export async function evaluate(input: LLMEvaluateInput): Promise<LLMEvaluateOutput> {
  const apiKey = input.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
  if (!apiKey) {
    throw new LLMUnreachableError(
      "OPENAI_API_KEY is not set (and no apiKey override provided)",
    );
  }
  const baseURL = input.baseUrl ?? process.env["OPENAI_BASE_URL"];
  const model = input.model ?? process.env["OPENAI_MODEL"] ?? DEFAULT_MODEL;
  const schemaName = input.schemaName ?? "MatchResumeEvalEnvelope";
  const timeoutMs = resolveTimeoutMs(process.env["OPENAI_TIMEOUT_MS"]);

  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    timeout: timeoutMs,
  });

  const logprobsRequested = resolveLogprobsRequested(input.enableLogprobs);

  rcDebug("llm", "evaluate config", {
    model,
    baseURL: baseURL ?? "(default openai)",
    apiKeyTail: apiKey.slice(-4),
    schemaName,
    responseFormat: "json_schema (strict)",
    streaming: true,
    logprobsRequested,
    timeoutMs,
    systemChars: input.system.length,
    userChars: input.user.length,
  });

  const attempt = async (): Promise<LLMEvaluateOutput> => {
    const t0 = Date.now();
    const stream = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          schema: (input.jsonSchema ?? MatchResumeEvalEnvelopeJsonSchema) as unknown as Record<string, unknown>,
          strict: true,
        },
      },
      stream: true,
      stream_options: { include_usage: true },
      ...(logprobsRequested ? { logprobs: true } : {}),
    });

    let content = "";
    let firstByteMs: number | null = null;
    let deltaCount = 0;
    let finishReason: string | null = null;
    let usage: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
    } | null = null;
    let modelActual = model;
    const logprobAcc: LogprobToken[] = [];

    try {
      for await (const chunk of stream) {
        const c = chunk as {
          model?: string;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
          };
          choices?: Array<{
            delta?: { content?: string | null };
            finish_reason?: string | null;
            logprobs?: { content?: unknown };
          }>;
        };
        if (c.model) modelActual = c.model;
        if (c.usage) usage = c.usage;
        const choice = c.choices?.[0];
        if (!choice) continue;

        const deltaContent = choice.delta?.content;
        if (typeof deltaContent === "string" && deltaContent.length > 0) {
          if (firstByteMs === null) {
            firstByteMs = Date.now() - t0;
            rcInfo("llm", "first_byte", { tookMs: firstByteMs, model: modelActual });
          }
          content += deltaContent;
          deltaCount++;
          rcDebug("llm", "delta", {
            idx: deltaCount,
            chunkChars: deltaContent.length,
            totalChars: content.length,
          });
        }

        if (logprobsRequested && Array.isArray(choice.logprobs?.content)) {
          for (const entry of choice.logprobs.content) {
            if (typeof entry !== "object" || entry === null) continue;
            const e = entry as { token?: unknown; logprob?: unknown };
            if (typeof e.token === "string" && typeof e.logprob === "number") {
              logprobAcc.push({ token: e.token, logprob: e.logprob });
            }
          }
        }

        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (err) {
      rcWarn("llm", "stream error", {
        deltas: deltaCount,
        contentChars: content.length,
        firstByteMs,
        message: (err as Error).message,
      });
      throw err;
    }

    const latencyMs = Date.now() - t0;
    rcInfo("llm", "stream_end", {
      deltas: deltaCount,
      contentChars: content.length,
      firstByteMs,
      latencyMs,
      finishReason,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
    });

    if (content.length === 0) {
      throw new LLMUnreachableError(
        `LLM stream returned no content (model=${modelActual}, deltas=${deltaCount}, latencyMs=${latencyMs})`,
      );
    }

    let contentJson: unknown;
    try {
      contentJson = JSON.parse(content);
    } catch (err) {
      throw new LLMUnreachableError(
        `LLM streamed content is not valid JSON (model=${modelActual}): ${(err as Error).message}`,
        content,
      );
    }

    const logprobs = logprobsRequested
      ? (logprobAcc.length > 0 ? logprobAcc : null)
      : null;
    if (logprobsRequested && logprobs === null && !loggedLogprobWarning) {
      loggedLogprobWarning = true;
      rcWarn(
        "llm",
        "provider did not return logprobs — composite confidence will run in degraded mode",
        { model: modelActual },
      );
    }

    // Synthesize a chat-completion-shaped object so downstream audit storage
    // keeps the same provenance shape it had under non-streaming mode.
    const syntheticResponse = {
      model: modelActual,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: finishReason ?? "stop",
          ...(logprobs ? { logprobs: { content: logprobs } } : {}),
        },
      ],
      usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    return {
      response: syntheticResponse,
      model: modelActual,
      contentJson,
      inputTokens: usage?.prompt_tokens ?? 0,
      outputTokens: usage?.completion_tokens ?? 0,
      latencyMs,
      logprobs,
    };
  };

  try {
    return await attempt();
  } catch (err) {
    if (isRetryable(err)) {
      rcWarn("llm", "retryable error — retrying after 500ms", {
        status: (err as { status?: number }).status,
        message: (err as Error).message,
      });
      await sleep(500);
      try {
        return await attempt();
      } catch (err2) {
        rcWarn("llm", "retry also failed", {
          message: (err2 as Error).message,
        });
        throw new LLMUnreachableError(
          `LLM call failed twice: ${(err2 as Error).message}`,
          err2,
        );
      }
    }
    if (err instanceof LLMUnreachableError) {
      rcInfo("llm", "LLMUnreachableError", { message: err.message });
      throw err;
    }
    rcWarn("llm", "non-retryable error", {
      message: (err as Error).message,
    });
    throw new LLMUnreachableError(`LLM call failed: ${(err as Error).message}`, err);
  }
}

function resolveLogprobsRequested(explicit: boolean | undefined): boolean {
  if (typeof explicit === "boolean") return explicit;
  const raw = process.env["RULE_CHECK_LOGPROBS"];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function resolveTimeoutMs(raw: string | undefined): number {
  const DEFAULT_MS = 600_000;
  if (!raw) return DEFAULT_MS;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MS;
}

function isRetryable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const status = (err as { status?: number; code?: string }).status;
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
