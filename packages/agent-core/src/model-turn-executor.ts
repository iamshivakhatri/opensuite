import { AgentCoreError, isAbortError } from "./errors.js";
import type { AgentEvent, AgentEventSink } from "./events.js";
import type {
  AgentModel,
  ModelMessage,
  ModelResponse,
  ModelToolCall,
  ModelToolDefinition,
} from "./model.js";
import type { ToolOutcome } from "./request.js";
import {
  elapsedMs,
  measureMessagesBytes,
  measureToolArgumentBytes,
  measureToolCatalogBytes,
} from "./telemetry.js";
import type { Diagnostic, RuntimeCapabilities } from "./types.js";

export interface ModelTimeoutContext {
  readonly toolOutcomes: readonly ToolOutcome[];
}

/**
 * Canonical transcript → model-facing messages. The executor owns *when*
 * this runs; the injected function owns *what* projection occurs.
 * Must not mutate the input transcript.
 */
export type TransformAgentContext = (
  transcript: readonly ModelMessage[],
) => ModelMessage[];

/** Generic default: pass transcript through unchanged (shallow copy). */
export function identityTransformContext(
  transcript: readonly ModelMessage[],
): ModelMessage[] {
  return [...transcript];
}

export interface ExecuteModelTurnOptions {
  readonly model: AgentModel;
  readonly transformContext: TransformAgentContext;
  readonly transcript: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly toolChoice?: "auto" | "required";
  readonly capabilities: RuntimeCapabilities;
  readonly forceAnswerOnly: boolean;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly timeoutRetryUsed: boolean;
  readonly getTimeoutRetryMessage?: (
    context: ModelTimeoutContext,
  ) => string | undefined;
  readonly toolOutcomes: readonly ToolOutcome[];
  readonly runId: string;
  readonly turnId: string;
  readonly turnIndex: number;
  readonly messageId: string;
  readonly events: AgentEventSink;
  readonly now: () => Date;
}

export type ModelTurnResult =
  | {
      readonly status: "completed";
      readonly response: ModelResponse;
      readonly toolCalls: readonly ModelToolCall[];
      readonly toolChoice?: "auto" | "required";
    }
  | {
      readonly status: "retry";
      readonly retryMessage: string;
    }
  | {
      readonly status: "failed";
      readonly diagnostic: Diagnostic;
    }
  | {
      readonly status: "cancelled";
    };

/**
 * Executes one model turn. Timeout recovery remains an outer-loop turn: this
 * function decides whether the single retry is allowed and returns its
 * injected message, while AgentRunner owns canonical transcript mutation and
 * turn lifecycle.
 */
