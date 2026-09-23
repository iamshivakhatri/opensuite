import {
  jsonSchema,
  tool as aiTool,
  type LanguageModel,
  type ModelMessage,
  type Tool,
} from "ai";

import type { AgentRunMetrics, NowFn } from "./run-metrics.js";

export type { ModelMessage, ToolSet } from "ai";
export type V3Model = LanguageModel;

/** The schema shape `jsonSchema<T>()` produces; also what the AI SDK `tool()` accepts. */
export type InputSchema<T> = ReturnType<typeof jsonSchema<T>>;

/**
 * Generic tool trait. The runtime uses this — never a tool-name prefix — to
 * decide concurrency and failure containment.
 *
 * - "read":   side-effect-free enough to run concurrently with sibling reads.
 * - "mutate": shares mutable external state with sibling mutations; runs
 *             sequentially, and a failure short-circuits later mutations.
 */
export type ToolKind = "read" | "mutate";

/**
 * A runtime tool = an AI SDK tool plus two generic traits.
 * The runtime knows nothing about what the tool does.
 */
export type AgentTool = Tool & {
  readonly kind: ToolKind;
  /**
   * Calling this tool ends the run without another model turn (a "finish"
   * signal). If its execute returns a string, that becomes the run's final
   * text. Honoured only when no mutation failed in the same batch.
   */
  readonly terminal?: boolean;
};

export type AgentToolSet = Record<string, AgentTool>;

export interface DefineToolSpec<Input, Output> {
  readonly kind: ToolKind;
  readonly description: string;
  // Use `jsonSchema<T>(...)` from "ai".
  readonly inputSchema: InputSchema<Input>;
  readonly terminal?: boolean;
  execute(
    input: Input,
    ctx: {
      readonly toolCallId: string;
      readonly messages: readonly ModelMessage[];
      readonly abortSignal?: AbortSignal;
    },
  ): Output | Promise<Output>;
}

/**
 * Build a runtime tool. Thin wrapper over the AI SDK `tool()` that attaches the
 * generic `kind`/`terminal` traits the loop reasons about.
 */
export function defineTool<Input, Output>(
  spec: DefineToolSpec<Input, Output>,
): AgentTool {
  const { kind, terminal, description, inputSchema, execute } = spec;
  const base = aiTool({
    description,
    inputSchema,
    execute: execute as never,
  }) as Tool;
  return Object.assign(base, {
    kind,
    ...(terminal !== undefined ? { terminal } : {}),
  }) as AgentTool;
}

/** Why a tool call was not executed. */
export type ToolSkipReason = "PRIOR_MUTATION_FAILED" | "FUSE_TRIPPED";

/** Generic run events. No product/document vocabulary. */
export type AgentEvent =
  | { readonly type: "started" }
  | { readonly type: "text_delta"; readonly delta: string }
  | { readonly type: "tool_started"; readonly toolCallId: string; readonly toolName: string }
  | { readonly type: "tool_completed"; readonly toolCallId: string; readonly toolName: string }
  | {
      readonly type: "tool_failed";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly error: string;
    }
  | {
      readonly type: "tool_skipped";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly reason: ToolSkipReason;
    }
  | { readonly type: "completed"; readonly text: string; readonly stopReason: StopReason }
  | { readonly type: "cancelled" };

/**
 * How a run ended.
 * - "completed":   model produced a turn with no tool calls.
 * - "finish_tool": model called a terminal tool.
 * - "max_turns":   turn budget exhausted (result is likely incomplete).
 * - "deadline":    wall-clock budget exhausted (result is likely incomplete).
 */
export type StopReason = "completed" | "finish_tool" | "max_turns" | "deadline";

export function isSuccessfulStop(reason: StopReason): boolean {
  return reason === "completed" || reason === "finish_tool";
}

export interface InfraRetryPolicy {
  /**
   * Max retries for transient model/network errors. Handed to the AI SDK's
   * provider-aware retry (exponential backoff, `Retry-After`, `isRetryable`).
   */
  readonly maxRetries: number;
}

export interface RunModelInput {
  readonly model: V3Model;
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly onTextDelta?: (delta: string) => void | Promise<void>;
  readonly signal?: AbortSignal;
  readonly infraRetry?: InfraRetryPolicy;
}

export interface RunModelResult {
  readonly text: string;
  readonly finishReason: string;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  /** Provider-reported reasoning tokens when available (subset of output). */
  readonly reasoningTokens?: number;
  /** Authoritative provider charge in USD when the adapter surfaces it. */
  readonly providerReportedCostUsd?: number;
  /** Provider-resolved model id when distinct from the requested slug. */
  readonly resolvedModelId?: string;
  readonly turns: number;
  readonly toolCalls: number;
}

export interface RunAgentInput extends RunModelInput {
  readonly tools?: AgentToolSet;
  /** Max model invocations. Default 12. */
  readonly maxTurns?: number;
  /** Wall-clock budget for the whole run in ms. Default: none. */
  readonly deadlineMs?: number;
  /** Max identical (tool + args) attempts before the call is fused. Default 2. */
  readonly maxAttemptsPerCall?: number;
  /**
   * Optional context projection applied to the working transcript (never the
   * system prompt) before each model call. Lets the host compact observations
   * without the runtime knowing their shape. Default: identity.
   */
  readonly projectMessages?: (
    messages: readonly ModelMessage[],
  ) => readonly ModelMessage[];
  readonly onEvent?: (event: AgentEvent) => void | Promise<void>;
  /** Short run id for backend logs (e.g. first 8 of a UUID). */
  readonly runId?: string;
  /** Injectable clock for deterministic tests. Default: Date.now. */
  readonly now?: NowFn;
}

export interface RunAgentResult extends RunModelResult {
  readonly stopReason: StopReason;
  /** Finalized generic runtime measurements for this run. */
  readonly metrics: AgentRunMetrics;
}
