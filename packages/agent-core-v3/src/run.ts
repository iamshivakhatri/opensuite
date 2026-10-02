import type { ModelMessage, ToolResultPart, ToolSet } from "ai";

import { createFailureFuse, type FailureFuse } from "./fuse.js";
import { streamTurn } from "./model.js";
import { abortReason, DEFAULT_INFRA_RETRY } from "./retry.js";
import {
  attachRunMetrics,
  RunMetricsCollector,
  type MetricsStopReason,
  type NowFn,
  type ToolCallKindMetric,
} from "./run-metrics.js";
import type {
  AgentEvent,
  AgentTool,
  AgentToolSet,
  RunAgentInput,
  RunAgentResult,
  StopReason,
  ToolSkipReason,
} from "./types.js";
import { emitDiagnostic } from "./types.js";

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_MAX_ATTEMPTS_PER_CALL = 2;

interface ToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly invalid?: boolean;
  readonly error?: unknown;
}

type CallOutcome = "ok" | "failed" | "skipped";

/**
 * Generic model → tools → model loop.
 *
 * One turn = one model invocation. Within a turn the model may emit several
 * tool calls; the runtime runs all `read` calls concurrently, then all `mutate`
 * calls sequentially (a failed mutation short-circuits the rest). A failure
 * fuse caps identical retries across turns. The run ends when the model emits a
 * turn with no tool calls, calls a terminal tool, or exhausts a budget.
 *
 * The runtime holds no product/document knowledge — only tool traits.
 */
