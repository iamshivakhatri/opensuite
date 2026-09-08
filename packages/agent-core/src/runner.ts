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
import type { DocumentMutationExecutor } from "./document-mutation.js";
import { ArtifactHandleRegistry } from "./artifact-handles.js";
import { createDocumentTurnToolSelector } from "./document-tools/turn-tool-selector.js";
import { transformContext } from "./model-context.js";
import {
  requiresConfirmation,
  toolEffect,
  toolExecutionMode,
  type AgentModel,
  type AgentTool,
  type ModelMessage,
  type ModelToolCall,
  type ToolExecutionContext,
} from "./model.js";
import type {
  AgentRequest,
  AgentResult,
  SteeringMessage,
  ToolOutcome,
} from "./request.js";
import type { DocumentRuntime } from "./runtime.js";
import type { SteeringSource } from "./steering.js";
import type { TurnToolSelector } from "./turn-tools.js";
import {
  elapsedMs,
  measureJsonBytes,
  measureMessagesBytes,
  measureToolArgumentBytes,
  measureToolCatalogBytes,
} from "./telemetry.js";
import { ToolRegistry } from "./tools.js";
import {
  createCapabilities,
  type Diagnostic,
  type DocumentRef,
  type RuntimeCapabilities,
} from "./types.js";

const DEFAULT_MAX_TURNS = 20;
/** Same tool failing this many times → block further calls and force an answer. */
const MAX_FAILURES_PER_TOOL = 2;
/** Hard cap on a single provider round-trip so chat essays cannot hang the UI for minutes. */
const DEFAULT_MODEL_TURN_TIMEOUT_MS = 90_000;

const REPEATED_FAILURE_STOP_MESSAGE =
  "Runtime policy: stop calling tools. The same tool already failed twice in this run. " +
  "Summarize what succeeded, what failed (include the error codes if known), and ask the user how to proceed. " +
  "Do not invent workarounds or retry the failed tool.";

const USE_TOOLS_NUDGE_MESSAGE =
  "Runtime policy: you must use tools for document work — do not put the document body in chat. " +
  "If the user wants a NEW document, call workspace.create_blank_docx alone first. " +
  "If editing the already-open document, use inspect / set_paragraph_style / mutation tools as needed — do not create another blank file. " +
  "Short confirmation text only after tools succeed.";

const AUTHORING_TIMEOUT_RETRY_MESSAGE =
  "Runtime policy: previous authoring model turn timed out. " +
  "Call tools now with a compact first pass only: document.insert_paragraphs " +
  "(title + short intro), document.set_paragraph_style Heading 1 on the title, " +
  "and one document.create_table with at most 6–8 rows. " +
  "Do not generate a giant single payload.";

/**
 * Blank-document creation tool name. Still referenced here only for the
 * authoring-timeout retry heuristic and write-batch terminalization — both
 * are deferred to a later AgentCore v2 step (not turn-tool selection).
 * Active-tool/tool-choice selection policy (including this same constant)
 * has moved to `document-tools/turn-tool-selector.ts`.
 */
const CREATE_BLANK_TOOL = "workspace.create_blank_docx";


/** Run-scoped mutable pointer to the active primary document version. */
interface RunDocumentState {
  primary: DocumentRef | null;
}

