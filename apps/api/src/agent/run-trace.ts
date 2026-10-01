import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentEvent, DiagnosticHook, ModelMessage, V3Model } from "@opensuite/agent-core-v3";

/** Only settings used by our model factory; never serialize the model/config. */
export function traceModelSettings(model: V3Model): Record<string, unknown> {
  const settings = (model as unknown as { settings?: Record<string, unknown> }).settings;
  if (!settings) return {};
  const selected: Record<string, unknown> = {};
  for (const [group, keys] of Object.entries({ reasoning: ["effort", "max_tokens", "exclude", "enabled"], provider: ["sort"], usage: ["include"] })) {
    const value = settings[group];
    if (value && typeof value === "object") {
      selected[group] = Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, (value as Record<string, unknown>)[key]]));
    }
  }
  return selected;
}

function traceErrorMessage(message: string): string {
  return message
    .replace(/(?:postgres(?:ql)?|mysql):\/\/[^\s]+/gi, "[omitted: database URL]")
    .replace(/\b(?:Bearer\s+\S+|sk-[\w-]+)/gi, "[omitted: credential]")
    .replace(/\b(api[_ -]?key|authorization|cookie|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[omitted: secret]");
}

function traceJson(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => {
    if (key === "error" && item != null && !(item instanceof Error)) {
      const detail = item as { message?: unknown; code?: unknown };
      item = Object.assign(new Error(typeof item === "string" ? item : typeof detail.message === "string" ? detail.message : "Non-Error detail omitted: may contain transport secrets"),
        { code: detail.code });
    }
    if (key === "errorMessage" && typeof item === "string") return traceErrorMessage(item);
    // Provider/DB Error objects can hold headers, credentials, URLs and bodies.
    // Keep their message/code, never their transport/config properties or cause.
    if (item instanceof Error) return {
      name: item.name,
      message: traceErrorMessage(item.message),
      ...("code" in item && (typeof item.code === "string" || typeof item.code === "number") ? { code: item.code } : {}),
      omitted: "Error transport/config properties and cause may contain secrets",
    };
    return item;
  }, 2) ?? "null";
}

function streamChunkText(part: Record<string, unknown>): string {
  if (typeof part.text === "string") return part.text;
  if (typeof part.delta === "string") return part.delta;
  return "";
}

function canonicalizeToolCall(call: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    toolCallId: call.toolCallId ?? call.id,
    toolName: call.toolName,
    input: call.input,
  };
  if (call.invalid != null) out.invalid = call.invalid;
  if (call.error != null) out.error = call.error;
  return out;
}

function reasoningFromResponseMessages(data: unknown): string {
  const messages = (data as { responseMessages?: readonly ModelMessage[] }).responseMessages;
  if (!Array.isArray(messages)) return "";
  let text = "";
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "reasoning" && typeof (part as { text?: unknown }).text === "string") {
        text += (part as { text: string }).text;
      }
    }
  }
  return text;
}

type PendingTool = {
  turn?: unknown;
  toolCallId: string;
  toolName?: unknown;
  modelFacingName?: unknown;
  arguments?: unknown;
  startedAtMs?: unknown;
};

type TurnBuffer = {
  reasoning: string;
  text: string;
  toolCalls: Record<string, unknown>[];
  responseFlushed: boolean;
  usage: Record<string, unknown> | undefined;
  firstMs: { reasoning?: number; text?: number; tool?: number };
};

function emptyTurn(): TurnBuffer {
  return { reasoning: "", text: "", toolCalls: [], responseFlushed: false, usage: undefined, firstMs: {} };
}

