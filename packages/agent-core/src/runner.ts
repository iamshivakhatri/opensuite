import { randomUUID } from "node:crypto";

import {
  denyAllConfirmationGate,
  type ConfirmationGate,
} from "./confirmation.js";
import { AgentCoreError, isAbortError } from "./errors.js";
import {
  noopEventSink,
  type AgentEvent,
  type AgentEventSink,
} from "./events.js";
import {
  requiresConfirmation,
  toolExecutionMode,
  type AgentModel,
  type CreateToolExecutionContext,
  type ModelMessage,
  type ModelToolCall,
} from "./model.js";
import {
  executeModelTurn,
  identityTransformContext,
  type ModelTimeoutContext,
  type TransformAgentContext,
} from "./model-turn-executor.js";
export {
  identityTransformContext,
  type ModelTimeoutContext,
  type TransformAgentContext,
} from "./model-turn-executor.js";
import type {
  AgentRequest,
  AgentResult,
  SteeringMessage,
  ToolOutcome,
} from "./request.js";
import type { SteeringSource } from "./steering.js";
import type { TurnToolSelector } from "./turn-tools.js";
import {
  elapsedMs,
  measureJsonBytes,
} from "./telemetry.js";
import { ToolRegistry } from "./tools.js";
import {
  createCapabilities,
  type Diagnostic,
  type RuntimeCapabilities,
} from "./types.js";

const DEFAULT_MAX_TURNS = 20;
/** Same tool input failing this many times → block further calls and force an answer. */
const MAX_FAILURES_PER_TOOL = 2;
/** Hard cap on a single provider round-trip so chat essays cannot hang the UI for minutes. */
const DEFAULT_MODEL_TURN_TIMEOUT_MS = 90_000;

const REPEATED_FAILURE_STOP_MESSAGE =
  "Runtime policy: stop calling tools. The same tool call already failed twice in this run. " +
  "Summarize what succeeded, what failed (include the error codes if known), and ask the user how to proceed. " +
  "Do not invent workarounds or retry the failed tool.";

const USE_TOOLS_NUDGE_MESSAGE =
  "Runtime policy: you must call one of the available tools before answering.";

export interface ToolBatchContext {
  readonly content: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly toolOutcomes: readonly ToolOutcome[];
  readonly tools: ToolRegistry;
}

/** Domain-owned lifecycle around one assistant response's tool calls. */
export interface ToolTurnLifecycle {
  begin(context: ToolTurnLifecycleContext): Promise<void> | void;
  beforeTool?(context: ToolTurnLifecycleContext & { readonly toolCallId: string; readonly toolName: string }): Promise<void> | void;
  finalize(context: ToolBatchContext & Omit<ToolTurnLifecycleContext, "toolCalls">): Promise<readonly ToolOutcome[]> | readonly ToolOutcome[];
  abandon?(context: ToolTurnLifecycleContext): Promise<void> | void;
}

export interface ToolTurnLifecycleContext {
  readonly runId: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly events: AgentEventSink;
}