export async function runAgent(input: RunAgentInput): Promise<RunAgentResult> {
  await input.onEvent?.({ type: "started" });

  const maxTurns = input.maxTurns ?? DEFAULT_MAX_TURNS;
  const retry = input.infraRetry ?? DEFAULT_INFRA_RETRY;
  const fuse = createFailureFuse(
    input.maxAttemptsPerCall ?? DEFAULT_MAX_ATTEMPTS_PER_CALL,
  );
  const now: NowFn = input.now ?? Date.now;
  const deadlineAt =
    input.deadlineMs !== undefined ? now() + input.deadlineMs : undefined;
  const run = input.runId ?? "local";
  const metrics = new RunMetricsCollector(now);

  // Mutable working transcript (never includes the system prompt).
  const transcript: ModelMessage[] = [...input.messages];
  const fixedSchemaTools = input.tools ? schemaOnlyTools(input.tools) : undefined;

  let turns = 0;
  let toolCallCount = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let providerReportedCostUsd: number | undefined;
  let resolvedModelId: string | undefined;
  let lastText = "";
  let lastFinishReason = "stop";

  const finish = (
    stopReason: StopReason,
    text: string,
  ): RunAgentResult => {
    const finalized = metrics.finish(stopReason);
    return {
      text,
      finishReason: lastFinishReason,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningTokens,
      ...(providerReportedCostUsd !== undefined
        ? { providerReportedCostUsd }
        : {}),
      ...(resolvedModelId !== undefined ? { resolvedModelId } : {}),
      turns,
      toolCalls: toolCallCount,
      stopReason,
      metrics: finalized,
    };
  };

  try {
    for (;;) {
      if (input.signal?.aborted) throw abortReason(input.signal);
      if (turns >= maxTurns) return finish("max_turns", lastText);
      if (deadlineAt !== undefined && now() >= deadlineAt) {
        return finish("deadline", lastText);
      }

      turns += 1;
      const projected = input.projectMessages
        ? [...await input.projectMessages(transcript)]
        : transcript;

      // Snapshot the selection: loading more tools cannot widen this turn.
      const turnTools = input.projectTools
        ? { ...input.projectTools({ tools: input.tools ?? {}, turn: turns, messages: transcript }) }
        : input.tools;
      const turnInput = { ...input, tools: turnTools };
      const schemaTools = input.projectTools ? schemaOnlyTools(turnTools!) : fixedSchemaTools;
      const toolSurface = {
        exposedToolCount: Object.keys(schemaTools ?? {}).length,
        exposedToolSchemaChars: JSON.stringify(schemaTools ?? {}).length,
      };

      await input.onEvent?.({ type: "model_turn_started", turn: turns });
      const turnStarted = now();

      const firstStreamMs: Partial<Record<"reasoning" | "text" | "tool", number>> = {};
      let turn;
      try {
        turn = await streamTurn({
          model: input.model,
          ...(input.system ? { system: input.system } : {}),
          messages: projected,
          ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
          ...(schemaTools ? { tools: schemaTools } : {}),
          signal: input.signal,
          retry,
          ...(input.onDiagnostic ? { onDiagnostic: input.onDiagnostic } : {}),
          onStreamPart: async (kind) => {
            if (firstStreamMs[kind] !== undefined) return;
            const elapsedMs = now() - turnStarted;
            firstStreamMs[kind] = elapsedMs;
            await input.onEvent?.({ type: "model_turn_first_stream_part", turn: turns, kind, elapsedMs });
          },
          onTextDelta: async (delta) => {
            await input.onTextDelta?.(delta);
            await input.onEvent?.({ type: "text_delta", delta });
          },
        });
      } catch (error) {
        if (input.onDiagnostic) emitDiagnostic(input.onDiagnostic, "model_error", { turn: turns, error });
        const turnCompleted = now();
        metrics.recordModelTurn({
          turn: turns,
          ...toolSurface,
          startedAtMs: turnStarted,
          completedAtMs: turnCompleted,
          durationMs: turnCompleted - turnStarted,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          ...(firstStreamMs.reasoning !== undefined ? { firstReasoningMs: firstStreamMs.reasoning } : {}),
          ...(firstStreamMs.text !== undefined ? { firstTextMs: firstStreamMs.text } : {}),
          ...(firstStreamMs.tool !== undefined ? { firstToolMs: firstStreamMs.tool } : {}),
        });
        throw error;
      }

      const turnCompleted = now();
      const turnDurationMs = turnCompleted - turnStarted;
      metrics.recordModelTurn({
        turn: turns,
        ...toolSurface,
        startedAtMs: turnStarted,
        completedAtMs: turnCompleted,
        durationMs: turnDurationMs,
        inputTokens: turn.inputTokens,
        cachedInputTokens: turn.cachedInputTokens,
        outputTokens: turn.outputTokens,
        reasoningTokens: turn.reasoningTokens,
        firstReasoningMs: firstStreamMs.reasoning,
        firstTextMs: firstStreamMs.text,
        firstToolMs: firstStreamMs.tool,
        finishReason: turn.finishReason,
        ...(turn.providerReportedCostUsd !== undefined
          ? { providerReportedCostUsd: turn.providerReportedCostUsd }
          : {}),
      });

      inputTokens += turn.inputTokens;
      cachedInputTokens += turn.cachedInputTokens;
      outputTokens += turn.outputTokens;
      reasoningTokens += turn.reasoningTokens;
      if (turn.providerReportedCostUsd !== undefined) {
        providerReportedCostUsd =
          (providerReportedCostUsd ?? 0) + turn.providerReportedCostUsd;
      }
      if (turn.resolvedModelId !== undefined) {
        resolvedModelId = turn.resolvedModelId;
      }
      // Track latest non-empty assistant text for bounded stops / no-tool complete.
      // Finish settlement must NOT fall back across turns (see finish_tool below).
      if (turn.text.trim()) lastText = turn.text;
      lastFinishReason = turn.finishReason;

      if (turn.finishReason === "error") {
        throw new Error(turn.text.trim() || "Model provider returned an error");
      }

      const calls = turn.toolCalls as readonly ToolCall[];
      await input.onEvent?.({
        type: "model_turn_completed",
        turn: turns,
        durationMs: turnDurationMs,
        inputTokens: turn.inputTokens,
        cachedInputTokens: turn.cachedInputTokens,
        outputTokens: turn.outputTokens,
        reasoningTokens: turn.reasoningTokens,
        finishReason: turn.finishReason,
        toolNames: calls.map((call) => resolveToolName(turnTools, call.toolName)),
        ...toolSurface,
        ...(turn.routedProvider !== undefined
          ? { routedProvider: turn.routedProvider }
          : {}),
      });

      if (turn.finishReason === "length") return finish("output_limit", turn.text);

      if (calls.length === 0) {
        await input.onEvent?.({
          type: "completed",
          text: turn.text,
          stopReason: "completed",
        });
        return finish("completed", lastText);
      }

      // The assistant message (with its tool calls) must precede tool results.
      // The SDK supplies error results for unknown tools. With projection the
      // loop owns those rejections too, so keep exactly one result per call.
      transcript.push(...(input.projectTools
        ? turn.responseMessages.filter((message) => message.role !== "tool")
        : turn.responseMessages));
      toolCallCount += calls.length;

      const results = new Map<string, ToolResultPart>();
      const reads: ToolCall[] = [];
      const mutations: ToolCall[] = [];
      for (const call of calls) {
        const kind = resolveTool(turnTools, call.toolName)?.kind;
        if (kind === "mutate") mutations.push(call);
        else reads.push(call);
      }

      // Reads: concurrent (side-effect-free enough to overlap).
      await Promise.all(
        reads.map((call) =>
          runCall({
            input: turnInput,
            call,
            fuse,
            results,
            messages: transcript,
            metrics,
            turn: turns,
            now,
          }),
        ),
      );

      // Mutations: sequential; the first failure skips the remainder.
      let failedMutationCallId: string | null = null;
      for (const call of mutations) {
        if (input.signal?.aborted) throw abortReason(input.signal);
        if (failedMutationCallId) {
          recordSkip({ input: turnInput, call, results, reason: "PRIOR_MUTATION_FAILED", failedToolCallId: failedMutationCallId });
          continue;
        }
        const outcome = await runCall({
          input: turnInput,
          call,
          fuse,
          results,
          messages: transcript,
          metrics,
          turn: turns,
          now,
        });
        if (outcome !== "ok") failedMutationCallId = call.toolCallId;
      }

      // Emit results in original call order so the tool message matches calls.
      transcript.push({
        role: "tool",
        content: calls.map((call) => results.get(call.toolCallId)!),
      });

      // Finish signal: honour only when the batch's mutations all succeeded.
      // Final human-turn text is only this terminal turn's response (or the
      // terminal tool's own string). Never reuse earlier intermediate narration.
      const terminalText = findTerminalText(turnTools, calls, results);
      if (terminalText !== undefined && !failedMutationCallId) {
        const text = (terminalText || turn.text).trim() || "Done.";
        await input.onEvent?.({ type: "completed", text, stopReason: "finish_tool" });
        return finish("finish_tool", text);
      }
    }
  } catch (error) {
    const stopReason: MetricsStopReason = input.signal?.aborted
      ? "cancelled"
      : "model_error";
    if (input.signal?.aborted) {
      await input.onEvent?.({ type: "cancelled" });
    }
    const finalized = metrics.finish(stopReason);
    attachRunMetrics(error, finalized);
    console.info(
      `[agent] run ${run} ${stopReason === "cancelled" ? "cancelled" : "failed"}` +
        ` · ${turns} turns · ${toolCallCount} tools · ${finalized.completedAtMs - finalized.startedAtMs}ms`,
    );
    throw error;
  }
}

