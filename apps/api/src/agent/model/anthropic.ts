import {
  type AgentModel,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
  type ModelToolDefinition,
} from "@opensuite/agent-core";

import {
  cancelledError,
  ensureObjectSchema,
  formatToolResultContent,
  isAbortLike,
  normalizeProviderError,
  resolveAgentSystemPrompt,
} from "./shared.js";

export { normalizeProviderError };

/** Minimal Anthropic Messages shapes used by the adapter (SDK-agnostic for tests). */
export interface AnthropicToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Record<string, unknown>;
}

export type AnthropicContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: string;
      readonly is_error?: boolean;
    };

export interface AnthropicMessageParam {
  readonly role: "user" | "assistant";
  readonly content: string | readonly AnthropicContentBlock[];
}

export interface AnthropicMessage {
  readonly content: readonly AnthropicContentBlock[];
  readonly stop_reason?: string | null;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_read_input_tokens?: number;
  };
}

export interface AnthropicMessagesCreateParams {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly AnthropicMessageParam[];
  readonly tools?: readonly AnthropicToolDefinition[];
  readonly tool_choice?: { readonly type: "auto" } | { readonly type: "any" };
  readonly system?: string;
}

/** Subset of Anthropic stream events needed for text + final message. */
export type AnthropicStreamEvent = {
  readonly type: string;
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
  };
};

export interface AnthropicMessageStream {
  [Symbol.asyncIterator](): AsyncIterator<AnthropicStreamEvent>;
  finalMessage(): Promise<AnthropicMessage>;
}

export interface AnthropicMessagesClient {
  messages: {
    create(
      params: AnthropicMessagesCreateParams,
      options?: { signal?: AbortSignal },
    ): Promise<AnthropicMessage>;
    stream?(
      params: AnthropicMessagesCreateParams,
      options?: { signal?: AbortSignal },
    ): AnthropicMessageStream;
  };
}

export interface AnthropicAgentModelOptions {
  readonly client: AnthropicMessagesClient;
  readonly model: string;
  readonly maxTokens?: number;
  readonly system?: string;
}

/**
 * Anthropic Messages API → OpenSuite AgentModel adapter.
 * Streams text deltas when `request.onTextDelta` is set and `client.messages.stream` exists.
 */
export function createAnthropicAgentModel(
  options: AnthropicAgentModelOptions,
): AgentModel {
  const maxTokens = options.maxTokens ?? 4096;
  const systemOverride = options.system;

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.signal?.aborted) {
        throw cancelledError();
      }

      const system = resolveAgentSystemPrompt(request, systemOverride);
      const startedAt = Date.now();
      let timeToFirstTokenMs: number | undefined;

      const params: AnthropicMessagesCreateParams = {
        model: options.model,
        max_tokens: maxTokens,
        system,
        messages: toAnthropicMessages(request.messages),
        tools:
          request.tools.length > 0
            ? request.tools.map(toAnthropicTool)
            : undefined,
        ...(request.tools.length > 0
          ? {
              tool_choice:
                request.toolChoice === "required"
                  ? ({ type: "any" } as const)
                  : ({ type: "auto" } as const),
            }
          : {}),
      };
      const callOptions = request.signal
        ? { signal: request.signal }
        : undefined;

      try {
        if (request.onTextDelta && options.client.messages.stream) {
          const stream = options.client.messages.stream(params, callOptions);
          for await (const event of stream) {
            if (request.signal?.aborted) {
              throw cancelledError();
            }
            if (event.type === "content_block_delta") {
              const delta = event.delta;
              if (
                delta &&
                typeof delta === "object" &&
                "type" in delta &&
                delta.type === "text_delta" &&
                "text" in delta &&
                typeof delta.text === "string" &&
                delta.text.length > 0
              ) {
                if (timeToFirstTokenMs === undefined) {
                  timeToFirstTokenMs = Date.now() - startedAt;
                }
                await request.onTextDelta(delta.text);
              }
            }
          }
          if (request.signal?.aborted) {
            throw cancelledError();
          }
          return withAnthropicMeta(
            fromAnthropicMessage(await stream.finalMessage()),
            options.model,
            startedAt,
            timeToFirstTokenMs,
          );
        }

        const message = await options.client.messages.create(
          params,
          callOptions,
        );
        const response = fromAnthropicMessage(message);
        if (request.onTextDelta && response.content) {
          await request.onTextDelta(response.content);
        }
        return withAnthropicMeta(
          response,
          options.model,
          startedAt,
          timeToFirstTokenMs,
          message,
        );
      } catch (error) {
        if (request.signal?.aborted || isAbortLike(error)) {
          throw cancelledError(error);
        }
        throw normalizeProviderError(error, "Anthropic");
      }
    },
  };
}

export function toAnthropicTool(
  tool: ModelToolDefinition,
): AnthropicToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: ensureObjectSchema(tool.inputSchema),
  };
}

/**
 * Map OpenSuite transcript → Anthropic messages.
 * Consecutive `tool` messages collapse into one user message of tool_result blocks.
 */
export function toAnthropicMessages(
  messages: readonly ModelMessage[],
): AnthropicMessageParam[] {
  const out: AnthropicMessageParam[] = [];
  let i = 0;

  while (i < messages.length) {
    const message = messages[i]!;

    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      i += 1;
      continue;
    }

    if (message.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (message.content.trim()) {
        blocks.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input:
            call.input && typeof call.input === "object" ? call.input : {},
        });
      }
      out.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
      });
      i += 1;
      continue;
    }

    const toolBlocks: AnthropicContentBlock[] = [];
    while (i < messages.length && messages[i]!.role === "tool") {
      const toolMessage = messages[i]!;
      if (toolMessage.role !== "tool") break;
      toolBlocks.push({
        type: "tool_result",
        tool_use_id: toolMessage.toolCallId,
        content: formatToolResultContent(toolMessage),
        is_error: toolMessage.status !== "succeeded",
      });
      i += 1;
    }
    out.push({ role: "user", content: toolBlocks });
  }

  return out;
}

export function fromAnthropicMessage(message: AnthropicMessage): ModelResponse {
  const textParts: string[] = [];
  const toolCalls: ModelToolCall[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: block.input ?? {},
      });
    }
  }

  return {
    content: textParts.join("\n").trim(),
    toolCalls,
  };
}

function withAnthropicMeta(
  response: ModelResponse,
  modelId: string,
  startedAt: number,
  timeToFirstTokenMs?: number,
  raw?: AnthropicMessage,
): ModelResponse {
  const usage = raw?.usage;
  return {
    ...response,
    meta: {
      provider: "anthropic",
      modelId,
      latencyMs: Date.now() - startedAt,
      ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
      ...(raw?.stop_reason
        ? { finishReason: String(raw.stop_reason) }
        : {}),
      ...(usage
        ? {
            usage: {
              ...(typeof usage.input_tokens === "number"
                ? { inputTokens: usage.input_tokens }
                : {}),
              ...(typeof usage.output_tokens === "number"
                ? { outputTokens: usage.output_tokens }
                : {}),
              ...(typeof usage.cache_read_input_tokens === "number"
                ? { cachedInputTokens: usage.cache_read_input_tokens }
                : {}),
            },
          }
        : {}),
    },
  };
}
