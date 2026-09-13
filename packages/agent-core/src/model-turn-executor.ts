import {
  agentDebugLifecycle,
  summarizeDebugError,
  watchAbortSignal,
} from "./debug-lifecycle.js";
import { AgentCoreError, isAbortError } from "./errors.js";
import type { AgentEvent, AgentEventSink } from "./events.js";
import type {
  AgentModel,
  ModelActivityKind,
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

/** Why a model-turn liveness abort fired (never user/external cancel). */
export type ModelTurnTimeoutSource = "startup" | "idle" | "hard";

export interface ExecuteModelTurnOptions {
  readonly model: AgentModel;
  readonly transformContext: TransformAgentContext;
  readonly transcript: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly toolChoice?: "auto" | "required";
  readonly capabilities: RuntimeCapabilities;
  readonly forceAnswerOnly: boolean;
  readonly signal: AbortSignal;
  /**
   * Startup + stream-idle budget (ms). Compatibility: historically a single
   * wall-clock model-turn timeout; now interpreted as first-activity and
   * between-activity liveness, not total stream duration.
   */
  readonly timeoutMs: number;
  /**
   * Absolute hard ceiling for one model turn (ms). Defaults to 10× timeoutMs.
   * Final fuse for pathological endless trickle; healthy streams should finish
   * well under this.
   */
  readonly hardTimeoutMs?: number;
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
  const hardTimeoutMs =
    options.hardTimeoutMs ?? defaultHardTimeoutMs(options.timeoutMs);

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
    const timeout = createActivityAwareTimeout(options.signal, {
      startupTimeoutMs: options.timeoutMs,
      idleTimeoutMs: options.timeoutMs,
      hardTimeoutMs,
      debugFields: {
        run: options.runId,
        turn: options.turnIndex,
      },
    });

    // TEMP: agent lifecycle diagnosis
    agentDebugLifecycle("MODEL_START", {
      run: options.runId,
      turn: options.turnIndex,
      turnId: options.turnId.slice(0, 8),
      toolCount: toolsForModel.length,
      contextBytes: contextMessageBytes,
      catalogBytes: toolCatalogBytes,
      abort: options.signal.aborted,
      modelTurnTimeoutMs: options.timeoutMs,
      modelTurnHardTimeoutMs: hardTimeoutMs,
      timeoutRetryUsed: options.timeoutRetryUsed,
      forceAnswerOnly: options.forceAnswerOnly,
    });
    watchAbortSignal(options.signal, "run-controller", {
      run: options.runId,
      turn: options.turnIndex,
    });
    // Combined timeout.signal is watched via createActivityAwareTimeout
    // (source=model-turn-timeout-*) — do not attach here or parent aborts
    // would be mis-attributed.

    let response: ModelResponse;
    try {
      response = await options.model.complete({
        messages: modelMessages,
        tools: toolsForModel,
        signal: timeout.signal,
        capabilities: options.capabilities,
        ...(toolChoice !== undefined ? { toolChoice } : {}),
        onModelActivity: (kind) => {
          timeout.onActivity(kind);
        },
        onTextDelta: async (delta) => {
          if (!delta) return;
          // Text is always meaningful activity (even if adapter forgot to report).
          timeout.onActivity("text_delta");
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
      const modelElapsedMs = Date.now() - modelStartedAt;
      const liveness = timeout.snapshot(modelStartedAt);
      if (options.signal.aborted) {
        // TEMP: agent lifecycle diagnosis
        agentDebugLifecycle("MODEL_ABORT", {
          run: options.runId,
          turn: options.turnIndex,
          modelElapsedMs,
          source: "run-controller",
          timeoutSource: "external",
          ...liveness,
          ...summarizeDebugError(error),
        });
        throw error;
      }
      if (timeout.timedOut && timeout.timeoutSource) {
        const source = timeout.timeoutSource;
        // Safe outer-loop retry only before any visible assistant text escaped.
        const retryMessage =
          !options.timeoutRetryUsed && !liveness.visibleTextEmitted
            ? options.getTimeoutRetryMessage?.({
                toolOutcomes: options.toolOutcomes,
              })
            : undefined;
        // TEMP: agent lifecycle diagnosis
        agentDebugLifecycle(
          retryMessage ? "MODEL_TIMEOUT_RETRY" : "MODEL_TIMEOUT",
          {
            run: options.runId,
            turn: options.turnIndex,
            modelElapsedMs,
            timeoutSource: source,
            timeoutMs: options.timeoutMs,
            hardTimeoutMs,
            ...liveness,
            ...summarizeDebugError(error),
          },
        );
        if (retryMessage) {
          return { status: "retry", retryMessage };
        }
        return {
          status: "failed",
          diagnostic: {
            code: "MODEL_FAILURE",
            severity: "error",
            message: timeoutFailureMessage(source, {
              timeoutMs: options.timeoutMs,
              hardTimeoutMs,
            }),
            details: {
              timeoutSource: source,
              timeoutMs: options.timeoutMs,
              hardTimeoutMs,
              turnIndex: options.turnIndex,
              sawFirstMeaningfulActivity: liveness.sawFirstMeaningfulActivity,
              visibleTextEmitted: liveness.visibleTextEmitted,
              toolCallActivitySeen: liveness.toolCallActivitySeen,
            },
          },
        };
      }
      // TEMP: agent lifecycle diagnosis
      agentDebugLifecycle("MODEL_ERROR", {
        run: options.runId,
        turn: options.turnIndex,
        modelElapsedMs,
        ...liveness,
        ...summarizeDebugError(error),
      });
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

    // TEMP: agent lifecycle diagnosis
    agentDebugLifecycle("MODEL_SUCCESS", {
      run: options.runId,
      turn: options.turnIndex,
      modelElapsedMs: modelWallMs,
      toolCalls: toolCalls.length,
      contentChars: response.content.length,
      finishReason: response.meta?.finishReason,
      provider: response.meta?.provider,
      modelId: response.meta?.modelId,
      ...timeout.snapshot(modelStartedAt),
    });

    return {
      status: "completed",
      response,
      toolCalls,
      ...(toolChoice !== undefined ? { toolChoice } : {}),
    };
  } catch (error) {
    if (options.signal.aborted || isAbortError(error)) {
      // TEMP: agent lifecycle diagnosis
      agentDebugLifecycle("MODEL_ABORT", {
        run: options.runId,
        turn: options.turnIndex,
        source: "outer-catch",
        timeoutSource: "external",
        ...summarizeDebugError(error),
      });
      return { status: "cancelled" };
    }
    // TEMP: agent lifecycle diagnosis
    agentDebugLifecycle("MODEL_ERROR", {
      run: options.runId,
      turn: options.turnIndex,
      source: "outer-catch",
      ...summarizeDebugError(error),
    });
    return {
      status: "failed",
      diagnostic: toDiagnostic(error, "MODEL_FAILURE", "Model call failed"),
    };
  }
}

/** Default hard ceiling: 10× the startup/idle budget (90s → 15m). */
export function defaultHardTimeoutMs(timeoutMs: number): number {
  return timeoutMs * 10;
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

interface ActivityTimeoutOptions {
  readonly startupTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly hardTimeoutMs: number;
  readonly debugFields?: Record<string, unknown>;
}

interface ActivityTimeoutSnapshot {
  readonly sawFirstMeaningfulActivity: boolean;
  readonly timeToFirstActivityMs: number | undefined;
  readonly lastActivityElapsedMs: number | undefined;
  readonly lastActivityKind: ModelActivityKind | undefined;
  readonly idleDurationMs: number | undefined;
  readonly visibleTextEmitted: boolean;
  readonly toolCallActivitySeen: boolean;
}

function createActivityAwareTimeout(
  parent: AbortSignal,
  options: ActivityTimeoutOptions,
): {
  signal: AbortSignal;
  timedOut: boolean;
  timeoutSource: ModelTurnTimeoutSource | undefined;
  onActivity: (kind: ModelActivityKind) => void;
  snapshot: (modelStartedAt: number) => ActivityTimeoutSnapshot;
  clear: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutSource: ModelTurnTimeoutSource | undefined;
  let sawFirstMeaningfulActivity = false;
  let firstActivityAt: number | undefined;
  let lastActivityAt: number | undefined;
  let lastActivityKind: ModelActivityKind | undefined;
  let visibleTextEmitted = false;
  let toolCallActivitySeen = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const onParentAbort = () => {
    // Parent (run-controller) fired first — do not mark as model-turn timeout.
    controller.abort();
  };
  if (parent.aborted) {
    controller.abort();
  } else {
    parent.addEventListener("abort", onParentAbort, { once: true });
  }

  const fireTimeout = (source: ModelTurnTimeoutSource) => {
    if (timedOut || parent.aborted || controller.signal.aborted) {
      return;
    }
    timedOut = true;
    timeoutSource = source;
    const now = Date.now();
    // TEMP: agent lifecycle diagnosis
    agentDebugLifecycle("ABORT", {
      source: `model-turn-timeout-${source}`,
      timeoutSource: source,
      startupMs: options.startupTimeoutMs,
      idleMs: options.idleTimeoutMs,
      hardMs: options.hardTimeoutMs,
      sawFirst: sawFirstMeaningfulActivity,
      lastKind: lastActivityKind,
      idleForMs:
        lastActivityAt !== undefined ? now - lastActivityAt : undefined,
      visibleText: visibleTextEmitted,
      toolStream: toolCallActivitySeen,
      ...options.debugFields,
    });
    controller.abort(
      Object.assign(new Error(`model-turn-timeout:${source}`), {
        name: "TimeoutError",
        timeoutSource: source,
      }),
    );
  };

  const startupTimer = setTimeout(() => {
    if (!sawFirstMeaningfulActivity) {
      fireTimeout("startup");
    }
  }, options.startupTimeoutMs);

  const hardTimer = setTimeout(() => {
    fireTimeout("hard");
  }, options.hardTimeoutMs);

  const armIdleTimer = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      fireTimeout("idle");
    }, options.idleTimeoutMs);
  };

  return {
    get signal() {
      return controller.signal;
    },
    get timedOut() {
      return timedOut;
    },
    get timeoutSource() {
      return timeoutSource;
    },
    onActivity(kind: ModelActivityKind) {
      if (timedOut || parent.aborted || controller.signal.aborted) {
        return;
      }
      const now = Date.now();
      if (!sawFirstMeaningfulActivity) {
        sawFirstMeaningfulActivity = true;
        firstActivityAt = now;
        clearTimeout(startupTimer);
      }
      lastActivityAt = now;
      lastActivityKind = kind;
      if (kind === "text_delta") {
        visibleTextEmitted = true;
      }
      if (
        kind === "tool_call_start" ||
        kind === "tool_call_name_delta" ||
        kind === "tool_call_arguments_delta"
      ) {
        toolCallActivitySeen = true;
      }
      armIdleTimer();
    },
    snapshot(modelStartedAt: number): ActivityTimeoutSnapshot {
      const now = Date.now();
      return {
        sawFirstMeaningfulActivity,
        timeToFirstActivityMs:
          firstActivityAt !== undefined
            ? firstActivityAt - modelStartedAt
            : undefined,
        lastActivityElapsedMs:
          lastActivityAt !== undefined
            ? lastActivityAt - modelStartedAt
            : undefined,
        lastActivityKind,
        idleDurationMs:
          lastActivityAt !== undefined ? now - lastActivityAt : undefined,
        visibleTextEmitted,
        toolCallActivitySeen,
      };
    },
    clear() {
      clearTimeout(startupTimer);
      clearTimeout(hardTimer);
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      parent.removeEventListener("abort", onParentAbort);
    },
  };
}

function timeoutFailureMessage(
  source: ModelTurnTimeoutSource,
  budgets: { timeoutMs: number; hardTimeoutMs: number },
): string {
  switch (source) {
    case "startup":
      return `Model turn startup timeout: no model activity within ${budgets.timeoutMs}ms`;
    case "idle":
      return `Model turn idle timeout: no model activity for ${budgets.timeoutMs}ms`;
    case "hard":
      return `Model turn exceeded hard ceiling of ${budgets.hardTimeoutMs}ms`;
  }
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
