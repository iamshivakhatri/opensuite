import type { ModelMessage, ToolResultPart, ToolSet } from "ai";

import { createFailureFuse, type FailureFuse } from "./fuse.js";
import { streamTurn } from "./model.js";
import { abortReason, DEFAULT_INFRA_RETRY } from "./retry.js";
import type {
  AgentEvent,
  AgentTool,
  AgentToolSet,
  RunAgentInput,
  RunAgentResult,
  StopReason,
  ToolSkipReason,
} from "./types.js";

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
  const deadlineAt =
    input.deadlineMs !== undefined ? Date.now() + input.deadlineMs : undefined;
  const run = input.runId ?? "local";
  const runStarted = Date.now();

  // Mutable working transcript (never includes the system prompt).
  const transcript: ModelMessage[] = [...input.messages];
  const schemaTools = input.tools ? schemaOnlyTools(input.tools) : undefined;

  let turns = 0;
  let toolCallCount = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let lastText = "";
  let lastFinishReason = "stop";

  const finish = (stopReason: StopReason, text: string): RunAgentResult => ({
    text,
    finishReason: lastFinishReason,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    turns,
    toolCalls: toolCallCount,
    stopReason,
  });

  try {
    for (;;) {
      if (input.signal?.aborted) throw abortReason(input.signal);
      if (turns >= maxTurns) return finish("max_turns", lastText);
      if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
        return finish("deadline", lastText);
      }

      turns += 1;
      const turnStarted = Date.now();
      const projected = input.projectMessages
        ? [...input.projectMessages(transcript)]
        : transcript;

      const turn = await streamTurn({
        model: input.model,
        ...(input.system ? { system: input.system } : {}),
        messages: projected,
        ...(schemaTools ? { tools: schemaTools } : {}),
        signal: input.signal,
        retry,
        onTextDelta: async (delta) => {
          await input.onTextDelta?.(delta);
          await input.onEvent?.({ type: "text_delta", delta });
        },
      });

      inputTokens += turn.inputTokens;
      cachedInputTokens += turn.cachedInputTokens;
      outputTokens += turn.outputTokens;
      lastText = turn.text;
      lastFinishReason = turn.finishReason;

      const calls = turn.toolCalls as readonly ToolCall[];
      console.info(
        `[agent-v3] turn run=${run} turn=${turns} elapsedMs=${Date.now() - turnStarted} inputTokens=${turn.inputTokens} cachedInputTokens=${turn.cachedInputTokens} outputTokens=${turn.outputTokens} toolCalls=${calls.length}`,
      );

      if (calls.length === 0) {
        await input.onEvent?.({
          type: "completed",
          text: turn.text,
          stopReason: "completed",
        });
        return finish("completed", turn.text);
      }

      // The assistant message (with its tool calls) must precede tool results.
      transcript.push(...turn.responseMessages);
      toolCallCount += calls.length;

      const results = new Map<string, ToolResultPart>();
      const reads: ToolCall[] = [];
      const mutations: ToolCall[] = [];
      for (const call of calls) {
        const kind = input.tools?.[call.toolName]?.kind;
        if (kind === "mutate") mutations.push(call);
        else reads.push(call);
      }

      // Reads: concurrent (side-effect-free enough to overlap).
      await Promise.all(
        reads.map((call) =>
          runCall({ input, call, fuse, results, messages: transcript }),
        ),
      );

      // Mutations: sequential; the first failure skips the remainder.
      let mutationFailed = false;
      for (const call of mutations) {
        if (input.signal?.aborted) throw abortReason(input.signal);
        if (mutationFailed) {
          recordSkip({ input, call, results, reason: "PRIOR_MUTATION_FAILED" });
          continue;
        }
        const outcome = await runCall({
          input,
          call,
          fuse,
          results,
          messages: transcript,
        });
        if (outcome !== "ok") mutationFailed = true;
      }

      // Emit results in original call order so the tool message matches calls.
      transcript.push({
        role: "tool",
        content: calls.map((call) => results.get(call.toolCallId)!),
      });

      // Finish signal: honour only when the batch's mutations all succeeded.
      const terminalText = findTerminalText(input.tools, calls, results);
      if (terminalText !== undefined && !mutationFailed) {
        const text = terminalText || lastText;
        await input.onEvent?.({ type: "completed", text, stopReason: "finish_tool" });
        return finish("finish_tool", text);
      }
    }
  } catch (error) {
    if (input.signal?.aborted) {
      await input.onEvent?.({ type: "cancelled" });
    }
    console.info(
      `[agent-v3] run_aborted_or_failed run=${run} turns=${turns} toolCalls=${toolCallCount} elapsedMs=${Date.now() - runStarted}`,
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
}): Promise<CallOutcome> {
  const { input, call, fuse, results } = args;
  const { toolName, toolCallId } = call;
  const tool = input.tools?.[toolName] as AgentTool | undefined;

  if (fuse.tripped(toolName, call.input)) {
    recordSkip({ input, call, results, reason: "FUSE_TRIPPED" });
    return "skipped";
  }

  await input.onEvent?.({ type: "tool_started", toolCallId, toolName });

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
    results.set(toolCallId, toResultPart(toolCallId, toolName, output));

    if (softFailure) {
      fuse.record(toolName, call.input);
      await input.onEvent?.({
        type: "tool_failed",
        toolCallId,
        toolName,
        error: softFailure.reasonCode ?? "TOOL_FAILED",
      });
      return "failed";
    }

    await input.onEvent?.({ type: "tool_completed", toolCallId, toolName });
    return "ok";
  } catch (error) {
    if (input.signal?.aborted) throw error;
    fuse.record(toolName, call.input);
    const message = errorMessage(error);
    results.set(toolCallId, {
      type: "tool-result",
      toolCallId,
      toolName,
      output: { type: "error-text", value: message },
    });
    await input.onEvent?.({ type: "tool_failed", toolCallId, toolName, error: message });
    return "failed";
  }
}

function recordSkip(args: {
  readonly input: RunAgentInput;
  readonly call: ToolCall;
  readonly results: Map<string, ToolResultPart>;
  readonly reason: ToolSkipReason;
}): void {
  const { call, results, reason } = args;
  results.set(call.toolCallId, {
    type: "tool-result",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: {
      type: "json",
      value: { ok: false, status: "skipped", reason } as never,
    },
  });
  void args.input.onEvent?.({
    type: "tool_skipped",
    toolCallId: call.toolCallId,
    toolName: call.toolName,
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
 * produced (or "" to fall back to assistant text). Returns undefined when no
 * terminal tool ran.
 */
function findTerminalText(
  tools: AgentToolSet | undefined,
  calls: readonly ToolCall[],
  results: Map<string, ToolResultPart>,
): string | undefined {
  if (!tools) return undefined;
  for (const call of calls) {
    if (!tools[call.toolName]?.terminal) continue;
    const part = results.get(call.toolCallId);
    if (!part) continue;
    const output = part.output;
    if (output.type === "error-text") continue; // terminal tool itself failed
    if (output.type === "text") return output.value;
    return "";
  }
  return undefined;
}

/** AI SDK only needs schemas for the model call; the loop executes tools itself. */
function schemaOnlyTools(tools: AgentToolSet): ToolSet {
  const out: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(tools)) {
    const rest = { ...(definition as Record<string, unknown>) };
    delete rest.execute;
    delete rest.kind;
    delete rest.terminal;
    out[name] = rest;
  }
  return out as ToolSet;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Tool execution failed";
}
