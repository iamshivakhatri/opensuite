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
import { isPersistedDocumentMutationToolResult } from "./document-mutation.js";
import { ArtifactHandleRegistry } from "./artifact-handles.js";
import {
  filterDocumentToolsByCapabilities,
} from "./document-tools.js";
import {
  requiresConfirmation,
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

const REPEATED_FAILURE_STOP_MESSAGE =
  "Runtime policy: stop calling tools. The same tool already failed twice in this run. " +
  "Summarize what succeeded, what failed (include the error codes if known), and ask the user how to proceed. " +
  "Do not invent workarounds or retry the failed tool.";


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
   * When set, filtered once at run bootstrap via DocumentRuntime.capabilities
   * against the primary DocumentRef, then merged with `tools`.
   * Omit when `tools` already contains the document tools to expose.
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
  private readonly documentToolCatalog: readonly AgentTool[] | undefined;
  private readonly events: AgentEventSink;
  private readonly runtime: DocumentRuntime | undefined;
  private readonly mutations: DocumentMutationExecutor | undefined;
  private readonly confirmation: ConfirmationGate;
  private readonly steering: SteeringSource | undefined;
  private readonly capabilities: RuntimeCapabilities;
  private readonly maxTurns: number;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: AgentRunnerOptions) {
    this.model = options.model;
    this.tools = options.tools;
    this.documentToolCatalog = options.documentToolCatalog;
    this.events = options.events ?? noopEventSink;
    this.runtime = options.runtime;
    this.mutations = options.mutations;
    this.confirmation = options.confirmation ?? denyAllConfirmationGate;
    this.steering = options.steering;
    this.capabilities = options.capabilities ?? createCapabilities();
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
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

    await this.emit({
      type: "agent.started",
      runId: request.runId,
      at: this.timestamp(),
    });

    try {
      this.throwIfAborted(signal);

      // Capability-driven document tool discovery — once before first model call.
      const bootstrapped = await this.bootstrapTools(
        documentState.primary,
        signal,
      );
      if (bootstrapped.status === "failed") {
        diagnostics.push(bootstrapped.diagnostic);
        await this.emit({
          type: "agent.failed",
          runId: request.runId,
          diagnostic: bootstrapped.diagnostic,
          at: this.timestamp(),
        });
        return {
          status: "failed",
          summary: bootstrapped.diagnostic.message,
          diagnostics,
          toolOutcomes: [...toolOutcomes],
        };
      }
      const activeTools = bootstrapped.tools;
      const runCapabilities = bootstrapped.capabilities;

      for (let turn = 0; turn < this.maxTurns; turn += 1) {
        this.throwIfAborted(signal);
        this.applySteering(transcript);

        const turnId = this.createId();
        await this.emit({
          type: "turn.started",
          runId: request.runId,
          turnId,
          at: this.timestamp(),
        });

        let response;
        const messageId = this.createId();
        try {
          await this.emit({
            type: "message.started",
            runId: request.runId,
            messageId,
            role: "assistant",
            at: this.timestamp(),
          });

          response = await this.model.complete({
            messages: transcript,
            // Empty tools when circuit-broken — model must answer, not keep looping.
            tools: forceAnswerOnly ? [] : activeTools.definitions(),
            signal,
            capabilities: runCapabilities,
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

        if (toolCalls.length === 0) {
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

  /**
   * Resolve model-facing tools once per run.
   * With a documentToolCatalog: DocumentRuntime.capabilities → filter.
   * Without: use injected tools + optional static capabilities as-is.
   */
  private async bootstrapTools(
    primary: DocumentRef | null,
    signal: AbortSignal,
  ): Promise<
    | {
        readonly status: "ok";
        readonly tools: ToolRegistry;
        readonly capabilities: RuntimeCapabilities;
      }
    | { readonly status: "failed"; readonly diagnostic: Diagnostic }
  > {
    this.throwIfAborted(signal);

    if (!this.documentToolCatalog) {
      return {
        status: "ok",
        tools: this.tools,
        capabilities: this.capabilities,
      };
    }

    if (!primary) {
      // No primary document → only tools that need no capability (e.g. none of the catalog).
      const filtered = filterDocumentToolsByCapabilities(
        this.documentToolCatalog,
        createCapabilities(),
      );
      return {
        status: "ok",
        tools: ToolRegistry.create([...this.tools.list(), ...filtered]),
        capabilities: createCapabilities(),
      };
    }

    if (!this.runtime) {
      return {
        status: "failed",
        diagnostic: {
          code: "CAPABILITY_DISCOVERY_FAILED",
          severity: "error",
          message:
            "DocumentRuntime is required to discover document tools for this run",
          details: {
            documentId: primary.documentId,
            versionId: primary.versionId,
            format: primary.format,
          },
        },
      };
    }

    let capabilities: RuntimeCapabilities;
    try {
      capabilities = await this.runtime.capabilities(primary);
    } catch (error) {
      return {
        status: "failed",
        diagnostic: {
          code: "CAPABILITY_DISCOVERY_FAILED",
          severity: "error",
          message: "Failed to discover document runtime capabilities",
          details: {
            documentId: primary.documentId,
            versionId: primary.versionId,
            format: primary.format,
            cause:
              error instanceof Error ? error.message : "unknown discovery error",
          },
        },
      };
    }

    const documentTools = filterDocumentToolsByCapabilities(
      this.documentToolCatalog,
      capabilities,
    );
    return {
      status: "ok",
      tools: ToolRegistry.create([...this.tools.list(), ...documentTools]),
      capabilities,
    };
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

    try {
      this.throwIfAborted(signal);
      const output = await tool.execute(input, ctx);
      if (isPersistedDocumentMutationToolResult(output)) {
        documentState.primary = output.document;
        await this.emit({
          type: "document.version.advanced",
          runId: request.runId,
          documentId: output.document.documentId,
          versionId: output.document.versionId,
          ...(output.versionNumber !== undefined
            ? { versionNumber: output.versionNumber }
            : {}),
          baseVersionId: output.baseVersionId,
          at: this.timestamp(),
        });
      }
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