export interface AgentRunnerOptions {
  readonly model: AgentModel;
  /**
   * Non-document / always-on tools, or a fully pre-built registry when
   * `documentToolCatalog` is omitted (tests, fixed injection).
   */
  readonly tools: ToolRegistry;
  /**
   * Injected per-turn tool-selection hook (see `./turn-tools.ts`). AgentRunner
   * calls this once per model turn and sends the returned tools/toolChoice to
   * the model — it does not otherwise know why the tool surface changed.
   * Omit for a fixed `tools` registry every turn (tests / non-document runs).
   */
  readonly selectTurnTools?: TurnToolSelector;
  /**
   * Convenience: when set (and `selectTurnTools` is omitted), the runner
   * builds a document-aware default selector (capability discovery against
   * the primary DocumentRef, merged with `tools`, post-create narrowing,
   * create/write force-tools policy — see `createDocumentTurnToolSelector`).
   * Prefer passing `selectTurnTools` directly for non-OpenSuite consumers.
   */
  readonly documentToolCatalog?: readonly AgentTool[];
  readonly events?: AgentEventSink;
  readonly runtime?: DocumentRuntime;
  /**
   * Application-injected DOCX mutation persistence (engine + append version).
   * Required for document.replace_text to succeed in production.
   */
  readonly mutations?: DocumentMutationExecutor;
  readonly confirmation?: ConfirmationGate;
  readonly steering?: SteeringSource;
  /** Advertised to context; overridden by bootstrap discovery when catalog is set. */
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
  private readonly events: AgentEventSink;
  private readonly runtime: DocumentRuntime | undefined;
  private readonly mutations: DocumentMutationExecutor | undefined;
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
    this.runtime = options.runtime;
    this.mutations = options.mutations;
    this.confirmation = options.confirmation ?? denyAllConfirmationGate;
    this.steering = options.steering;
    this.capabilities = options.capabilities ?? createCapabilities();
    this.selectTurnTools =
      options.selectTurnTools ??
      (options.documentToolCatalog
        ? createDocumentTurnToolSelector({
            baseTools: this.tools,
            documentToolCatalog: options.documentToolCatalog,
            runtime: options.runtime,
          })
        : createFixedTurnToolSelector(this.tools, this.capabilities));
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

    // Run-local active document: advances N → N+1 after persisted mutations.
    // Does not mutate durable historical DocumentRef records.
    const documentState: RunDocumentState = {
      primary: request.primaryDocument ?? null,
    };
    /** Opaque handle → inspected versionId for this run only. */
    const handleRegistry = new ArtifactHandleRegistry();
    /** Failures per tool name in this run (circuit breaker). */
    const toolFailureCounts = new Map<string, number>();
    let forceAnswerOnly = false;
    let stopNudgeSent = false;
    let useToolsNudgeSent = false;
    let authoringTimeoutRetrySent = false;

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
          primaryDocument: documentState.primary,
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

        let response;
        let turnToolChoice: "auto" | "required" | undefined;
        const messageId = this.createId();
        try {
          await this.emit({
            type: "message.started",
            runId: request.runId,
            messageId,
            role: "assistant",
            at: this.timestamp(),
          });

          const modelMessages = transformContext(transcript);
          const toolsForModel = forceAnswerOnly ? [] : selection.toolsForModel;
          const toolChoice = forceAnswerOnly ? undefined : selection.toolChoice;
          turnToolChoice = toolChoice;
          const contextMessageBytes = measureMessagesBytes(modelMessages);
          const toolCatalogBytes = measureToolCatalogBytes(toolsForModel);
          const modelStartedAt = Date.now();

          const timeout = createTimeoutSignal(
            signal,
            this.modelTurnTimeoutMs,
          );
          try {
            response = await this.model.complete({
              messages: modelMessages,
              // Empty tools when circuit-broken — model must answer, not keep looping.
              tools: toolsForModel,
              signal: timeout.signal,
              capabilities: runCapabilities,
              ...(toolChoice !== undefined ? { toolChoice } : {}),
              onTextDelta: async (delta) => {
                if (!delta) return;
                await this.emit({
                  type: "message.delta",
                  runId: request.runId,
                  messageId,
                  role: "assistant",
                  delta,
                  at: this.timestamp(),
                });
              },
            });
          } catch (error) {
            if (signal.aborted) {
              throw error;
            }
            if (timeout.timedOut) {
              // One retry after create when the first authoring turn stalls
              // (common with slow models under tool_choice=required).
              if (
                !authoringTimeoutRetrySent &&
                hasSuccessfulCreate(toolOutcomes) &&
                !hasSuccessfulMutation(toolOutcomes)
              ) {
                authoringTimeoutRetrySent = true;
                transcript.push({
                  role: "user",
                  content: AUTHORING_TIMEOUT_RETRY_MESSAGE,
                });
                await this.emit({
                  type: "turn.completed",
                  runId: request.runId,
                  turnId,
                  at: this.timestamp(),
                });
                continue;
              }
              const diagnostic: Diagnostic = {
                code: "MODEL_FAILURE",
                severity: "error",
                message: `Model turn exceeded ${this.modelTurnTimeoutMs}ms without completing`,
                details: {
                  timeoutMs: this.modelTurnTimeoutMs,
                  turnIndex: turn,
                },
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
            }
            throw error;
          } finally {
            timeout.clear();
          }

          const modelWallMs =
            response.meta?.latencyMs ?? elapsedMs(modelStartedAt);
          const toolCallsForMetrics = forceAnswerOnly
            ? []
            : (response.toolCalls ?? []);
          await this.emit({
            type: "model.turn.metrics",
            runId: request.runId,
            turnId,
            turnIndex: turn,
            at: this.timestamp(),
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
            toolCallCount: toolCallsForMetrics.length,
            toolArgumentBytes: measureToolArgumentBytes(toolCallsForMetrics),
            contextMessageBytes,
            toolCatalogBytes,
            ...(response.meta?.finishReason !== undefined
              ? { finishReason: response.meta.finishReason }
              : {}),
          });

          await this.emit({
            type: "message.completed",
            runId: request.runId,
            messageId,
            role: "assistant",
            content: response.content,
            at: this.timestamp(),
          });
        } catch (error) {
          if (this.isCancellation(error, signal)) {
            return this.cancelled(request.runId, toolOutcomes, diagnostics);
          }
          const diagnostic = this.toDiagnostic(
            error,
            "MODEL_FAILURE",
            "Model call failed",
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

        this.throwIfAborted(signal);

        const toolCalls = forceAnswerOnly
          ? []
          : (response.toolCalls ?? []);
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
              content: USE_TOOLS_NUDGE_MESSAGE,
            });
            await this.emit({
              type: "turn.completed",
              runId: request.runId,
              turnId,
              at: this.timestamp(),
            });
            continue;
          }

