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

/** Chat Completions shapes — OpenRouter's OpenAI-compatible surface. */
export interface OpenAIChatTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export type OpenAIChatMessage =
  | { readonly role: "system" | "user" | "assistant"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls: readonly OpenAIChatToolCall[];
    }
  | {
      readonly role: "tool";
      readonly tool_call_id: string;
      readonly content: string;
    };

export interface OpenAIChatToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface OpenAIChatCompletion {
  readonly choices: ReadonlyArray<{
    readonly message?: {
      readonly content?: string | null;
      readonly tool_calls?: readonly OpenAIChatToolCall[];
    };
    readonly finish_reason?: string | null;
  }>;
  readonly usage?: {
    readonly prompt_tokens?: number;
    readonly completion_tokens?: number;
    readonly prompt_tokens_details?: { readonly cached_tokens?: number };
    readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
  };
}

export interface OpenAIChatCompletionsCreateParams {
  readonly model: string;
  readonly messages: readonly OpenAIChatMessage[];
  readonly tools?: readonly OpenAIChatTool[];
  readonly tool_choice?: "auto" | "required";
  readonly stream?: boolean;
  /** OpenAI-compatible: include usage on the final stream chunk. */
  readonly stream_options?: { readonly include_usage?: boolean };
}

export interface OpenAIChatCompletionChunk {
  readonly choices: ReadonlyArray<{
    readonly delta?: {
      readonly content?: string | null;
      readonly tool_calls?: ReadonlyArray<{
        readonly index?: number;
        readonly id?: string;
        readonly type?: string;
        readonly function?: {
          readonly name?: string;
          readonly arguments?: string;
        };
      }>;
    };
    readonly finish_reason?: string | null;
  }>;
  /** Present on the final chunk when `stream_options.include_usage` is set. */
  readonly usage?: OpenAIChatCompletion["usage"];
}

export interface OpenAIChatCompletionsClient {
  chat: {
    completions: {
      create(
        params: OpenAIChatCompletionsCreateParams,
        options?: { signal?: AbortSignal },
      ): Promise<
        OpenAIChatCompletion | AsyncIterable<OpenAIChatCompletionChunk>
      >;
    };
  };
}

export interface OpenRouterAgentModelOptions {
  readonly client: OpenAIChatCompletionsClient;
  readonly model: string;
  readonly system?: string;
  readonly providerLabel?: string;
}

/**
 * OpenRouter via OpenAI Chat Completions compatibility.
 * Streams token deltas when `request.onTextDelta` is set.
 */
