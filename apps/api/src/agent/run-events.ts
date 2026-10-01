import type {
  AgentEvent as CoreAgentEvent,
  AgentRunMetrics,
  StopReason,
} from "@opensuite/agent-core-v3";

import {
  productionModelPricingRegistry,
} from "../model-usage/pricing.js";
import {
  composeAgentRunReport,
  logAgentRunReport,
  type AgentRunReport,
  type AgentRunReportSink,
  type AgentRunReportRetrieval,
  type DocumentTransition,
  type DocumentVersionAdvance,
} from "./agent-run-report.js";
import {
  formatModelTurnCompleted,
  formatModelTurnFirstStreamPart,
  formatModelTurnStarted,
  formatToolFinished,
  logAgentLine,
} from "./agent-run-log.js";
import type { DocumentCheck } from "./document-verification.js";
import type {
  AgentStepKind,
  AgentStepStatus,
} from "./persistence.js";
import type {
  AgentEventSink,
  ResolvedV3ExecutionModel,
} from "./execution.js";
import type { RunTrace } from "./run-trace.js";

export const isInputNeededTool = (name: string | undefined) => name === "finish_with_input_needed" || name === "request_clarification";
export const isFinishTool = (name: string | undefined) => name === "finish" || isInputNeededTool(name);

export type TranscriptEntry = {
  readonly kind: AgentStepKind;
  readonly status: AgentStepStatus;
  readonly name: string;
  readonly summary: string;
  readonly output?: Record<string, unknown>;
};

export function summarizeError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current !== undefined && current !== null && depth < 4) {
    depth += 1;
    if (current instanceof Error) {
      const name = current.name || "Error";
      // Prefer the underlying DB/driver message over Drizzle's "Failed query: …"
      // wrapper (which dumps SQL). Never include the full query text.
      const message = sanitizeErrorMessage(current.message);
      const code =
        "code" in current &&
        (typeof (current as { code?: unknown }).code === "string" ||
          typeof (current as { code?: unknown }).code === "number")
          ? String((current as { code: string | number }).code)
          : undefined;
      parts.push(
        code ? `${name}: ${message} (code=${code})` : `${name}: ${message}`,
      );
      current = current.cause;
      continue;
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      const code =
        typeof record.code === "string" || typeof record.code === "number"
          ? String(record.code)
          : undefined;
      const detail =
        typeof record.detail === "string"
          ? sanitizeErrorMessage(record.detail)
          : typeof record.message === "string"
            ? sanitizeErrorMessage(record.message)
            : undefined;
      if (code || detail) {
        parts.push([code ? `code=${code}` : null, detail].filter(Boolean).join(" "));
      }
      current = "cause" in record ? record.cause : undefined;
      continue;
    }
    parts.push(sanitizeErrorMessage(String(current)));
    break;
  }
  const summary = parts.join(" | ");
  return summary.slice(0, 400) || "unknown error";
}

/** Strip SQL bodies / connection strings from loggable error text. */
function sanitizeErrorMessage(message: string): string {
  let text = message;
  // Drizzle wraps: "Failed query: select …\nparams: …"
  if (/^Failed query:/i.test(text)) {
    const relation =
      text.match(/\b(?:relation|table)\s+"?([a-zA-Z0-9_.]+)"?/i)?.[1] ??
      text.match(/\bfrom\s+"([a-zA-Z0-9_]+)"/i)?.[1];
    text = relation
      ? `Failed query involving ${relation}`
      : "Failed database query";
  }
  text = text.replace(/postgresql:\/\/[^\s]+/gi, "postgresql://***");
  text = text.replace(/\nparams:[\s\S]*$/i, "");
  return text.slice(0, 200);
}

export function createTranscriptCollector() {
  const entries: TranscriptEntry[] = [];
  let narration = "";
  const flushNarration = () => {
    const summary = narration.trim();
    narration = "";
    if (summary) entries.push({ kind: "narration", status: "completed", name: "Assistant narration", summary });
  };
  return {
    text(delta: string) {
      narration += delta;
    },
    toolStarted(toolName?: string) {
      // Final answer text before `finish` stays buffered so finish(finalText)
      // can drop it; flushing here would duplicate agent_message content.
      if (isFinishTool(toolName)) return;
      flushNarration();
    },
    toolFinished(toolName: string, status: AgentStepStatus, skipped = false, error?: string) {
      entries.push({
        kind: toolName === "document.inspect" ? "inspect" : "tool",
        status,
        name: toolName,
        summary: skipped ? "Skipped" : status === "completed" ? "Completed" : `Failed${error ? `: ${error.slice(0, 120)}` : ""}`,
      });
    },
    finish(finalText?: string) {
      const remaining = narration.trim();
      narration = "";
      if (
        remaining &&
        remaining.replace(/\s+/g, " ") !== (finalText ?? "").trim().replace(/\s+/g, " ")
      ) {
        entries.push({ kind: "narration", status: "completed", name: "Assistant narration", summary: remaining });
      }
    },
    validation(checks: readonly DocumentCheck[]) {
      entries.push({ kind: "validation", status: "completed", name: "Document validation", summary: "Document validation", output: { checks } });
    },
    entries() {
      return entries;
    },
  };
}