export interface AgentRunnerOptions {
  readonly model: AgentModel;
  /** Tool registry used when `selectTurnTools` is omitted (fixed every turn). */
  readonly tools: ToolRegistry;
  /**
   * Injected per-turn tool-selection hook (see `./turn-tools.ts`). AgentRunner
   * calls this once per model turn and sends the returned tools/toolChoice to
   * the model — it does not otherwise know why the tool surface changed.
   * Omit for a fixed `tools` registry every turn (tests / non-document runs).
   */
  readonly selectTurnTools?: TurnToolSelector;
  /**
   * Injected per-tool-execution context boundary (see `CreateToolExecutionContext`
   * in `./model.ts`). AgentRunner calls this fresh before every tool `execute`
   * and passes the result through unchanged — it owns no product runtime
   * state itself.
   * Omit for tools that need no execution context beyond runId/signal/events.
   */
  readonly createToolContext?: CreateToolExecutionContext;
  /**
   * Injected canonical-transcript → model-facing projection. AgentRunner calls
   * this immediately before each `model.complete`; it never interprets the
   * projection. Omit for identity (tests / non-document runs).
   */
  readonly transformContext?: TransformAgentContext;
  /** Decide whether assistant content plus this completed tool batch may finish the run. */
  readonly shouldTerminalizeToolBatch?: (context: ToolBatchContext) => boolean;
  /** Optional domain finalizer, run before completion events and transcript updates. */
  readonly toolTurnLifecycle?: ToolTurnLifecycle;
  /** Return a user message to retry one timed-out model turn, or nothing to fail. */
  readonly getModelTimeoutRetryMessage?: (
    context: ModelTimeoutContext,
  ) => string | undefined;
  /** Message sent once when a required-tools turn returns no tool calls. */
  readonly requiredToolsNudgeMessage?: string;
  readonly events?: AgentEventSink;
  readonly confirmation?: ConfirmationGate;
  readonly steering?: SteeringSource;
  /** Advertised to context; overridden when the turn selector returns capabilities. */
  readonly capabilities?: RuntimeCapabilities;
  /** Hard cap on model turns. Default 20. */
  readonly maxTurns?: number;
  /** Per model.complete wall-time budget in ms. Default 90000. */
  readonly modelTurnTimeoutMs?: number;
  /** Injectable clock for deterministic event timestamps in tests. */
  readonly now?: () => Date;
  /** Injectable id factory for turn/message ids. */
  readonly createId?: () => string;
}

export interface AgentRunOptions {
  readonly signal?: AbortSignal;
}

/**
 * Deterministic model ↔ tool execution loop.
 * Safe tools execute immediately; destructive tools require ConfirmationGate.
 * No gate → destructive tools are denied (dangerous behavior is opt-in).
 * No persistence, HTTP, or engine coupling.
 */