/** Run one tool call, record its result part, emit events, feed the fuse. */
async function runCall(args: {
  readonly input: RunAgentInput;
  readonly call: ToolCall;
  readonly fuse: FailureFuse;
  readonly results: Map<string, ToolResultPart>;
  readonly messages: readonly ModelMessage[];
  readonly metrics: RunMetricsCollector;
  readonly turn: number;
  readonly now: NowFn;
}): Promise<CallOutcome> {
  const { input, call, fuse, results, metrics, turn, now } = args;
  const { toolCallId } = call;
  // Provider-facing name stays on results (must match assistant tool-call parts).
  const providerToolName = call.toolName;
  const toolName = resolveToolName(input.tools, providerToolName);
  const tool = resolveTool(input.tools, providerToolName);

  if (fuse.tripped(toolName, call.input)) {
    metrics.recordFuseEvent({
      turn,
      toolName,
      reason: "FUSE_TRIPPED",
    });
    recordSkip({ input, call, results, reason: "FUSE_TRIPPED" });
    return "skipped";
  }

  await input.onEvent?.({ type: "tool_started", toolCallId, toolName });

  const sequence = metrics.allocToolSequence();
  const kind = toolKindMetric(tool);
  const started = now();
  if (input.onDiagnostic) emitDiagnostic(input.onDiagnostic, "tool_started", {
    turn, toolCallId, toolName, modelFacingName: providerToolName, arguments: call.input, startedAtMs: started,
  });

  try {
    if (call.invalid || !tool || typeof tool.execute !== "function") {
      throw new Error(
        call.invalid
          ? errorMessage(call.error) || `Invalid tool call: ${toolName}`
          : `Unknown tool: ${toolName}`,
      );
    }

    const output = await tool.execute(call.input, {
      toolCallId,
      messages: [...args.messages],
      abortSignal: input.signal,
      context: undefined as never,
    });

    const softFailure = readSoftFailure(output);
    results.set(toolCallId, toResultPart(toolCallId, providerToolName, output));
    const completed = now();
    if (input.onDiagnostic) emitDiagnostic(input.onDiagnostic, "tool_result", {
      turn, toolCallId, toolName, modelFacingName: providerToolName, rawResult: output,
      observation: results.get(toolCallId), startedAtMs: started, completedAtMs: completed, durationMs: completed - started,
      outcome: softFailure ? "failure" : "success", reasonCode: softFailure?.reasonCode,
    });

    if (softFailure) {
      fuse.record(toolName, call.input);
      metrics.recordToolCall({
        sequence,
        turn,
        toolName,
        kind,
        durationMs: completed - started,
        outcome: "failure",
        ...(softFailure.reasonCode !== undefined
          ? { failureCode: softFailure.reasonCode }
          : {}),
      });
      await input.onEvent?.({
        type: "tool_failed",
        toolCallId,
        toolName,
        error: softFailure.reasonCode ?? "TOOL_FAILED",
      });
      return "failed";
    }

    metrics.recordToolCall({
      sequence,
      turn,
      toolName,
      kind,
      durationMs: completed - started,
      outcome: "success",
    });
    await input.onEvent?.({ type: "tool_completed", toolCallId, toolName });
    return "ok";
  } catch (error) {
    const durationMs = now() - started;
    if (input.onDiagnostic) emitDiagnostic(input.onDiagnostic, "tool_error", {
      turn, toolCallId, toolName, modelFacingName: providerToolName, error,
      startedAtMs: started, completedAtMs: started + durationMs, durationMs,
      outcome: input.signal?.aborted ? "cancelled" : "failure",
    });
    if (input.signal?.aborted) {
      metrics.recordToolCall({
        sequence,
        turn,
        toolName,
        kind,
        durationMs,
        outcome: "cancelled",
      });
      throw error;
    }
    fuse.record(toolName, call.input);
    const message = errorMessage(error);
    metrics.recordToolCall({
      sequence,
      turn,
      toolName,
      kind,
      durationMs,
      outcome: "failure",
      failureCode: compactFailureCode(message),
    });
    results.set(toolCallId, {
      type: "tool-result",
      toolCallId,
      toolName: providerToolName,
      output: { type: "error-text", value: message },
    });
    await input.onEvent?.({ type: "tool_failed", toolCallId, toolName, error: message });
    return "failed";
  }
}