/** Log turn/tool lines and relay product events / transcript updates. */
export function createRunEventHandler(input: {
  readonly liveEvents?: AgentEventSink;
  readonly runId: string;
  readonly messageId: string;
  readonly transcript: ReturnType<typeof createTranscriptCollector>;
  readonly modelLabel: string;
  readonly maxOutputTokens?: number;
}): (event: CoreAgentEvent) => void | Promise<void> {
  const toolStartedAt = new Map<string, number>();
  let turnSawStreamPart = false;
  return (event) => {
    if (event.type === "model_turn_started") {
      turnSawStreamPart = false;
      logAgentLine(formatModelTurnStarted({
        turn: event.turn,
        model: input.modelLabel,
        maxOutputTokens: input.maxOutputTokens,
      }));
    } else if (event.type === "model_turn_first_stream_part") {
      turnSawStreamPart = true;
      logAgentLine(
        formatModelTurnFirstStreamPart({ turn: event.turn, kind: event.kind, elapsedMs: event.elapsedMs }),
      );
    } else if (event.type === "model_turn_completed") {
      logAgentLine(
        formatModelTurnCompleted({
          turn: event.turn,
          durationMs: event.durationMs,
          inputTokens: event.inputTokens,
          cachedInputTokens: event.cachedInputTokens,
          outputTokens: event.outputTokens,
          reasoningTokens: event.reasoningTokens,
          toolNames: event.toolNames,
          finishReason: event.finishReason,
          sawStreamPart: turnSawStreamPart,
        }),
      );
    } else if (event.type === "tool_started") {
      if (!isFinishTool(event.toolName)) {
        toolStartedAt.set(event.toolCallId, Date.now());
      }
    } else if (
      event.type === "tool_completed" ||
      event.type === "tool_failed" ||
      event.type === "tool_skipped"
    ) {
      if (!isFinishTool(event.toolName)) {
        const elapsed = Date.now() - (toolStartedAt.get(event.toolCallId) ?? Date.now());
        const code =
          event.type === "tool_failed"
            ? event.error
            : event.type === "tool_skipped"
              ? event.reason
              : undefined;
        logAgentLine(
          formatToolFinished({
            toolName: event.toolName,
            ok: event.type === "tool_completed",
            durationMs: elapsed,
            skipped: event.type === "tool_skipped",
            ...(code && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)
              ? { code }
              : event.type === "tool_failed"
                ? { code: "TOOL_FAILED" }
                : code
                  ? { code }
                  : {}),
          }),
        );
        toolStartedAt.delete(event.toolCallId);
      }
    }
    return relayEvent(event, input.liveEvents, input.runId, input.messageId, input.transcript);
  };
}