export class AgentRunner {
  private readonly model: AgentModel;
  private readonly tools: ToolRegistry;
  private readonly selectTurnTools: TurnToolSelector;
  private readonly createToolContext: CreateToolExecutionContext;
  private readonly transformContext: TransformAgentContext;
  private readonly shouldTerminalizeToolBatch:
    | ((context: ToolBatchContext) => boolean)
    | undefined;
  private readonly toolTurnLifecycle: ToolTurnLifecycle | undefined;
  private readonly getModelTimeoutRetryMessage:
    | ((context: ModelTimeoutContext) => string | undefined)
    | undefined;
  private readonly requiredToolsNudgeMessage: string;
  private readonly events: AgentEventSink;
  private readonly confirmation: ConfirmationGate;
  private readonly steering: SteeringSource | undefined;
  private readonly capabilities: RuntimeCapabilities;
  private readonly maxTurns: number;
  private readonly modelTurnTimeoutMs: number;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: AgentRunnerOptions) {
    this.model = options.model;
    this.tools = options.tools;
    this.events = options.events ?? noopEventSink;
    this.confirmation = options.confirmation ?? denyAllConfirmationGate;
    this.steering = options.steering;
    this.capabilities = options.capabilities ?? createCapabilities();
    this.selectTurnTools =
      options.selectTurnTools ??
      createFixedTurnToolSelector(this.tools, this.capabilities);
    this.createToolContext = options.createToolContext ?? ((base) => base);
    this.transformContext =
      options.transformContext ?? identityTransformContext;
    this.shouldTerminalizeToolBatch = options.shouldTerminalizeToolBatch;
    this.toolTurnLifecycle = options.toolTurnLifecycle;
    this.getModelTimeoutRetryMessage = options.getModelTimeoutRetryMessage;
    this.requiredToolsNudgeMessage =
      options.requiredToolsNudgeMessage ?? USE_TOOLS_NUDGE_MESSAGE;
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.modelTurnTimeoutMs =
      options.modelTurnTimeoutMs ?? DEFAULT_MODEL_TURN_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  async run(
    request: AgentRequest,
    options: AgentRunOptions = {},
  ): Promise<AgentResult> {
    const signal = options.signal ?? new AbortController().signal;
    const toolOutcomes: ToolOutcome[] = [];
    const diagnostics: Diagnostic[] = [];
    const transcript: ModelMessage[] = [
      ...(request.priorMessages ?? []).map((message) => ({
        role: message.role,
        content: message.content,
      })),
      { role: "user", content: request.instruction },
    ];

    /** Failures per identical tool call in this run (circuit breaker). */
    const toolFailureCounts = new Map<string, number>();
    /**
     * Event/telemetry-sink failures observed AFTER a tool's side effect
     * already completed successfully. These never rewrite the tool's
     * outcome — they fail the run separately once the current turn's
     * successful outcomes/transcript entries are recorded (see Step 5A).
     */
    const infrastructureFailures: Diagnostic[] = [];
    let forceAnswerOnly = false;
    let stopNudgeSent = false;
    let useToolsNudgeSent = false;
    let timeoutRetrySent = false;

    await this.emit({
      type: "agent.started",
      runId: request.runId,
      at: this.timestamp(),
    });

    try {
      this.throwIfAborted(signal);

      let activeTools = this.tools;
      let runCapabilities = this.capabilities;

      for (let turn = 0; turn < this.maxTurns; turn += 1) {
        this.throwIfAborted(signal);

        // Ask the injected selector for this turn's tool surface every turn.
        // AgentRunner does not know why/whether it changed (e.g. capability
        // re-discovery after primary document identity changes) — that is
        // the selector's responsibility (it may memoize internally).
        const selection = await this.selectTurnTools({
          toolOutcomes,
          signal,
        });
        if (selection.status === "failed") {
          diagnostics.push(selection.diagnostic);
          await this.emit({
            type: "agent.failed",
            runId: request.runId,
            diagnostic: selection.diagnostic,
            at: this.timestamp(),
          });
          return {
            status: "failed",
            summary: selection.diagnostic.message,
            diagnostics,
            toolOutcomes: [...toolOutcomes],
          };
        }
        activeTools = selection.registry;
        runCapabilities = selection.capabilities;

        this.applySteering(transcript);

        const turnId = this.createId();
        await this.emit({
          type: "turn.started",
          runId: request.runId,
          turnId,
          at: this.timestamp(),
        });

        const messageId = this.createId();
        const modelTurn = await executeModelTurn({
          model: this.model,
          transformContext: this.transformContext,
          transcript,
          tools: selection.toolsForModel,
          ...(selection.toolChoice !== undefined
            ? { toolChoice: selection.toolChoice }
            : {}),
          capabilities: runCapabilities,
          forceAnswerOnly,
          signal,
          timeoutMs: this.modelTurnTimeoutMs,
          timeoutRetryUsed: timeoutRetrySent,
          ...(this.getModelTimeoutRetryMessage !== undefined
            ? {
                getTimeoutRetryMessage: this.getModelTimeoutRetryMessage,
              }
            : {}),
          toolOutcomes,
          runId: request.runId,
          turnId,
          turnIndex: turn,
          messageId,
          events: this.events,
          now: this.now,
        });

        if (modelTurn.status === "cancelled") {
          return this.cancelled(request.runId, toolOutcomes, diagnostics);
        }
        if (modelTurn.status === "retry") {
          timeoutRetrySent = true;
          transcript.push({
            role: "user",
            content: modelTurn.retryMessage,
          });
          await this.emit({
            type: "turn.completed",
            runId: request.runId,
            turnId,
            at: this.timestamp(),
          });
          continue;
        }
        if (modelTurn.status === "failed") {
          const diagnostic = modelTurn.diagnostic;
          diagnostics.push(diagnostic);
          await this.emit({
            type: "agent.failed",
            runId: request.runId,
            diagnostic,
            at: this.timestamp(),
          });
          return {
            status: "failed",
            summary: diagnostic.message,
            diagnostics,
            toolOutcomes: [...toolOutcomes],
          };
        }

        this.throwIfAborted(signal);

        const { response, toolCalls, toolChoice: turnToolChoice } = modelTurn;
        transcript.push({
          role: "assistant",
          content: response.content,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        });

        // The selector's toolChoice already encodes "tools are required this
        // turn" (see `TurnToolSelection`) — AgentRunner reuses that same
        // signal to decide whether an empty tool-call response needs a nudge,
        // without knowing why tools were required.
        const toolsWereRequired = !forceAnswerOnly && turnToolChoice === "required";

        if (toolCalls.length === 0) {
          if (!useToolsNudgeSent && toolsWereRequired) {
            useToolsNudgeSent = true;
            transcript.push({
              role: "user",
              content: this.requiredToolsNudgeMessage,
            });
            await this.emit({
              type: "turn.completed",
              runId: request.runId,
              turnId,
              at: this.timestamp(),
            });
            continue;
          }

          // Tools were required (e.g. greenfield create-or-edit policy) but
          // the model still answered in chat after a nudge — this happens
          // for plain conversational turns (e.g. "hello") that never implied
          // document work. Degrade to a normal completion instead of hard
          // failing the run; the nudge already gave the model a chance to
          // comply, and there is no document side effect to lose here.

          await this.emit({
            type: "turn.completed",
            runId: request.runId,
            turnId,
            at: this.timestamp(),
          });
          await this.emit({
            type: "agent.completed",
            runId: request.runId,
            at: this.timestamp(),
          });
          return {
            status: "completed",
            summary: response.content,
            diagnostics,
            toolOutcomes: [...toolOutcomes],
          };
        }

        const lifecycleContext = { runId: request.runId, toolCalls, events: this.events };
        await this.toolTurnLifecycle?.begin(lifecycleContext);
        let turnOutcomes: readonly ToolOutcome[];
        try {
          const executed = await this.executeToolCalls(
            toolCalls, request, signal, toolFailureCounts, activeTools,
            infrastructureFailures,
          );
          turnOutcomes = await this.toolTurnLifecycle?.finalize({
            content: response.content, toolCalls, toolOutcomes: executed, tools: activeTools,
            runId: lifecycleContext.runId,
            events: lifecycleContext.events,
          }) ?? executed;
        } catch (error) {
          await this.toolTurnLifecycle?.abandon?.(lifecycleContext);
          throw error;
        }
        if (this.toolTurnLifecycle) {
          await this.emitFinalizedToolOutcomes(
            turnOutcomes, request.runId, infrastructureFailures,
          );
        } else {
          await this.emitFinalizedToolFailures(turnOutcomes, request.runId);
        }
        toolOutcomes.push(...turnOutcomes);

        for (const outcome of turnOutcomes) {
          transcript.push(toolOutcomeToMessage(outcome));
          if (outcome.diagnostic && outcome.status === "failed") {
            diagnostics.push(outcome.diagnostic);
          }
        }

        // A tool already succeeded (its outcome above is authoritative and
        // stays "succeeded") but a required event failed to persist/deliver
        // afterward. Preserve that outcome, but fail the RUN here rather
        // than let the model keep going — it must not be encouraged to
        // retry a mutation that already happened.
        if (infrastructureFailures.length > 0) {
          for (const diagnostic of infrastructureFailures) {
            diagnostics.push(diagnostic);
          }
          const diagnostic = infrastructureFailures[0]!;
          await this.emit({
            type: "agent.failed",
            runId: request.runId,
            diagnostic,
            at: this.timestamp(),
          });
          return {
            status: "failed",
            summary: diagnostic.message,
            diagnostics,
            toolOutcomes: [...toolOutcomes],
          };
        }

        if (
          this.shouldTerminalizeToolBatch?.({
            content: response.content,
            toolCalls,
            toolOutcomes: turnOutcomes,
            tools: activeTools,
          })
        ) {
          await this.emit({
            type: "turn.completed",
            runId: request.runId,
            turnId,
            at: this.timestamp(),
          });
          await this.emit({
            type: "agent.completed",
            runId: request.runId,
            at: this.timestamp(),
          });
          return {
            status: "completed",
            summary: response.content.trim(),
            diagnostics,
            toolOutcomes: [...toolOutcomes],
          };
        }

        const tripped = [...toolFailureCounts.entries()].some(
          ([, count]) => count >= MAX_FAILURES_PER_TOOL,
        );
        if (tripped && !stopNudgeSent) {
          stopNudgeSent = true;
          forceAnswerOnly = true;
          transcript.push({
            role: "user",
            content: REPEATED_FAILURE_STOP_MESSAGE,
          });
        }

        await this.emit({
          type: "turn.completed",
          runId: request.runId,
          turnId,
          at: this.timestamp(),
        });
      }

      const diagnostic: Diagnostic = {
        code: "MAX_TURNS_EXCEEDED",
        severity: "error",
        message: `Agent exceeded maxTurns (${this.maxTurns})`,
        details: { maxTurns: this.maxTurns },
      };
      diagnostics.push(diagnostic);
      await this.emit({
        type: "agent.failed",
        runId: request.runId,
        diagnostic,
        at: this.timestamp(),
      });
      return {
        status: "failed",
        summary: diagnostic.message,
        diagnostics,
        toolOutcomes: [...toolOutcomes],
      };
    } catch (error) {
      if (this.isCancellation(error, signal)) {
        return this.cancelled(request.runId, toolOutcomes, diagnostics);
      }
      const diagnostic = this.toDiagnostic(
        error,
        "RUNTIME_FAILURE",
        "Agent runner failed",
      );
      diagnostics.push(diagnostic);
      await this.emit({
        type: "agent.failed",
        runId: request.runId,
        diagnostic,
        at: this.timestamp(),
      });
      return {
        status: "failed",
        summary: diagnostic.message,
        diagnostics,
        toolOutcomes: [...toolOutcomes],
      };
    }
  }

  private applySteering(transcript: ModelMessage[]): void {
    if (!this.steering) {
      return;
    }
    const messages = this.steering.drain();
    for (const message of messages) {
      transcript.push(steeringToUserMessage(message));
    }
  }

  private async executeToolCalls(
    toolCalls: readonly ModelToolCall[],
    request: AgentRequest,
    signal: AbortSignal,
    toolFailureCounts: Map<string, number>,
    activeTools: ToolRegistry,
    infrastructureFailures: Diagnostic[],
  ): Promise<ToolOutcome[]> {
    const outcomes: ToolOutcome[] = new Array(toolCalls.length);
    let index = 0;

    while (index < toolCalls.length) {
      this.throwIfAborted(signal);
      const call = toolCalls[index]!;

      if (this.isParallelSafeCall(call, activeTools)) {
        let end = index + 1;
        while (
          end < toolCalls.length &&
          this.isParallelSafeCall(toolCalls[end]!, activeTools)
        ) {
          end += 1;
        }
        const batch = toolCalls.slice(index, end);
        const settled = await Promise.all(
          batch.map((item) =>
            this.executeOneToolCall(
              item,
              request,
              signal,
              toolFailureCounts,
              activeTools,
              infrastructureFailures,
            ),
          ),
        );
        for (let offset = 0; offset < settled.length; offset += 1) {
          outcomes[index + offset] = settled[offset]!;
        }
        index = end;
        continue;
      }

      outcomes[index] = await this.executeOneToolCall(
        call,
        request,
        signal,
        toolFailureCounts,
        activeTools,
        infrastructureFailures,
      );
      index += 1;
    }

    return outcomes as ToolOutcome[];
  }

  private isParallelSafeCall(
    call: ModelToolCall,
    activeTools: ToolRegistry,
  ): boolean {
    const tool = activeTools.get(call.name);
    if (!tool) {
      return false;
    }
    if (requiresConfirmation(tool)) {
      return false;
    }
    return toolExecutionMode(tool) === "parallel-safe";
  }

  private async executeOneToolCall(
    call: ModelToolCall,
    request: AgentRequest,
    signal: AbortSignal,
    toolFailureCounts: Map<string, number>,
    activeTools: ToolRegistry,
    infrastructureFailures: Diagnostic[],
  ): Promise<ToolOutcome> {
    this.throwIfAborted(signal);

    await this.toolTurnLifecycle?.beforeTool?.({
      runId: request.runId,
      toolCalls: [call],
      events: this.events,
      toolCallId: call.id,
      toolName: call.name,
    });

    const failureKey = toolFailureKey(call);
    const priorFailures = toolFailureCounts.get(failureKey) ?? 0;
    if (priorFailures >= MAX_FAILURES_PER_TOOL) {
      const diagnostic: Diagnostic = {
        code: "REPEATED_TOOL_FAILURE",
        severity: "error",
        message: `${call.name} already failed ${priorFailures} times in this run; further calls are blocked`,
        details: {
          toolName: call.name,
          failureCount: priorFailures,
        },
      };
      return {
        toolCallId: call.id,
        toolName: call.name,
        status: "skipped",
        summary: diagnostic.message,
        diagnostic,
      };
    }

    const tool = activeTools.get(call.name);
    if (!tool) {
      const diagnostic: Diagnostic = {
        code: "UNKNOWN_TOOL",
        severity: "error",
        message: `Unknown tool: ${call.name}`,
        details: { toolName: call.name },
      };
      return {
        toolCallId: call.id,
        toolName: call.name,
        status: "failed",
        summary: diagnostic.message,
        diagnostic,
      };
    }

    let input: unknown;
    try {
      input = tool.parseInput(call.input);
    } catch (error) {
      const diagnostic = this.toDiagnostic(
        error,
        "INVALID_TOOL_INPUT",
        `Invalid input for tool ${tool.name}`,
      );
      toolFailureCounts.set(
        failureKey,
        (toolFailureCounts.get(failureKey) ?? 0) + 1,
      );
      await this.emitTelemetry({
        type: "tool.execution.metrics",
        runId: request.runId,
        toolCallId: call.id,
        toolName: tool.name,
        at: this.timestamp(),
        wallMs: 0,
        inputBytes: measureJsonBytes(call.input),
        resultBytes: measureJsonBytes(diagnostic),
        success: false,
      });
      return {
        toolCallId: call.id,
        toolName: tool.name,
        status: "failed",
        summary: diagnostic.message,
        diagnostic,
      };
    }

    if (requiresConfirmation(tool)) {
      const reason = `Destructive tool requires confirmation: ${tool.name}`;
      await this.emit({
        type: "confirmation.required",
        runId: request.runId,
        toolCallId: call.id,
        toolName: tool.name,
        reason,
        input,
        at: this.timestamp(),
      });

      let approved = false;
      try {
        approved = await this.confirmation.confirm(
          {
            runId: request.runId,
            toolCallId: call.id,
            toolName: tool.name,
            input,
            reason,
          },
          signal,
        );
      } catch (error) {
        if (this.isCancellation(error, signal)) {
          throw error;
        }
        const diagnostic = this.toDiagnostic(
          error,
          "RUNTIME_FAILURE",
          "Confirmation gate failed",
        );
        return {
          toolCallId: call.id,
          toolName: tool.name,
          status: "failed",
          summary: diagnostic.message,
          diagnostic,
        };
      }

      this.throwIfAborted(signal);

      if (!approved) {
        const diagnostic: Diagnostic = {
          code: "CONFIRMATION_DENIED",
          severity: "warning",
          message: `Confirmation denied for tool ${tool.name}`,
          details: { toolName: tool.name },
        };
        return {
          toolCallId: call.id,
          toolName: tool.name,
          status: "skipped",
          summary: diagnostic.message,
          diagnostic,
        };
      }
    }

    await this.emit({
      type: "tool.started",
      runId: request.runId,
      toolCallId: call.id,
      toolName: tool.name,
      input,
      at: this.timestamp(),
    });

    // Resolved fresh for this one tool call — not frozen at run start — so
    // sequential writes within one assistant response each observe the
    // latest state (e.g. primary document version) left by the prior call.
    // AgentRunner does not interpret the returned context's fields.
    const ctx = this.createToolContext({
      runId: request.runId,
      signal,
      events: this.events,
    });

    const inputBytes = measureJsonBytes(input);
    const toolStartedAt = Date.now();

    // `output` is only assigned once tool.execute() resolves. Anything that
    // happens after that point (event emission, metrics) is observation, not
    // execution — a failure there must never rewrite this into a tool
    // failure (see AgentCore v2 Step 5A: tool success vs event-sink failure).
    let output: unknown;
    try {
      this.throwIfAborted(signal);
      output = await tool.execute(input, ctx);
    } catch (error) {
      if (this.isCancellation(error, signal)) {
        throw error;
      }
      const wallMs = elapsedMs(toolStartedAt);
      const diagnostic = this.toDiagnostic(
        error,
        "TOOL_FAILURE",
        `Tool ${tool.name} failed`,
      );
      toolFailureCounts.set(
        failureKey,
        (toolFailureCounts.get(failureKey) ?? 0) + 1,
      );
      await this.emitTelemetry({
        type: "tool.execution.metrics",
        runId: request.runId,
        toolCallId: call.id,
        toolName: tool.name,
        at: this.timestamp(),
        wallMs,
        inputBytes,
        resultBytes: measureJsonBytes(diagnostic),
        success: false,
      });
      return {
        toolCallId: call.id,
        toolName: tool.name,
        status: "failed",
        summary: diagnostic.message,
        diagnostic,
      };
    }

    // tool.execute() succeeded: the side effect already happened. This
    // outcome is now authoritative for the transcript/model regardless of
    // what happens below.
    const wallMs = elapsedMs(toolStartedAt);
    const summary = summarizeOutput(output);
    const outcome: ToolOutcome = {
      toolCallId: call.id,
      toolName: tool.name,
      status: "succeeded",
      summary,
      output,
    };

    // Existing runs retain immediate completion delivery. A lifecycle user
    // owns deferred delivery so it can finalize every outcome first.
    if (!this.toolTurnLifecycle) {
      try {
        await this.emit({
          type: "tool.completed", runId: request.runId,
          toolCallId: call.id, toolName: tool.name, summary, output,
          at: this.timestamp(),
        });
      } catch (error) {
        infrastructureFailures.push(this.toDiagnostic(
          error, "EVENT_SINK_FAILURE",
          `Failed to record completion of tool ${tool.name}`,
        ));
      }
    }

    await this.emitTelemetry({
      type: "tool.execution.metrics",
      runId: request.runId,
      toolCallId: call.id,
      toolName: tool.name,
      at: this.timestamp(),
      wallMs,
      inputBytes,
      resultBytes: measureJsonBytes(output),
      success: true,
    });

    return outcome;
  }

  private async emitFinalizedToolOutcomes(
    outcomes: readonly ToolOutcome[],
    runId: string,
    infrastructureFailures: Diagnostic[],
  ): Promise<void> {
    for (const outcome of outcomes) {
      if (outcome.status !== "succeeded") {
        await this.emit({
          type: "tool.failed", runId, toolCallId: outcome.toolCallId,
          toolName: outcome.toolName,
          diagnostic: outcome.diagnostic ?? { code: "TOOL_FAILURE", severity: "error", message: outcome.summary ?? "Tool did not complete" },
          at: this.timestamp(),
        });
        continue;
      }
      try {
        await this.emit({
          type: "tool.completed", runId, toolCallId: outcome.toolCallId,
          toolName: outcome.toolName, summary: outcome.summary,
          output: outcome.output, at: this.timestamp(),
        });
      } catch (error) {
        infrastructureFailures.push(this.toDiagnostic(
          error, "EVENT_SINK_FAILURE",
          `Failed to record completion of tool ${outcome.toolName}`,
        ));
      }
    }
  }

  private async emitFinalizedToolFailures(
    outcomes: readonly ToolOutcome[], runId: string,
  ): Promise<void> {
    for (const outcome of outcomes) {
      if (outcome.status === "succeeded") continue;
      await this.emit({
        type: "tool.failed", runId, toolCallId: outcome.toolCallId,
        toolName: outcome.toolName,
        diagnostic: outcome.diagnostic ?? { code: "TOOL_FAILURE", severity: "error", message: outcome.summary ?? "Tool did not complete" },
        at: this.timestamp(),
      });
    }
  }

  private async cancelled(
    runId: string,
    toolOutcomes: readonly ToolOutcome[],
    diagnostics: readonly Diagnostic[],
  ): Promise<AgentResult> {
    await this.emit({
      type: "agent.cancelled",
      runId,
      at: this.timestamp(),
    });
    return {
      status: "cancelled",
      summary: "Agent run cancelled",
      diagnostics: [...diagnostics],
      toolOutcomes: [...toolOutcomes],
    };
  }

  private async emit(event: AgentEvent): Promise<void> {
    await this.events.emit(event);
  }

  /**
   * Observability-only emission (model/tool metrics). These events carry no
   * durability contract — a sink failure here must never invalidate an
   * already-successful model turn or tool execution, so failures are
   * swallowed rather than surfaced as run/tool failures.
   */
  private async emitTelemetry(event: AgentEvent): Promise<void> {
    try {
      await this.events.emit(event);
    } catch {
      // Intentionally ignored — see doc comment above.
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new AgentCoreError("CANCELLED", "Agent run aborted", {
        diagnostic: {
          code: "CANCELLED",
          severity: "error",
          message: "Agent run aborted",
        },
      });
    }
  }

  private isCancellation(error: unknown, signal: AbortSignal): boolean {
    return signal.aborted || isAbortError(error);
  }

  private toDiagnostic(
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
}

function toolOutcomeToMessage(outcome: ToolOutcome): ModelMessage {
  const status =
    outcome.status === "awaiting_confirmation" ? "skipped" : outcome.status;
  return {
    role: "tool",
    toolCallId: outcome.toolCallId,
    toolName: outcome.toolName,
    status,
    summary: outcome.summary,
    output: outcome.output,
    diagnostic: outcome.diagnostic,
  };
}

function steeringToUserMessage(message: SteeringMessage): ModelMessage {
  return {
    role: "user",
    content: message.content,
  };
}

/**
 * Generic default `TurnToolSelector` used when `selectTurnTools` is omitted:
 * the same fixed tool registry and capabilities every turn, no tool-choice
 * constraint. Contains no document/OpenSuite-specific knowledge.
 */
function createFixedTurnToolSelector(
  tools: ToolRegistry,
  capabilities: RuntimeCapabilities,
): TurnToolSelector {
  return async () => ({
    status: "ok",
    registry: tools,
    toolsForModel: tools.definitions(),
    toolChoice: undefined,
    capabilities,
  });
}

function toolFailureKey(call: ModelToolCall): string {
  return `${call.name}:${stableJson(call.input)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function summarizeOutput(output: unknown): string | undefined {
  if (output == null) {
    return undefined;
  }
  if (typeof output === "string") {
    return output;
  }
  if (
    typeof output === "object" &&
    output !== null &&
    "summary" in output &&
    typeof (output as { summary: unknown }).summary === "string"
  ) {
    return (output as { summary: string }).summary;
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}
