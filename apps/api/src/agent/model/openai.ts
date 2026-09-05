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

/** Minimal OpenAI Responses shapes for injectable/mocked clients. */
export interface OpenAIResponsesTool {
  readonly type: "function";
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly strict?: boolean;
}

export type OpenAIResponsesInputItem =
  | { readonly role: "user" | "assistant" | "system"; readonly content: string }
  | {
      readonly type: "function_call";
      readonly call_id: string;
      readonly name: string;
      readonly arguments: string;
    }
  | {
      readonly type: "function_call_output";
      readonly call_id: string;
      readonly output: string;
    };

export type OpenAIResponsesOutputItem =
  | {
      readonly type: "message";
      readonly role?: string;
      readonly content?: ReadonlyArray<{
        readonly type?: string;
        readonly text?: string;
      }>;
    }
  | {
      readonly type: "function_call";
      readonly call_id: string;
      readonly name: string;
      readonly arguments: string;
    };

export interface OpenAIResponsesResult {
  readonly output: readonly OpenAIResponsesOutputItem[];
  readonly output_text?: string;
}

export interface OpenAIResponsesCreateParams {
  readonly model: string;
  readonly input: readonly OpenAIResponsesInputItem[];
  readonly tools?: readonly OpenAIResponsesTool[];
  readonly instructions?: string;
  readonly max_output_tokens?: number;
}

export interface OpenAIResponsesClient {
  responses: {
    create(
      params: OpenAIResponsesCreateParams,
      options?: { signal?: AbortSignal },
    ): Promise<OpenAIResponsesResult>;
  };
}

export interface OpenAIAgentModelOptions {
  readonly client: OpenAIResponsesClient;
  readonly model: string;
  readonly maxOutputTokens?: number;
  readonly system?: string;
  readonly providerLabel?: string;
}

/**
 * OpenAI Responses API → OpenSuite AgentModel adapter.
 */
export function createOpenAIAgentModel(
  options: OpenAIAgentModelOptions,
): AgentModel {
  const maxOutputTokens = options.maxOutputTokens ?? 4096;
  const system = options.system ?? DEFAULT_AGENT_SYSTEM;
  const providerLabel = options.providerLabel ?? "OpenAI";

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.signal?.aborted) {
        throw cancelledError();
      }

      try {
        const result = await options.client.responses.create(
          {
            model: options.model,
            instructions: system,
            max_output_tokens: maxOutputTokens,
            input: toOpenAIResponsesInput(request.messages),
            tools:
              request.tools.length > 0
                ? request.tools.map(toOpenAIResponsesTool)
                : undefined,
          },
          request.signal ? { signal: request.signal } : undefined,
        );
        return fromOpenAIResponsesResult(result);
      } catch (error) {
        if (request.signal?.aborted || isAbortLike(error)) {
          throw cancelledError(error);
        }
        throw normalizeProviderError(error, providerLabel);
      }
    },
  };
}

export function toOpenAIResponsesTool(
  tool: ModelToolDefinition,
): OpenAIResponsesTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: ensureObjectSchema(tool.inputSchema),
  };
}

/**
 * Map OpenSuite transcript → Responses `input` items.
 * Assistant tool calls become `function_call`; tool results become `function_call_output`.
 */
export function toOpenAIResponsesInput(
  messages: readonly ModelMessage[],
): OpenAIResponsesInputItem[] {
  const out: OpenAIResponsesInputItem[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      if (message.content.trim()) {
        out.push({ role: "assistant", content: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        out.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: safeJsonStringify(call.input ?? {}),
        });
      }
      continue;
    }

    out.push({
      type: "function_call_output",
      call_id: message.toolCallId,
      output: formatToolResultContent(message),
    });
  }

  return out;
}

export function fromOpenAIResponsesResult(
  result: OpenAIResponsesResult,
): ModelResponse {
  const textParts: string[] = [];
  const toolCalls: ModelToolCall[] = [];

  for (const item of result.output) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (
          (part.type === "output_text" || part.type === "text") &&
          typeof part.text === "string" &&
          part.text.trim()
        ) {
          textParts.push(part.text.trim());
        }
      }
    } else if (item.type === "function_call") {
      const call = item as {
        type: "function_call";
        call_id: string;
        name: string;
        arguments: string;
      };
      toolCalls.push({
        id: call.call_id,
        name: call.name,
        input: parseJsonObject(call.arguments),
      });
    }
  }

  const content =
    textParts.join("\n").trim() || (result.output_text ?? "").trim();

  return { content, toolCalls };
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
