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
import type { ToolRegistry } from "./tools.js";
import {
  createCapabilities,
  type Diagnostic,
  type RuntimeCapabilities,
} from "./types.js";

const DEFAULT_MAX_TURNS = 20;

export interface AgentRunnerOptions {
  readonly model: AgentModel;
  readonly tools: ToolRegistry;
  readonly events?: AgentEventSink;
  readonly runtime?: DocumentRuntime;
  readonly confirmation?: ConfirmationGate;
  readonly steering?: SteeringSource;
  /** Advertised to context; tools decide how to use DocumentRuntime. */
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
  private readonly events: AgentEventSink;
  private readonly runtime: DocumentRuntime | undefined;
  private readonly confirmation: ConfirmationGate;
  private readonly steering: SteeringSource | undefined;
  private readonly capabilities: RuntimeCapabilities;
  private readonly maxTurns: number;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(options: AgentRunnerOptions) {
    this.model = options.model;
    this.tools = options.tools;
    this.events = options.events ?? noopEventSink;
    this.runtime = options.runtime;
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

    await this.emit({
      type: "agent.started",
      runId: request.runId,
      at: this.timestamp(),
    });

    try {
      this.throwIfAborted(signal);

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
        try {
          response = await this.model.complete({
            messages: transcript,
            tools: this.tools.definitions(),
            signal,
            capabilities: this.capabilities,
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

        const toolCalls = response.toolCalls ?? [];
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
        );
        toolOutcomes.push(...turnOutcomes);

        for (const outcome of turnOutcomes) {
          transcript.push(toolOutcomeToMessage(outcome));
          if (outcome.diagnostic && outcome.status === "failed") {
            diagnostics.push(outcome.diagnostic);
          }
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
  ): Promise<ToolOutcome[]> {
    const outcomes: ToolOutcome[] = new Array(toolCalls.length);
    let index = 0;

    while (index < toolCalls.length) {
      this.throwIfAborted(signal);
      const call = toolCalls[index]!;

      if (this.isParallelSafeCall(call)) {
        let end = index + 1;
        while (
          end < toolCalls.length &&
          this.isParallelSafeCall(toolCalls[end]!)
        ) {
          end += 1;
        }
        const batch = toolCalls.slice(index, end);
        const settled = await Promise.all(
          batch.map((item) => this.executeOneToolCall(item, request, signal)),
        );
        for (let offset = 0; offset < settled.length; offset += 1) {
          outcomes[index + offset] = settled[offset]!;
        }
        index = end;
        continue;
      }

      outcomes[index] = await this.executeOneToolCall(call, request, signal);
      index += 1;
    }

    return outcomes as ToolOutcome[];
  }

  private isParallelSafeCall(call: ModelToolCall): boolean {
    const tool = this.tools.get(call.name);
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
  ): Promise<ToolOutcome> {
    this.throwIfAborted(signal);

    const tool = this.tools.get(call.name);
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
      primaryDocument: request.primaryDocument ?? null,
      signal,
      events: this.events,
      runtime: this.runtime,
    };

    try {
      this.throwIfAborted(signal);
      const output = await tool.execute(input, ctx);
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
