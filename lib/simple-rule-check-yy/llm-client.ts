/**
 * Thin wrapper over OpenAI Chat Completions for the Rule Checker.
 *
 * One responsibility: send `(system, user)` messages with a strict
 * `response_format.json_schema` constraint, parse the structured response,
 * record latency + token counts. Retry once on transient errors per SPEC §11.
 *
 * Provider portability: the OpenAI SDK accepts a `baseURL` option, so any
 * OpenAI-compatible endpoint (OpenRouter, DeepSeek, Moonshot, local
 * vLLM/ollama) can be targeted by setting `OPENAI_BASE_URL`.
 */

import OpenAI from "openai";

import { RuleJudgmentJsonSchema } from "./output-schema";

export class LLMUnreachableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "LLMUnreachableError";
  }
}

export interface LLMEvaluateInput {
  system: string;
  user: string;
  /** Override model. Defaults to `OPENAI_MODEL` env or "gpt-4o". */
  model?: string;
  /** Override key. Defaults to `OPENAI_API_KEY` env. */
  apiKey?: string;
  /** Override base URL. Defaults to `OPENAI_BASE_URL` env or OpenAI default. */
  baseUrl?: string;
  /** Schema name to label the response_format JSON Schema. */
  schemaName?: string;
}

export interface LLMEvaluateOutput {
  /** The raw API response — kept verbatim for audit replay. */
  response: unknown;
  model: string;
  /** Parsed JSON content (Zod parsing happens at the caller). */
  contentJson: unknown;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

const DEFAULT_MODEL = "gpt-4o";

export async function evaluate(input: LLMEvaluateInput): Promise<LLMEvaluateOutput> {
  const apiKey = input.apiKey ?? process.env["OPENAI_API_KEY"] ?? "";
  if (!apiKey) {
    throw new LLMUnreachableError(
      "OPENAI_API_KEY is not set (and no apiKey override provided)",
    );
  }
  const baseURL = input.baseUrl ?? process.env["OPENAI_BASE_URL"];
  const model = input.model ?? process.env["OPENAI_MODEL"] ?? DEFAULT_MODEL;
  const schemaName = input.schemaName ?? "RuleJudgment";

  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });

  const attempt = async (): Promise<LLMEvaluateOutput> => {
    const t0 = Date.now();
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: schemaName,
          schema: RuleJudgmentJsonSchema as unknown as Record<string, unknown>,
          strict: true,
        },
      },
    });
    const latencyMs = Date.now() - t0;

    const choice = response.choices[0];
    if (!choice || !choice.message || typeof choice.message.content !== "string") {
      throw new LLMUnreachableError(
        `LLM response missing message content (model=${model})`,
        response,
      );
    }
    let contentJson: unknown;
    try {
      contentJson = JSON.parse(choice.message.content);
    } catch (err) {
      throw new LLMUnreachableError(
        `LLM message content is not valid JSON (model=${model}): ${(err as Error).message}`,
        choice.message.content,
      );
    }

    // The OpenAI SDK returns a class instance, which React Server Components
    // refuse to pass across the RSC boundary ("Only plain objects can be
    // passed…"). JSON round-trip strips the prototype + methods, leaving
    // only the data we want for audit. The shape is preserved verbatim.
    const plainResponse: unknown = JSON.parse(JSON.stringify(response));
    return {
      response: plainResponse,
      model: response.model ?? model,
      contentJson,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      latencyMs,
    };
  };

  try {
    return await attempt();
  } catch (err) {
    if (isRetryable(err)) {
      // 1 retry per SPEC §11
      await sleep(500);
      try {
        return await attempt();
      } catch (err2) {
        throw new LLMUnreachableError(
          `LLM call failed twice: ${(err2 as Error).message}`,
          err2,
        );
      }
    }
    if (err instanceof LLMUnreachableError) throw err;
    throw new LLMUnreachableError(
      `LLM call failed: ${(err as Error).message}`,
      err,
    );
  }
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
