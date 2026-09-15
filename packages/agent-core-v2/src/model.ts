import {
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolResultPart,
  type ToolSet,
} from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

export type { ModelMessage, ToolSet } from "ai";
export type V2Model = LanguageModel;

const DEFAULT_MAX_TURNS = 10;

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
  readonly turns: number;
}

export type AgentEvent =
  | { readonly type: "started" }
  | { readonly type: "text_delta"; readonly delta: string }
  | {
      readonly type: "tool_started";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly type: "tool_completed";
      readonly toolCallId: string;
      readonly toolName: string;
    }
  | {
      readonly type: "tool_failed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly error: string;
    }
  | { readonly type: "completed"; readonly text: string }
  | { readonly type: "cancelled" };

export interface RunAgentInput extends RunModelInput {
  readonly tools?: ToolSet;
  readonly maxTurns?: number;
  readonly onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export class MaxTurnsExceededError extends Error {
  readonly maxTurns: number;
  constructor(maxTurns: number) {
    super(`Agent exceeded maxTurns (${maxTurns})`);
    this.name = "MaxTurnsExceededError";
    this.maxTurns = maxTurns;
  }
}

export function createOpenRouterModel(input: {
  apiKey: string;
  model: string;
}): LanguageModel {
  return createOpenRouter({ apiKey: input.apiKey })(input.model);
}

/** One streaming model call. No tool loop. */
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
    turns: 1,
  };
}

/**
 * Model → tools → model loop.
 * One turn = one model invocation. All sibling tool calls from that response
 * run sequentially before the next model invocation.
 */
export async function runAgent(input: RunAgentInput): Promise<RunModelResult> {
  await input.onEvent?.({ type: "started" });
  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const workingMessages: ModelMessage[] = [...input.messages];
  let turns = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;

  try {
    while (true) {
      if (input.signal?.aborted) {
        throw abortError(input.signal);
      }
      if (turns >= maxTurns) {
        throw new MaxTurnsExceededError(maxTurns);
      }
      turns += 1;

      // Schema-only tools so AI SDK does not auto-execute (it would parallelize).
      const response = streamText({
        model: input.model,
        messages: workingMessages,
        tools: input.tools ? schemaOnlyTools(input.tools) : undefined,
        abortSignal: input.signal,
        maxRetries: 0,
        streamRetries: 0,
      });

      for await (const delta of response.textStream) {
        await input.onTextDelta?.(delta);
        await input.onEvent?.({ type: "text_delta", delta });
      }

      const [text, finishReason, usage, toolCalls, responseMessages] =
        await Promise.all([
          response.text,
          response.finishReason,
          response.usage,
          response.toolCalls,
          response.responseMessages,
        ]);

      inputTokens += usage.inputTokens ?? 0;
      cachedInputTokens += usage.inputTokenDetails.cacheReadTokens ?? 0;
      outputTokens += usage.outputTokens ?? 0;

      if (toolCalls.length === 0) {
        const result: RunModelResult = {
          text,
          finishReason,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          turns,
        };
        await input.onEvent?.({ type: "completed", text });
        return result;
      }

      workingMessages.push(...responseMessages);

      const toolContent: ToolResultPart[] = [];

      for (const call of toolCalls) {
        if (input.signal?.aborted) {
          throw abortError(input.signal);
        }

        const toolName = call.toolName;
        const toolCallId = call.toolCallId;
        await input.onEvent?.({ type: "tool_started", toolCallId, toolName });

        try {
          const tool = input.tools?.[toolName];
          if (call.invalid || tool?.execute == null) {
            throw new Error(
              call.invalid
                ? errorMessage(call.error) || `Invalid tool call: ${toolName}`
                : `Unknown tool: ${toolName}`,
            );
          }

          const output = await tool.execute(call.input, {
            toolCallId,
            messages: workingMessages,
            abortSignal: input.signal,
            context: {},
          });

          toolContent.push({
            type: "tool-result",
            toolCallId,
            toolName,
            output:
              typeof output === "string"
                ? { type: "text", value: output }
                : {
                    type: "json",
                    value: (output === undefined ? null : output) as never,
                  },
          });
          await input.onEvent?.({ type: "tool_completed", toolCallId, toolName });
        } catch (error) {
          if (input.signal?.aborted) {
            throw error;
          }
          const message = errorMessage(error);
          toolContent.push({
            type: "tool-result",
            toolCallId,
            toolName,
            output: { type: "error-text", value: message },
          });
          await input.onEvent?.({
            type: "tool_failed",
            toolCallId,
            toolName,
            error: message,
          });
        }
      }

      workingMessages.push({ role: "tool", content: toolContent });
    }
  } catch (error) {
    if (input.signal?.aborted) {
      await input.onEvent?.({ type: "cancelled" });
    }
    throw error;
  }
}

/** AI SDK only needs schemas for the model call; we execute tools ourselves. */
function schemaOnlyTools(tools: ToolSet): ToolSet {
  const out: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(tools)) {
    const { execute: _execute, ...rest } = definition as {
      execute?: unknown;
    } & (typeof tools)[string];
    out[name] = rest;
  }
  return out as ToolSet;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Tool execution failed";
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Agent run aborted");
}
