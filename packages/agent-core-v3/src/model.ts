import { streamText, type ModelMessage, type ToolSet } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { DEFAULT_INFRA_RETRY } from "./retry.js";
import type { InfraRetryPolicy, RunModelInput, RunModelResult, V3Model } from "./types.js";

export function createOpenRouterModel(input: {
  apiKey: string;
  model: string;
}): V3Model {
  return createOpenRouter({ apiKey: input.apiKey })(input.model);
}

export interface StreamTurnResult {
  readonly text: string;
  readonly finishReason: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly toolCalls: Awaited<ReturnType<typeof streamText>["toolCalls"]>;
  readonly responseMessages: Awaited<
    ReturnType<typeof streamText>["response"]
  >["messages"];
}

/**
 * One streamed model call.
 *
 * Transient-error retries are delegated to the AI SDK (`maxRetries`), which is
 * provider-aware (honours `APICallError.isRetryable`, `Retry-After`, and
 * exponential backoff) — we do not re-implement that classification here.
 *
 * The system prompt is passed via streamText's `system` option; the AI SDK
 * forbids `role: "system"` entries inside `messages`.
 */
export async function streamTurn(input: {
  readonly model: V3Model;
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: ToolSet;
  readonly signal?: AbortSignal;
  readonly retry: InfraRetryPolicy;
  readonly onTextDelta?: (delta: string) => void | Promise<void>;
}): Promise<StreamTurnResult> {
  const response = streamText({
    model: input.model,
    ...(input.system ? { system: input.system } : {}),
    messages: [...input.messages],
    ...(input.tools ? { tools: input.tools } : {}),
    abortSignal: input.signal,
    maxRetries: input.retry.maxRetries,
  });

  for await (const delta of response.textStream) {
    await input.onTextDelta?.(delta);
  }

  const [text, finishReason, usage, toolCalls, response_] = await Promise.all([
    response.text,
    response.finishReason,
    response.usage,
    response.toolCalls,
    response.response,
  ]);

  return {
    text,
    finishReason,
    inputTokens: usage.inputTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    toolCalls,
    responseMessages: response_.messages,
  };
}

/** One streamed model call. No tool loop. */
export async function runModel(input: RunModelInput): Promise<RunModelResult> {
  const turn = await streamTurn({
    model: input.model,
    ...(input.system ? { system: input.system } : {}),
    messages: input.messages,
    signal: input.signal,
    retry: input.infraRetry ?? DEFAULT_INFRA_RETRY,
    ...(input.onTextDelta ? { onTextDelta: input.onTextDelta } : {}),
  });

  return {
    text: turn.text,
    finishReason: turn.finishReason,
    inputTokens: turn.inputTokens,
    cachedInputTokens: turn.cachedInputTokens,
    outputTokens: turn.outputTokens,
    turns: 1,
    toolCalls: 0,
  };
}
