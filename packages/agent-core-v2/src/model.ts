import { streamText, type LanguageModel, type ModelMessage } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export type { ModelMessage } from "ai";
export type V2Model = LanguageModel;

export interface RunModelInput {
  readonly model: LanguageModel;
  readonly messages: readonly ModelMessage[];
  readonly onTextDelta?: (delta: string) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

export interface RunModelResult {
  readonly text: string;
  readonly finishReason: string;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
}

export type AgentEvent =
  | { readonly type: "started" }
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "completed"; readonly text: string }
  | { readonly type: "cancelled" };

export interface RunAgentInput extends RunModelInput {
  readonly onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export function createOpenRouterModel(input: {
  apiKey: string;
  model: string;
}): LanguageModel {
  return createOpenRouter({ apiKey: input.apiKey })(input.model);
}

/** One streaming model call. Tools and follow-up turns are intentionally absent. */
export async function runModel(input: RunModelInput): Promise<RunModelResult> {
  const response = streamText({
    model: input.model,
    messages: [...input.messages],
    abortSignal: input.signal,
    maxRetries: 0,
    streamRetries: 0,
  });

  for await (const delta of response.textStream) {
    await input.onTextDelta?.(delta);
  }

  const [text, finishReason, usage] = await Promise.all([
    response.text,
    response.finishReason,
    response.usage,
  ]);
  return {
    text,
    finishReason,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.inputTokenDetails.cacheReadTokens,
    outputTokens: usage.outputTokens,
  };
}

/** The Phase 0 agent: one streamed model call and a tiny event surface. */
export async function runAgent(input: RunAgentInput): Promise<RunModelResult> {
  await input.onEvent?.({ type: "started" });
  try {
    const result = await runModel({
      ...input,
      onTextDelta: async (delta) => {
        await input.onTextDelta?.(delta);
        await input.onEvent?.({ type: "text_delta", delta });
      },
    });
    await input.onEvent?.({ type: "completed", text: result.text });
    return result;
  } catch (error) {
    if (input.signal?.aborted) {
      await input.onEvent?.({ type: "cancelled" });
    }
    throw error;
  }
}