export async function executeModelTurn(
  options: ExecuteModelTurnOptions,
): Promise<ModelTurnResult> {
  const timestamp = () => options.now().toISOString();

  try {
    await options.events.emit({
      type: "message.started",
      runId: options.runId,
      messageId: options.messageId,
      role: "assistant",
      at: timestamp(),
    });

    const modelMessages = options.transformContext(options.transcript);
    const toolsForModel = options.forceAnswerOnly ? [] : options.tools;
    const toolChoice = options.forceAnswerOnly
      ? undefined
      : options.toolChoice;
    const contextMessageBytes = measureMessagesBytes(modelMessages);
    const toolCatalogBytes = measureToolCatalogBytes(toolsForModel);
    const modelStartedAt = Date.now();
    const timeout = createTimeoutSignal(options.signal, options.timeoutMs);

    let response: ModelResponse;
    try {
      response = await options.model.complete({
        messages: modelMessages,
        tools: toolsForModel,
        signal: timeout.signal,
        capabilities: options.capabilities,
        ...(toolChoice !== undefined ? { toolChoice } : {}),
        onTextDelta: async (delta) => {
          if (!delta) return;
          await options.events.emit({
            type: "message.delta",
            runId: options.runId,
            messageId: options.messageId,
            role: "assistant",
            delta,
            at: timestamp(),
          });
        },
      });
    } catch (error) {
      if (options.signal.aborted) {
        throw error;
      }
      if (timeout.timedOut) {
        const retryMessage = !options.timeoutRetryUsed
          ? options.getTimeoutRetryMessage?.({
              toolOutcomes: options.toolOutcomes,
            })
          : undefined;
        if (retryMessage) {
          return { status: "retry", retryMessage };
        }
        return {
          status: "failed",
          diagnostic: {
            code: "MODEL_FAILURE",
            severity: "error",
            message: `Model turn exceeded ${options.timeoutMs}ms without completing`,
            details: {
              timeoutMs: options.timeoutMs,
              turnIndex: options.turnIndex,
            },
          },
        };
      }
      throw error;
    } finally {
      timeout.clear();
    }

    const modelWallMs =
      response.meta?.latencyMs ?? elapsedMs(modelStartedAt);
    const toolCalls = options.forceAnswerOnly
      ? []
      : (response.toolCalls ?? []);

    await emitTelemetry(options.events, {
      type: "model.turn.metrics",
      runId: options.runId,
      turnId: options.turnId,
      turnIndex: options.turnIndex,
      at: timestamp(),
      ...(response.meta?.provider !== undefined
        ? { provider: response.meta.provider }
        : {}),
      ...(response.meta?.modelId !== undefined
        ? { modelId: response.meta.modelId }
        : {}),
      modelWallMs,
      ...(response.meta?.timeToFirstTokenMs !== undefined
        ? { timeToFirstTokenMs: response.meta.timeToFirstTokenMs }
        : {}),
      ...(response.meta?.usage?.inputTokens !== undefined
        ? { inputTokens: response.meta.usage.inputTokens }
        : {}),
      ...(response.meta?.usage?.cachedInputTokens !== undefined
        ? { cachedInputTokens: response.meta.usage.cachedInputTokens }
        : {}),
      ...(response.meta?.usage?.outputTokens !== undefined
        ? { outputTokens: response.meta.usage.outputTokens }
        : {}),
      ...(response.meta?.usage?.reasoningTokens !== undefined
        ? { reasoningTokens: response.meta.usage.reasoningTokens }
        : {}),
      toolCallCount: toolCalls.length,
      toolArgumentBytes: measureToolArgumentBytes(toolCalls),
      contextMessageBytes,
      toolCatalogBytes,
      ...(response.meta?.finishReason !== undefined
        ? { finishReason: response.meta.finishReason }
        : {}),
    });

    await options.events.emit({
      type: "message.completed",
      runId: options.runId,
      messageId: options.messageId,
      role: "assistant",
      content: response.content,
      at: timestamp(),
    });

    return {
      status: "completed",
      response,
      toolCalls,
      ...(toolChoice !== undefined ? { toolChoice } : {}),
    };
  } catch (error) {
    if (options.signal.aborted || isAbortError(error)) {
      return { status: "cancelled" };
    }
    return {
      status: "failed",
      diagnostic: toDiagnostic(error, "MODEL_FAILURE", "Model call failed"),
    };
  }
}

async function emitTelemetry(
  events: AgentEventSink,
  event: AgentEvent,
): Promise<void> {
  try {
    await events.emit(event);
  } catch {
    // Observability-only events must not invalidate a successful model call.
  }
}

function createTimeoutSignal(
  parent: AbortSignal,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: boolean; clear: () => void } {
  const controller = new AbortController();
  let timedOut = false;
  const onParentAbort = () => {
    controller.abort();
  };
  if (parent.aborted) {
    controller.abort();
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    get signal() {
      return controller.signal;
    },
    get timedOut() {
      return timedOut;
    },
    clear() {
      clearTimeout(timer);
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

function toDiagnostic(
  error: unknown,
  fallbackCode: Diagnostic["code"],
  fallbackMessage: string,
): Diagnostic {
  if (error instanceof AgentCoreError) {
    return (
      error.diagnostic ?? {
        code: error.code,
        severity: "error",
        message: error.message,
      }
    );
  }
  if (error instanceof Error) {
    return {
      code: fallbackCode,
      severity: "error",
      message: error.message || fallbackMessage,
    };
  }
  return {
    code: fallbackCode,
    severity: "error",
    message: fallbackMessage,
  };
}