export async function emitRunReport(input: {
  readonly trace?: RunTrace;
  readonly runId: string;
  readonly instruction: string;
  readonly model: ResolvedV3ExecutionModel;
  readonly metrics: AgentRunMetrics | undefined;
  readonly stopReason?: StopReason;
  readonly cancelled: boolean;
  readonly thrown: boolean;
  readonly initialDocumentId?: string | null;
  readonly finalDocumentId?: string | null;
  readonly initialVersionId: string | null;
  readonly finalVersionId?: string | null;
  readonly workingMutationCount?: number;
  readonly versionAdvances: readonly DocumentVersionAdvance[];
  readonly documentTransitions?: readonly DocumentTransition[];
  readonly retrieval?: AgentRunReportRetrieval;
  readonly context: {
    readonly checkpointUsed: boolean;
    readonly checkpointThroughMessageId?: string;
    readonly historyQueryMode: "recent" | "post_checkpoint";
    readonly historicalMessagesLoaded: number;
    readonly historicalMessagesAfterCheckpoint: number;
    readonly historicalMessagesProjected: number;
    readonly historicalCharactersLoaded: number;
    readonly historicalCharactersProjected: number;
    readonly estimatedHistoricalTokens: number;
    readonly historyWasTrimmed: boolean;
    readonly modelContextLength?: number;
    readonly outputReserveTokens?: number;
    readonly continuationReserveTokens?: number;
    readonly safetyMarginTokens?: number;
    readonly safeInputBudgetTokens?: number;
    readonly estimatedInputTokens: number;
    readonly approximateTokenBudgetApplied: boolean;
    readonly historyTrimmedByTokenBudget: boolean;
    readonly inRunObservationsCompacted?: number;
    readonly estimatedInRunTokensBefore?: number;
    readonly estimatedInRunTokensAfter?: number;
    readonly maxProjectedInputTokens?: number;
    readonly redundantReadSuppressedCount?: number;
    readonly continuationPreviousRunId?: string;
  };
  readonly sink?: AgentRunReportSink;
}): Promise<void> {
  if (!input.metrics) return;
  let report: AgentRunReport;
  try {
    const attribution = input.model.usageAttribution;
    const pricing =
      attribution !== undefined
        ? productionModelPricingRegistry.lookup(
            attribution.provider,
            attribution.model,
          )
        : null;
    report = composeAgentRunReport({
      runId: input.runId,
      instruction: input.instruction,
      ...(attribution !== undefined
        ? { provider: attribution.provider, model: attribution.model }
        : {}),
      metrics: input.metrics,
      ...(input.stopReason !== undefined
        ? { stopReason: input.stopReason }
        : {}),
      cancelled: input.cancelled,
      thrown: input.thrown,
      initialDocumentId: input.initialDocumentId,
      finalDocumentId: input.finalDocumentId,
      initialVersionId: input.initialVersionId,
      finalVersionId: input.finalVersionId,
      workingMutationCount: input.workingMutationCount,
      versionAdvances: input.versionAdvances,
      documentTransitions: input.documentTransitions ?? [],
      ...(input.retrieval !== undefined ? { retrieval: input.retrieval } : {}),
      context: input.context,
      pricing,
      ...(attribution !== undefined
        ? { pricingProvider: attribution.provider }
        : {}),
    });
  } catch (error) {
    console.error(
      `[agent] run=${input.runId.slice(0, 8)} run_report_failed reason=${summarizeError(error)}`,
    );
    return;
  }
  input.trace?.write("## Run Report — Outcome / Versions / Total Usage / Cost / Timing", report);
  try {
    logAgentRunReport(report);
  } catch (error) {
    console.error(
      `[agent] run=${input.runId.slice(0, 8)} run_report_log_failed reason=${summarizeError(error)}`,
    );
  }
  try {
    void Promise.resolve(input.sink?.(report)).catch((error: unknown) => {
      console.error(
        `[agent] run=${input.runId.slice(0, 8)} run_report_sink_failed reason=${summarizeError(error)}`,
      );
    });
  } catch (error) {
    console.error(
      `[agent] run=${input.runId.slice(0, 8)} run_report_sink_failed reason=${summarizeError(error)}`,
    );
  }
}

async function relayEvent(
  event: CoreAgentEvent,
  sink: AgentEventSink | undefined,
  runId: string,
  messageId: string,
  transcript: ReturnType<typeof createTranscriptCollector>,
): Promise<void> {
  if (event.type === "text_delta") transcript.text(event.delta);
  if (event.type === "tool_started") transcript.toolStarted(event.toolName);
  if (event.type === "tool_completed") transcript.toolFinished(event.toolName, "completed");
  if (event.type === "tool_failed") transcript.toolFinished(event.toolName, "failed", false, event.error);
  if (event.type === "tool_skipped") transcript.toolFinished(event.toolName, "cancelled", true);
  if (!sink) return;
  const at = new Date().toISOString();
  if (event.type === "started") return sink.emit({ type: "agent.started", runId, at });
  if (event.type === "text_delta") return sink.emit({ type: "message.delta", runId, messageId, delta: event.delta, at });
  if (event.type === "tool_started") {
    return sink.emit({
      type: "tool.started",
      runId,
      at,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
  }
  if (event.type === "tool_completed") {
    return sink.emit({
      type: "tool.completed",
      runId,
      at,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
    });
  }
  if (event.type === "tool_failed") {
    return sink.emit({
      type: "tool.failed",
      runId,
      at,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      error: event.error,
    });
  }
  // Map skips onto the existing tool.failed product event (no frontend change).
  if (event.type === "tool_skipped") {
    return sink.emit({
      type: "tool.failed",
      runId,
      at,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      error: event.reason,
    });
  }
  if (event.type === "completed") return sink.emit({ type: "message.completed", runId, messageId, content: event.text, at });
}
