import type { AgentEventSink } from "./events.js";
import type { AgentMessage } from "./request.js";
import type { DocumentRuntime } from "./runtime.js";
import type { DocumentRef } from "./types.js";

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
 * One tool invocation requested by the model. Multiple may appear in a turn
 * (parallel scheduling policy is deferred).
 */
export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ModelRequest {
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly signal?: AbortSignal;
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
 * Generic agent tool. Stable names should eventually be namespaced
 * (`document.inspect`, `slides.create_slide`, …) — concrete tools deferred.
 */
export interface AgentTool<TInput = unknown, TResult = unknown> {
  readonly name: string;
  readonly description: string;
  readonly risk: ToolRisk;
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

export function toModelToolDefinition(
  tool: Pick<AgentTool, "name" | "description" | "inputSchema">,
): ModelToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}
