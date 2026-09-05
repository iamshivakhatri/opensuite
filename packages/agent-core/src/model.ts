import type { AgentEventSink } from "./events.js";
import type { DocumentRuntime } from "./runtime.js";
import type { Diagnostic, DocumentRef, RuntimeCapabilities } from "./types.js";

/**
 * JSON-Schema-shaped description of tool input for models.
 * Kept opaque — agent-core does not depend on a schema library yet.
 */
export type ToolInputSchema = Record<string, unknown>;

/**
 * Tool definition projected to the model boundary (no execute method).
 */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ToolInputSchema;
}

/**
 * One tool invocation requested by the model. Multiple may appear in a turn.
 */
export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * Provider-neutral model transcript.
 * Broader than persisted DB `agent_message` (user|assistant only) — includes
 * tool-call requests and tool results for the next model turn.
 * Not OpenAI/Anthropic raw message shapes.
 */
export type ModelMessage =
  | {
      readonly role: "user";
      readonly content: string;
    }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly ModelToolCall[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status: "succeeded" | "failed" | "skipped";
      readonly summary?: string;
      readonly output?: unknown;
      readonly diagnostic?: Diagnostic;
    };

export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly signal?: AbortSignal;
  /** Optional runtime capabilities for model/prompt adapters. */
  readonly capabilities?: RuntimeCapabilities;
  /**
   * When set, streaming-capable adapters should invoke this with text chunks
   * as they arrive. Non-streaming adapters may ignore it and return the full
   * completion normally.
   */
  readonly onTextDelta?: (delta: string) => void | Promise<void>;
}

/**
 * Model completion. `toolCalls` may be empty, one, or many.
 */
export interface ModelResponse {
  readonly content: string;
  readonly toolCalls: readonly ModelToolCall[];
}

/**
 * Provider-independent model boundary.
 * Implementations: Anthropic/OpenAI wrappers, FakeAgentModel for tests.
 * Agent-core must not import provider SDKs.
 */
export interface AgentModel {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * Context passed to tool `execute`. Explicit deps only — not a service locator.
 */
export interface ToolExecutionContext {
  readonly runId: string;
  readonly primaryDocument: DocumentRef | null;
  readonly signal: AbortSignal;
  readonly events: AgentEventSink;
  /** Present when the tool needs document inspect/mutate capabilities. */
  readonly runtime?: DocumentRuntime;
}

/**
 * Execution risk for confirmation policy. Destructive tools require
 * confirmation before execute; safe tools run immediately.
 */
export type ToolRisk = "safe" | "destructive";

/**
 * Side-effect class for tools. Writes default to sequential execution.
 */
export type ToolEffect = "read" | "write";

/**
 * Conservative concurrency hint for tools within a single model turn.
 * - sequential (default): barrier — never auto-parallelized
 * - parallel-safe: may run concurrently with other parallel-safe calls
 */
export type ToolExecutionMode = "sequential" | "parallel-safe";

/**
 * Generic agent tool. Stable names should eventually be namespaced
 * (`document.inspect`, `slides.create_slide`, …) — concrete tools deferred.
 */
export interface AgentTool<TInput = unknown, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
  /** Defaults to `read`. Write tools should use sequential execution. */
  readonly effect?: ToolEffect;
  /** Defaults to `sequential` when omitted (and for write effects). */
  readonly executionMode?: ToolExecutionMode;
  readonly inputSchema: ToolInputSchema;
  /**
   * Validate/coerce raw model input into typed input.
   * Throw AgentCoreError(INVALID_TOOL_INPUT) on failure.
   */
  parseInput(raw: unknown): TInput;
  execute(input: TInput, ctx: ToolExecutionContext): Promise<TResult>;
}

export function requiresConfirmation(tool: Pick<AgentTool, "risk">): boolean {
  return tool.risk === "destructive";
}

export function toolEffect(tool: Pick<AgentTool, "effect">): ToolEffect {
  return tool.effect ?? "read";
}

export function toolExecutionMode(
  tool: Pick<AgentTool, "executionMode" | "effect">,
): ToolExecutionMode {
  if (tool.executionMode) {
    return tool.executionMode;
  }
  // Writes default to sequential so concurrent edits cannot race a working copy.
  if (toolEffect(tool) === "write") {
    return "sequential";
  }
  return "sequential";
}

export function toModelToolDefinition(
  tool: Pick<AgentTool, "name" | "description" | "inputSchema">,
): ModelToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}
