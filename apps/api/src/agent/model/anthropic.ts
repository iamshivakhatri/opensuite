import {
  AgentCoreError,
  type AgentModel,
  type ModelMessage,
  type ModelRequest,
  type ModelResponse,
  type ModelToolCall,
  type ModelToolDefinition,
} from "@opensuite/agent-core";

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
}

export interface AnthropicMessagesCreateParams {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly AnthropicMessageParam[];
  readonly tools?: readonly AnthropicToolDefinition[];
  readonly system?: string;
}

export interface AnthropicMessagesClient {
  messages: {
    create(
      params: AnthropicMessagesCreateParams,
      options?: { signal?: AbortSignal },
    ): Promise<AnthropicMessage>;
  };
}

export interface AnthropicAgentModelOptions {
  readonly client: AnthropicMessagesClient;
  readonly model: string;
  readonly maxTokens?: number;
  readonly system?: string;
}

const DEFAULT_SYSTEM =
  "You are OpenSuite, an AI office assistant. Be concise and helpful. " +
  "Do not claim you inspected or edited Office file contents unless a tool result confirms it.";

/**
 * Anthropic Messages API → OpenSuite AgentModel adapter.
 * Lives in apps/api — agent-core never imports the Anthropic SDK.
 */
export function createAnthropicAgentModel(
  options: AnthropicAgentModelOptions,
): AgentModel {
  const maxTokens = options.maxTokens ?? 4096;
  const system = options.system ?? DEFAULT_SYSTEM;

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (request.signal?.aborted) {
        throw cancelledError();
      }

      try {
        const message = await options.client.messages.create(
          {
            model: options.model,
            max_tokens: maxTokens,
            system,
            messages: toAnthropicMessages(request.messages),
            tools:
              request.tools.length > 0
                ? request.tools.map(toAnthropicTool)
                : undefined,
          },
          request.signal ? { signal: request.signal } : undefined,
        );
        return fromAnthropicMessage(message);
      } catch (error) {
        if (request.signal?.aborted || isAbortLike(error)) {
          throw cancelledError(error);
        }
        throw normalizeProviderError(error);
      }
    },
  };
}

export function toAnthropicTool(
  tool: ModelToolDefinition,
): AnthropicToolDefinition {
  const schema: Record<string, unknown> =
    tool.inputSchema && typeof tool.inputSchema === "object"
      ? { ...tool.inputSchema }
      : {};
  if (schema.type === undefined) {
    schema.type = "object";
  }
  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema,
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

    // role === "tool" — gather consecutive tool results
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

function formatToolResultContent(
  message: Extract<ModelMessage, { role: "tool" }>,
): string {
  const parts: string[] = [];
  parts.push(`status=${message.status}`);
  if (message.summary) {
    parts.push(message.summary);
  }
  if (message.output !== undefined) {
    try {
      parts.push(JSON.stringify(message.output));
    } catch {
      parts.push(String(message.output));
    }
  }
  if (message.diagnostic?.message) {
    parts.push(message.diagnostic.message);
  }
  return parts.join("\n").slice(0, 8_000);
}

function cancelledError(cause?: unknown): AgentCoreError {
  return new AgentCoreError("CANCELLED", "Model call aborted", {
    diagnostic: {
      code: "CANCELLED",
      severity: "error",
      message: "Model call aborted",
    },
    cause,
  });
}

function isAbortLike(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = "name" in error ? String(error.name) : "";
  return (
    name === "AbortError" ||
    name === "APIUserAbortError" ||
    ("code" in error && error.code === "CANCELLED")
  );
}

/**
 * Map provider exceptions to AgentCoreError without leaking raw payloads.
 */
export function normalizeProviderError(error: unknown): AgentCoreError {
  if (error instanceof AgentCoreError) {
    return error;
  }

  const status =
    error && typeof error === "object" && "status" in error
      ? Number(error.status)
      : undefined;

  let message = "Anthropic model request failed";
  if (status === 401 || status === 403) {
    message = "Anthropic authentication failed";
  } else if (status === 429) {
    message = "Anthropic rate limit exceeded";
  } else if (status !== undefined && status >= 500) {
    message = "Anthropic service unavailable";
  }

  return new AgentCoreError("MODEL_FAILURE", message, {
    diagnostic: {
      code: "MODEL_FAILURE",
      severity: "error",
      message,
    },
    cause: error,
  });
}