function toolKindMetric(tool: AgentTool | undefined): ToolCallKindMetric {
  if (tool?.kind === "read" || tool?.kind === "mutate") return tool.kind;
  return "other";
}

/** Prefer short UPPER_SNAKE codes; otherwise a compact generic label. */
function compactFailureCode(message: string): string {
  const trimmed = message.trim();
  if (/^[A-Z][A-Z0-9_]{1,63}$/.test(trimmed)) return trimmed;
  return "TOOL_FAILED";
}

function recordSkip(args: {
  readonly input: RunAgentInput;
  readonly call: ToolCall;
  readonly results: Map<string, ToolResultPart>;
  readonly reason: ToolSkipReason;
  readonly failedToolCallId?: string;
}): void {
  const { call, results, reason } = args;
  results.set(call.toolCallId, {
    type: "tool-result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: {
      type: "json",
      value: { ok: false, status: "skipped", reason, ...(args.failedToolCallId ? { failedToolCallId: args.failedToolCallId } : {}) } as never,
    },
  });
  if (args.input.onDiagnostic) emitDiagnostic(args.input.onDiagnostic, "tool_skipped", {
    toolCallId: call.toolCallId, toolName: resolveToolName(args.input.tools, call.toolName),
    modelFacingName: call.toolName, arguments: call.input, reason, observation: results.get(call.toolCallId),
  });
  void args.input.onEvent?.({
    type: "tool_skipped",
    toolCallId: call.toolCallId,
    toolName: resolveToolName(args.input.tools, call.toolName),
    reason,
  });
}