/** Synchronous local appends survive process exit; failures never fail a run. */
export function createRunTrace(input: {
  readonly runId: string;
  readonly threadId: string;
  readonly metadata?: Record<string, unknown>;
}, env: { readonly AGENT_RUN_TRACE?: string; readonly AGENT_RUN_TRACE_DIR?: string } = process.env) {
  if (env.AGENT_RUN_TRACE !== "full") return undefined;
  const startedAt = new Date().toISOString();
  const easternTime = new Date(startedAt).toLocaleString("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true, timeZoneName: "short",
  }).replace(", ", "_");
  const filename = `${input.runId}_${easternTime}`.replace(/[^a-zA-Z0-9_-]/g, "-") + ".md";
  const path = resolve(env.AGENT_RUN_TRACE_DIR || ".agent-traces", filename);
  let writable = true;
  const fail = () => {
    writable = false;
    console.warn("[agent-trace] Local trace write failed; agent execution continues.");
  };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "# Agent Run\n\n**LOCAL DEBUG TRACE — MAY CONTAIN FULL USER/DOCUMENT/MODEL CONTENT**\n", { flag: "wx", mode: 0o600 });
  } catch { fail(); }
  const write = (heading: string, value: unknown) => {
    if (!writable) return;
    try { appendFileSync(path, `\n${heading}\n\n\`\`\`json\n${traceJson(value)}\n\`\`\`\n`); } catch { fail(); }
  };
  const writeText = (heading: string, text: string) => {
    if (!writable) return;
    try { appendFileSync(path, `\n${heading}\n\n\`\`\`text\n${text}\n\`\`\`\n`); } catch { fail(); }
  };
  write("## Metadata", { traceFormatVersion: 2, runId: input.runId, threadId: input.threadId, startedAt, ...input.metadata });

  let turn = 0;
  let buffer = emptyTurn();
  const pendingTools = new Map<string, PendingTool>();

  const flushModelOutput = (partial: boolean) => {
    if (buffer.responseFlushed) return;
    buffer.responseFlushed = true;
    const label = partial ? " — Partial" : "";
    if (buffer.reasoning.length > 0 || partial) writeText(`### Reasoning${label}`, buffer.reasoning);
    if (buffer.text.length > 0) writeText(`### Assistant Text${label}`, buffer.text);
    else if (partial) writeText(`### Assistant Text${label}`, "");
    if (buffer.toolCalls.length > 0) write(`### Tool Calls${label}`, buffer.toolCalls);
  };

  const event = (event: AgentEvent) => {
    if (event.type === "model_turn_started") {
      turn = event.turn;
      buffer = emptyTurn();
    } else if (event.type === "model_turn_first_stream_part") {
      if (event.kind === "reasoning") buffer.firstMs.reasoning = event.elapsedMs;
      else if (event.kind === "text") buffer.firstMs.text = event.elapsedMs;
      else buffer.firstMs.tool = event.elapsedMs;
    } else if (event.type === "model_turn_completed") {
      flushModelOutput(false);
      write(`### Usage / Timing`, {
        turn: event.turn,
        durationMs: event.durationMs,
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        outputTokens: event.outputTokens,
        reasoningTokens: event.reasoningTokens,
        finishReason: event.finishReason,
        toolNames: event.toolNames,
        ...(buffer.usage?.providerReportedCostUsd !== undefined
          ? { providerReportedCostUsd: buffer.usage.providerReportedCostUsd }
          : {}),
        ...(buffer.usage?.resolvedModelId !== undefined ? { resolvedModelId: buffer.usage.resolvedModelId } : {}),
        ...(buffer.usage?.routedProvider !== undefined ? { routedProvider: buffer.usage.routedProvider }
          : "routedProvider" in event ? { routedProvider: event.routedProvider } : {}),
        ...(buffer.firstMs.reasoning !== undefined ? { firstReasoningMs: buffer.firstMs.reasoning } : {}),
        ...(buffer.firstMs.text !== undefined ? { firstTextMs: buffer.firstMs.text } : {}),
        ...(buffer.firstMs.tool !== undefined ? { firstToolMs: buffer.firstMs.tool } : {}),
        exposedToolCount: event.exposedToolCount,
        exposedToolSchemaChars: event.exposedToolSchemaChars,
      });
    } else if (event.type === "cancelled") {
      write("### Runtime Event", event);
    }
  };

  const diagnostic: (event: Parameters<DiagnosticHook>[0], data: unknown, activeGroups?: readonly string[], contextCounts?: unknown) => void = (event, data, activeGroups, contextCounts) => {
    const value = data as Record<string, unknown>;
    if (event === "model_request") {
      buffer = emptyTurn();
      write(`## Turn ${turn} — Request`, {
        model: value.model,
        modelSettings: input.metadata?.modelSettings,
        maxOutputTokens: value.maxOutputTokens,
        maxRetries: value.maxRetries,
        activeGroups,
        contextCounts,
        exposedToolCount: Object.keys(value.tools ?? {}).length,
        exposedToolSchemaChars: JSON.stringify(value.tools ?? {}).length,
      });
      write("### System", value.system ?? null);
      write("### Messages", value.messages);
      write("### Tools", value.tools ?? {});
      for (const message of value.messages as readonly ModelMessage[]) {
        if (Array.isArray(message.content)) for (const part of message.content) {
          if (part.type === "tool-result") write(`### Model-Facing Observation — Turn ${turn} — ${part.toolCallId}`, part);
        }
      }
    } else if (event === "model_stream") {
      const type = value.type;
      if (type === "reasoning-delta") {
        buffer.reasoning += streamChunkText(value);
      } else if (type === "text-delta") {
        buffer.text += streamChunkText(value);
      } else if (type === "tool-call") {
        buffer.toolCalls.push(canonicalizeToolCall(value));
      } else if (type === "error") {
        flushModelOutput(true);
        write("### Model Stream Error", { type, error: value.error });
      }
      // tool-input-start / tool-input-delta / tool-input-end: accumulate via tool-call only
    } else if (event === "model_response") {
      if (!buffer.reasoning) buffer.reasoning = reasoningFromResponseMessages(data);
      if (!buffer.text && typeof value.text === "string") buffer.text = value.text;
      if (Array.isArray(value.toolCalls) && value.toolCalls.length > 0) {
        buffer.toolCalls = (value.toolCalls as Record<string, unknown>[]).map(canonicalizeToolCall);
      }
      buffer.usage = {
        ...(typeof value.providerReportedCostUsd === "number" ? { providerReportedCostUsd: value.providerReportedCostUsd } : {}),
        ...(typeof value.resolvedModelId === "string" ? { resolvedModelId: value.resolvedModelId } : {}),
        ...(typeof value.routedProvider === "string" ? { routedProvider: value.routedProvider } : {}),
      };
      flushModelOutput(false);
    } else if (event === "model_error") {
      flushModelOutput(true);
      write(`### Model Error`, data);
    } else if (event === "tool_started") {
      pendingTools.set(String(value.toolCallId), {
        turn: value.turn,
        toolCallId: String(value.toolCallId),
        toolName: value.toolName,
        modelFacingName: value.modelFacingName,
        arguments: value.arguments,
        startedAtMs: value.startedAtMs,
      });
    } else if (event === "tool_result" || event === "tool_error" || event === "tool_skipped") {
      const pending = pendingTools.get(String(value.toolCallId));
      pendingTools.delete(String(value.toolCallId));
      const heading = event === "tool_error" ? "### Tool Error" : event === "tool_skipped" ? "### Tool Skipped" : "### Tool Result";
      write(`${heading} — ${value.toolName} — ${value.toolCallId}`, {
        turn: value.turn ?? pending?.turn,
        toolCallId: value.toolCallId,
        toolName: value.toolName,
        modelFacingName: value.modelFacingName ?? pending?.modelFacingName,
        ...(pending?.arguments !== undefined ? { arguments: pending.arguments } : value.arguments !== undefined ? { arguments: value.arguments } : {}),
        ...(value.durationMs !== undefined ? { durationMs: value.durationMs } : {}),
        ...(value.outcome !== undefined ? { outcome: value.outcome } : {}),
        ...(value.reasonCode !== undefined ? { reasonCode: value.reasonCode } : {}),
        ...(value.reason !== undefined ? { reason: value.reason } : {}),
        ...(value.rawResult !== undefined ? { rawResult: value.rawResult } : {}),
        ...(value.observation !== undefined ? { observation: value.observation } : {}),
        ...(value.error !== undefined ? { error: value.error } : {}),
        ...(value.startedAtMs !== undefined || pending?.startedAtMs !== undefined
          ? { startedAtMs: value.startedAtMs ?? pending?.startedAtMs } : {}),
        ...(value.completedAtMs !== undefined ? { completedAtMs: value.completedAtMs } : {}),
      });
    }
  };
  return { path, write, event, diagnostic };
}

export type RunTrace = NonNullable<ReturnType<typeof createRunTrace>>;
