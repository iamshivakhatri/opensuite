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
  DEFAULT_AGENT_SYSTEM,
  ensureObjectSchema,
  formatToolResultContent,
  isAbortLike,
  normalizeProviderError,
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
  }>;
}

export interface OpenAIChatCompletionsCreateParams {
  readonly model: string;
  readonly messages: readonly OpenAIChatMessage[];
  readonly tools?: readonly OpenAIChatTool[];
  readonly tool_choice?: "auto";
}

export interface OpenAIChatCompletionsClient {
  chat: {
    completions: {
      create(
        params: OpenAIChatCompletionsCreateParams,
        options?: { signal?: AbortSignal },
      ): Promise<OpenAIChatCompletion>;
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
 * Separate from the OpenAI Responses adapter — OpenRouter's stable surface is chat/completions.
 */
export function createOpenRouterAgentModel(
  options: OpenRouterAgentModelOptions,
): AgentModel {
  const system = options.system ?? DEFAULT_AGENT_SYSTEM;
  const providerLabel = options.providerLabel ?? "OpenRouter";

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.signal?.aborted) {
        throw cancelledError();
      }

      try {
        const completion = await options.client.chat.completions.create(
          {
            model: options.model,
            messages: [
              { role: "system", content: system },
              ...toOpenAIChatMessages(request.messages),
            ],
            ...(request.tools.length > 0
              ? {
                  tools: request.tools.map(toOpenAIChatTool),
                  tool_choice: "auto" as const,
                }
              : {}),
          },
          request.signal ? { signal: request.signal } : undefined,
        );
        return fromOpenAIChatCompletion(completion);
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
