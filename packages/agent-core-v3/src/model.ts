import { streamText, type ModelMessage, type ToolSet } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import { DEFAULT_INFRA_RETRY } from "./retry.js";
import type { InfraRetryPolicy, RunModelInput, RunModelResult, V3Model } from "./types.js";

export function createOpenRouterModel(input: {
  apiKey: string;
  model: string;
}): V3Model {
  // usage.include surfaces OpenRouter cost + token details in providerMetadata.
  return createOpenRouter({ apiKey: input.apiKey })(input.model, {
    usage: { include: true },
    provider: { sort: "throughput" },
    ...(input.model === "deepseek/deepseek-v4.1-flash"
      ? { reasoning: { effort: "low" as const } }
      : {}),
  });
}

export interface StreamTurnResult {
  readonly text: string;
  readonly finishReason: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /** OpenRouter usage.cost when present — authoritative provider charge in USD. */
  readonly providerReportedCostUsd?: number;
  readonly resolvedModelId?: string;
  readonly routedProvider?: string;
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
  readonly maxOutputTokens?: number;
  readonly signal?: AbortSignal;
  readonly retry: InfraRetryPolicy;
  readonly onTextDelta?: (delta: string) => void | Promise<void>;
  readonly onStreamPart?: (kind: "reasoning" | "text" | "tool") => void | Promise<void>;
}): Promise<StreamTurnResult> {
  const response = streamText({
    model: input.model,
    ...(input.system ? { system: input.system } : {}),
    messages: [...input.messages],
    ...(input.tools ? { tools: input.tools } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    abortSignal: input.signal,
    maxRetries: input.retry.maxRetries,
  });

  const seenStreamParts = new Set<"reasoning" | "text" | "tool">();
  for await (const part of response.fullStream) {
    if (part.type === "reasoning-delta" && part.text.length > 0) {
      if (!seenStreamParts.has("reasoning")) {
        seenStreamParts.add("reasoning");
        await input.onStreamPart?.("reasoning");
      }
    } else if (part.type === "text-delta" && part.text.length > 0) {
      if (!seenStreamParts.has("text")) {
        seenStreamParts.add("text");
        await input.onStreamPart?.("text");
      }
      await input.onTextDelta?.(part.text);
    } else if (part.type === "tool-input-delta" && part.delta.length > 0) {
      if (!seenStreamParts.has("tool")) {
        seenStreamParts.add("tool");
        await input.onStreamPart?.("tool");
      }
    } else if (part.type === "tool-call") {
      if (!seenStreamParts.has("tool")) {
        seenStreamParts.add("tool");
        await input.onStreamPart?.("tool");
      }
    }
  }

  const [text, finishReason, usage, toolCalls, response_, providerMetadata] =
    await Promise.all([
      response.text,
      response.finishReason,
      response.usage,
      response.toolCalls,
      response.response,
      response.providerMetadata,
    ]);

  const providerReportedCostUsd = openRouterCostUsd(providerMetadata);
  const routedProvider = openRouterProvider(providerMetadata);
  const responseMeta = response_ as unknown as {
    modelId?: unknown;
    model?: unknown;
  };
  const resolvedModelId =
    typeof responseMeta.modelId === "string"
      ? responseMeta.modelId
      : typeof responseMeta.model === "string"
        ? responseMeta.model
        : undefined;

  return {
    text,
    finishReason,
    inputTokens: usage.inputTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
    ...(providerReportedCostUsd !== undefined
      ? { providerReportedCostUsd }
      : {}),
    ...(resolvedModelId !== undefined ? { resolvedModelId } : {}),
    ...(routedProvider !== undefined ? { routedProvider } : {}),
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
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
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
    reasoningTokens: turn.reasoningTokens,
    ...(turn.providerReportedCostUsd !== undefined
      ? { providerReportedCostUsd: turn.providerReportedCostUsd }
      : {}),
    ...(turn.resolvedModelId !== undefined
      ? { resolvedModelId: turn.resolvedModelId }
      : {}),
    turns: 1,
    toolCalls: 0,
  };
}

/** Read OpenRouter usage.cost from AI SDK providerMetadata when present. */
export function openRouterCostUsd(providerMetadata: unknown): number | undefined {
  if (providerMetadata === null || typeof providerMetadata !== "object") {
    return undefined;
  }
  const openrouter = (providerMetadata as Record<string, unknown>).openrouter;
  if (openrouter === null || typeof openrouter !== "object") {
    return undefined;
  }
  const usage = (openrouter as Record<string, unknown>).usage;
  if (usage === null || typeof usage !== "object") {
    return undefined;
  }
  const cost = (usage as Record<string, unknown>).cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0
    ? cost
    : undefined;
}

/** Read the OpenRouter provider that actually served this turn. */
export function openRouterProvider(providerMetadata: unknown): string | undefined {
  if (providerMetadata === null || typeof providerMetadata !== "object") return undefined;
  const openrouter = (providerMetadata as Record<string, unknown>).openrouter;
  if (openrouter === null || typeof openrouter !== "object") return undefined;
  const provider = (openrouter as Record<string, unknown>).provider;
  return typeof provider === "string" && provider.length > 0 ? provider : undefined;
}