          if (toolsWereRequired) {
            const diagnostic: Diagnostic = {
              code: "MODEL_FAILURE",
              severity: "error",
              message:
                "Model finished without calling required tools after a nudge",
              details: { turnIndex: turn },
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
          }

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

        const turnOutcomes = await this.executeToolCalls(
          toolCalls,
          request,
          signal,
          documentState,
          toolFailureCounts,
          activeTools,
          handleRegistry,
        );
        toolOutcomes.push(...turnOutcomes);

        for (const outcome of turnOutcomes) {
          transcript.push(toolOutcomeToMessage(outcome));
          if (outcome.diagnostic && outcome.status === "failed") {
            diagnostics.push(outcome.diagnostic);
          }
        }

        // Write-batch terminalization: content + successful side-effecting tools
        // → finish without another model round. Read-only / failed batches continue.
        if (
          canTerminalizeSuccessfulWriteBatch(
            response.content,
            toolCalls,
            turnOutcomes,
            activeTools,
          )
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
    documentState: RunDocumentState,
    toolFailureCounts: Map<string, number>,
    activeTools: ToolRegistry,
    handleRegistry: ArtifactHandleRegistry,
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
              documentState,
              toolFailureCounts,
              activeTools,
              handleRegistry,
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
        documentState,
        toolFailureCounts,
        activeTools,
        handleRegistry,
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
    documentState: RunDocumentState,
    toolFailureCounts: Map<string, number>,
    activeTools: ToolRegistry,
    handleRegistry: ArtifactHandleRegistry,
  ): Promise<ToolOutcome> {
    this.throwIfAborted(signal);

    const priorFailures = toolFailureCounts.get(call.name) ?? 0;
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
      await this.emit({
        type: "tool.failed",
        runId: request.runId,
        toolCallId: call.id,
        toolName: call.name,
        diagnostic,
        at: this.timestamp(),
      });
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
      await this.emit({
        type: "tool.failed",
        runId: request.runId,
        toolCallId: call.id,
        toolName: call.name,
        diagnostic,
        at: this.timestamp(),
      });
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
        call.name,
        (toolFailureCounts.get(call.name) ?? 0) + 1,
      );
      await this.emit({
        type: "tool.failed",
        runId: request.runId,
        toolCallId: call.id,
        toolName: tool.name,
        diagnostic,
        at: this.timestamp(),
      });
      await this.emit({
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
        await this.emit({
          type: "tool.failed",
          runId: request.runId,
          toolCallId: call.id,
          toolName: tool.name,
          diagnostic,
          at: this.timestamp(),
        });
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
        await this.emit({
          type: "tool.failed",
          runId: request.runId,
          toolCallId: call.id,
          toolName: tool.name,
          diagnostic,
          at: this.timestamp(),
        });
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

    const ctx: ToolExecutionContext = {
      runId: request.runId,
      primaryDocument: documentState.primary,
      signal,
      events: this.events,
      runtime: this.runtime,
      mutations: this.mutations,
      advancePrimaryDocument: (document) => {
        documentState.primary = document;
      },
      handles: handleRegistry,
    };

    const inputBytes = measureJsonBytes(input);
    const toolStartedAt = Date.now();

    try {
      this.throwIfAborted(signal);
      const output = await tool.execute(input, ctx);
      const wallMs = elapsedMs(toolStartedAt);
      const summary = summarizeOutput(output);
      await this.emit({
        type: "tool.completed",
        runId: request.runId,
        toolCallId: call.id,
        toolName: tool.name,
        summary,
        output,
        at: this.timestamp(),
      });
      await this.emit({
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
      return {
        toolCallId: call.id,
        toolName: tool.name,
        status: "succeeded",
        summary,
        output,
      };
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
        call.name,
        (toolFailureCounts.get(call.name) ?? 0) + 1,
      );
      await this.emit({
        type: "tool.failed",
        runId: request.runId,
        toolCallId: call.id,
        toolName: tool.name,
        diagnostic,
        at: this.timestamp(),
      });
      await this.emit({
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

function isDocumentWriteTool(name: string): boolean {
  if (!name.startsWith("document.")) return false;
  return (
    name !== "document.inspect" &&
    name !== "document.find" &&
    name !== "document.capabilities"
  );
}

function hasSuccessfulCreate(
  outcomes: readonly ToolOutcome[],
): boolean {
  return outcomes.some(
    (o) => o.status === "succeeded" && o.toolName === CREATE_BLANK_TOOL,
  );
}

function hasSuccessfulMutation(
  outcomes: readonly ToolOutcome[],
): boolean {
  return outcomes.some(
    (o) => o.status === "succeeded" && isDocumentWriteTool(o.toolName),
  );
}

/**
 * Finish the run when the model already supplied a short confirmation alongside
 * a fully successful document-write batch (no extra final-answer model turn).
 * Create-only and read-only batches never terminalize.
 *
 * Content must look like a user-facing completion (not a stub like "ok") so
 * intermediate write turns with placeholder text continue the loop.
 */
function canTerminalizeSuccessfulWriteBatch(
  content: string,
  toolCalls: readonly ModelToolCall[],
  outcomes: readonly ToolOutcome[],
  tools: ToolRegistry,
): boolean {
  const trimmed = content.trim();
  if (!trimmed || trimmed.length < 12) return false;
  if (toolCalls.length === 0 || outcomes.length !== toolCalls.length) {
    return false;
  }
  if (outcomes.some((o) => o.status !== "succeeded")) {
    return false;
  }
  if (outcomes.some((o) => o.status === "awaiting_confirmation")) {
    return false;
  }
  if (outcomes.some((o) => o.diagnostic?.severity === "error")) {
    return false;
  }

  let hasDocumentWrite = false;
  for (const call of toolCalls) {
    if (isDocumentWriteTool(call.name)) {
      hasDocumentWrite = true;
      continue;
    }
    // Generic write tools (non-create) may terminalize; blank create alone must not.
    if (call.name === CREATE_BLANK_TOOL) continue;
    const tool = tools.get(call.name);
    if (tool && toolEffect(tool) === "write") {
      hasDocumentWrite = true;
    }
  }
  return hasDocumentWrite;
}

/**
 * Generic default `TurnToolSelector` used when neither `selectTurnTools` nor
 * `documentToolCatalog` is supplied: the same fixed tool registry and
 * capabilities every turn, no tool-choice constraint. Contains no
 * document/OpenSuite-specific knowledge.
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