export function createOpenRouterAgentModel(
  options: OpenRouterAgentModelOptions,
): AgentModel {
  const systemOverride = options.system;
  const providerLabel = options.providerLabel ?? "OpenRouter";

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.signal?.aborted) {
        throw cancelledError();
      }

      const system = resolveAgentSystemPrompt(request, systemOverride);
      const startedAt = Date.now();
      let timeToFirstTokenMs: number | undefined;

      const baseParams = {
        model: options.model,
        messages: [
          { role: "system" as const, content: system },
          ...toOpenAIChatMessages(request.messages),
        ],
        ...(request.tools.length > 0
          ? {
              tools: request.tools.map(toOpenAIChatTool),
              tool_choice:
                request.toolChoice === "required"
                  ? ("required" as const)
                  : ("auto" as const),
            }
          : {}),
      };
      const callOptions = request.signal
        ? { signal: request.signal }
        : undefined;

      try {
        if (request.onTextDelta) {
          const stream = (await options.client.chat.completions.create(
            {
              ...baseParams,
              stream: true,
              stream_options: { include_usage: true },
            },
            callOptions,
          )) as AsyncIterable<OpenAIChatCompletionChunk>;

          let content = "";
          let finishReason: string | null | undefined;
          let streamUsage: OpenAIChatCompletion["usage"] | undefined;
          const toolAcc = new Map<
            number,
            { id: string; name: string; arguments: string }
          >();

          for await (const chunk of stream) {
            if (request.signal?.aborted) {
              throw cancelledError();
            }
            if (chunk.usage) {
              streamUsage = chunk.usage;
            }
            const choice = chunk.choices[0];
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }
            const delta = choice?.delta;
            if (!delta) continue;

            if (typeof delta.content === "string" && delta.content.length > 0) {
              if (timeToFirstTokenMs === undefined) {
                timeToFirstTokenMs = Date.now() - startedAt;
              }
              content += delta.content;
              await request.onTextDelta(delta.content);
            }

            for (const toolDelta of delta.tool_calls ?? []) {
              if (timeToFirstTokenMs === undefined) {
                timeToFirstTokenMs = Date.now() - startedAt;
              }
              const index = toolDelta.index ?? 0;
              const current = toolAcc.get(index) ?? {
                id: "",
                name: "",
                arguments: "",
              };
              if (toolDelta.id) {
                current.id = toolDelta.id;
              }
              if (toolDelta.function?.name) {
                current.name += toolDelta.function.name;
              }
              if (toolDelta.function?.arguments) {
                current.arguments += toolDelta.function.arguments;
              }
              toolAcc.set(index, current);
            }
          }

          // Stream may end quietly when AbortSignal fires — treat as cancel so
          // AgentRunner timeouts fail the run instead of "completing" empty.
          if (request.signal?.aborted) {
            throw cancelledError();
          }

          const toolCalls: ModelToolCall[] = [...toolAcc.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, call]) => ({
              id: call.id || `tool_${call.name || "call"}`,
              name: call.name,
              input: parseJsonObject(call.arguments),
            }))
            .filter((call) => call.name.length > 0);

          return withOpenRouterMeta(
            {
              content: content.trim(),
              toolCalls,
            },
            options.model,
            startedAt,
            timeToFirstTokenMs,
            {
              choices: [{ finish_reason: finishReason ?? null }],
              ...(streamUsage ? { usage: streamUsage } : {}),
            },
          );
        }

        const completion = (await options.client.chat.completions.create(
          { ...baseParams, stream: false },
          callOptions,
        )) as OpenAIChatCompletion;
        return withOpenRouterMeta(
          fromOpenAIChatCompletion(completion),
          options.model,
          startedAt,
          timeToFirstTokenMs,
          completion,
        );
      } catch (error) {
        if (request.signal?.aborted || isAbortLike(error)) {
          throw cancelledError(error);
        }
        throw normalizeProviderError(error, providerLabel);
      }
    },
  };
}

export function toOpenAIChatTool(tool: ModelToolDefinition): OpenAIChatTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: ensureObjectSchema(tool.inputSchema),
    },
  };
}

export function toOpenAIChatMessages(
  messages: readonly ModelMessage[],
): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls = message.toolCalls ?? [];
      if (toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: message.content.trim() ? message.content : null,
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: {
              name: call.name,
              arguments: safeJsonStringify(call.input ?? {}),
            },
          })),
        });
      } else {
        out.push({ role: "assistant", content: message.content });
      }
      continue;
    }

    out.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      content: formatToolResultContent(message),
    });
  }

  return out;
}

export function fromOpenAIChatCompletion(
  completion: OpenAIChatCompletion,
): ModelResponse {
  const message = completion.choices[0]?.message;
  const toolCalls: ModelToolCall[] = (message?.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    input: parseJsonObject(call.function.arguments),
  }));

  return {
    content: (message?.content ?? "").trim(),
    toolCalls,
  };
}

function withOpenRouterMeta(
  response: ModelResponse,
  modelId: string,
  startedAt: number,
  timeToFirstTokenMs?: number,
  raw?: OpenAIChatCompletion,
): ModelResponse {
  const usage = raw?.usage;
  const finishReason = raw?.choices[0]?.finish_reason;
  return {
    ...response,
    meta: {
      provider: "openrouter",
      modelId,
      latencyMs: Date.now() - startedAt,
      ...(timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs } : {}),
      ...(finishReason ? { finishReason: String(finishReason) } : {}),
      ...(usage
        ? {
            usage: {
              ...(typeof usage.prompt_tokens === "number"
                ? { inputTokens: usage.prompt_tokens }
                : {}),
              ...(typeof usage.completion_tokens === "number"
                ? { outputTokens: usage.completion_tokens }
                : {}),
              ...(typeof usage.prompt_tokens_details?.cached_tokens === "number"
                ? {
                    cachedInputTokens:
                      usage.prompt_tokens_details.cached_tokens,
                  }
                : {}),
              ...(typeof usage.completion_tokens_details?.reasoning_tokens ===
              "number"
                ? {
                    reasoningTokens:
                      usage.completion_tokens_details.reasoning_tokens,
                  }
                : {}),
            },
          }
        : {}),
    },
  };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function parseJsonObject(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}