/**
 * The soft-failure convention: a tool result object with `ok === false` is
 * treated as a failed call (fuse + mutation short-circuit) without throwing.
 * Generic — any tool may adopt it; tools that don't just never return `ok`.
 */
function readSoftFailure(output: unknown): { reasonCode?: string } | null {
  if (!output || typeof output !== "object") return null;
  const record = output as { ok?: unknown; reasonCode?: unknown };
  if (record.ok !== false) return null;
  return typeof record.reasonCode === "string"
    ? { reasonCode: record.reasonCode }
    : {};
}

function toResultPart(
  toolCallId: string,
  toolName: string,
  output: unknown,
): ToolResultPart {
  return {
    type: "tool-result",
    toolCallId,
    toolName,
    output:
      typeof output === "string"
        ? { type: "text", value: output }
        : { type: "json", value: (output === undefined ? null : output) as never },
  };
}

/**
 * If a terminal tool was called and executed successfully, return the string it
 * produced (or "" so the caller can use this turn's assistant text). Returns
 * undefined when no terminal tool ran.
 */
function findTerminalText(
  tools: AgentToolSet | undefined,
  calls: readonly ToolCall[],
  results: Map<string, ToolResultPart>,
): string | undefined {
  if (!tools) return undefined;
  for (const call of calls) {
    if (!resolveTool(tools, call.toolName)?.terminal) continue;
    const part = results.get(call.toolCallId);
    if (!part) continue;
    const output = part.output;
    if (output.type === "error-text") continue; // terminal tool itself failed
    if (output.type === "text") return output.value;
    return "";
  }
  return undefined;
}

/** OpenAI-compatible providers reject names outside [a-zA-Z0-9_-]. */
export function providerSafeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function resolveToolName(tools: AgentToolSet | undefined, name: string): string {
  if (!tools) return name;
  if (tools[name]) return name;
  for (const internal of Object.keys(tools)) {
    if (providerSafeToolName(internal) === name) return internal;
  }
  return name;
}

function resolveTool(tools: AgentToolSet | undefined, name: string): AgentTool | undefined {
  if (!tools) return undefined;
  return tools[resolveToolName(tools, name)];
}

/** AI SDK only needs schemas for the model call; the loop executes tools itself. */
function schemaOnlyTools(tools: AgentToolSet): ToolSet {
  const out: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(tools)) {
    const rest = { ...(definition as Record<string, unknown>) };
    delete rest.execute;
    delete rest.kind;
    delete rest.terminal;
    out[providerSafeToolName(name)] = rest;
  }
  return out as ToolSet;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Tool execution failed";
}
