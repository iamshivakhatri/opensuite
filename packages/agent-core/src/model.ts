import type { DocumentMutationExecutor } from "./document-mutation.js";
import type { AgentEventSink } from "./events.js";
import type { ArtifactHandleRegistry } from "./artifact-handles.js";
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
   * Provider tool_choice hint. `required` forces at least one tool call when
   * tools are present (adapters that support it). Default: auto.
   */
  readonly toolChoice?: "auto" | "required";
  /**
   * When set, streaming-capable adapters should invoke this with text chunks
   * as they arrive. Non-streaming adapters may ignore it and return the full
   * completion normally.
   */
  readonly onTextDelta?: (delta: string) => void | Promise<void>;
}

/**
 * Provider-neutral token usage. Only include fields the provider actually returned —
 * never fabricate counts.
 */
export interface ModelTokenUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
}

/**
 * Optional adapter-reported metadata for run observability.
 * AgentRunner must stay provider-neutral; adapters attach what they know.
 */
export interface ModelResponseMeta {
  readonly provider?: string;
  readonly modelId?: string;
  readonly finishReason?: string;
  readonly usage?: ModelTokenUsage;
  /**
   * Provider-reported USD charge for this request when available
   * (e.g. OpenRouter `usage.cost` — total account charge).
   * Prefer decimal string; number is accepted. Never invent from catalog pricing.
   */
  readonly providerReportedCostUsd?: string | number;
  /** Wall time inside the adapter for the provider round-trip, ms. */
  readonly latencyMs?: number;
  /** Time to first streamed text/tool token when available, ms. */
  readonly timeToFirstTokenMs?: number;
}

/**
 * Model completion. `toolCalls` may be empty, one, or many.
 */
export interface ModelResponse {
  readonly content: string;
  readonly toolCalls: readonly ModelToolCall[];
  readonly meta?: ModelResponseMeta;
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
  /**
   * Present when a caller-owned document run state supplies one (see
   * `CreateToolExecutionContext`). Absent/null are both "no primary" —
   * AgentRunner itself never sets this field.
   */
  readonly primaryDocument?: DocumentRef | null;
  readonly signal: AbortSignal;
  readonly events: AgentEventSink;
  /** Present when the tool needs document inspect/mutate capabilities. */
  readonly runtime?: DocumentRuntime;
  /**
   * Application-injected persistence for DOCX replace_text.
   * When present, document.replace_text must use this — not runtime.execute alone.
   */
  readonly mutations?: DocumentMutationExecutor;
  /**
   * Run-local: advance the active primary DocumentRef after a persisted mutation
   * so subsequent tools in the same run read version N+1.
   */
  readonly advancePrimaryDocument?: (document: DocumentRef) => void;
  /**
   * Run-local opaque handle → inspected version registry.
   * Populated by document.inspect; validated before handle-based mutations.
   */
  readonly handles?: ArtifactHandleRegistry;
}

/**
 * Per-tool-execution context boundary. `AgentRunner` calls this once before
 * each tool `execute` and passes the result through unchanged — it does not
 * construct `ToolExecutionContext` itself and does not interpret any of its
 * fields. The caller (e.g. OpenSuite's document run state) closes over
 * whatever run-local state (primary document, handle registry, runtime,
 * mutation executor, …) it needs to resolve `primaryDocument`/`handles`/etc.
 * fresh on every call, so sequential writes within one turn observe the
 * latest state. Omit for runs with no such state (generic tools only).
 */
export type CreateToolExecutionContext = (base: {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly events: AgentEventSink;
}) => ToolExecutionContext;

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
  /**
   * Runtime capability id required for model-facing discovery.
   * When set, bootstrap filters this tool against DocumentRuntime.capabilities.
   * Omitted → always eligible (rare; prefer explicit capability gating).
   */
  readonly requireCapability?: string;
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
