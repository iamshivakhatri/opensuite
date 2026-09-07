import type { AgentEvent } from "./events.js";
import type { AgentResult } from "./request.js";

/**
 * Structured developer benchmark record.
 * Built from existing `model.turn.metrics` / `tool.execution.metrics` events —
 * not a separate telemetry system.
 */

export interface BenchmarkModelTurn {
  readonly turnIndex: number;
  readonly turnId: string;
  readonly wallMs: number;
  readonly timeToFirstTokenMs?: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly contextBytes: number;
  readonly toolSchemaBytes: number;
  readonly toolArgumentBytes: number;
  readonly toolCallCount: number;
  readonly finishReason?: string;
  readonly provider?: string;
  readonly modelId?: string;
}

export interface BenchmarkToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly wallMs: number;
  readonly success: boolean;
  readonly inputBytes: number;
  readonly resultBytes: number;
}

export interface BenchmarkAggregate {
  readonly totalModelMs: number;
  readonly totalToolMs: number;
  /** Wall time attributed to in-process version persistence when measured. */
  readonly totalPersistMs?: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly maxContextBytes: number;
  readonly totalToolArgumentBytes: number;
}

export interface BenchmarkRunRecord {
  readonly scenario: string;
  readonly provider: string;
  readonly model: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly totalWallMs: number;
  readonly status: AgentResult["status"];
  readonly summary: string;
  readonly success: boolean;
  readonly correctnessOk: boolean;
  readonly correctnessNotes: readonly string[];
  readonly modelTurns: number;
  readonly toolCalls: number;
  readonly versionsCreated: number;
  readonly failures: number;
  readonly retries: number;
  readonly turns: readonly BenchmarkModelTurn[];
  readonly tools: readonly BenchmarkToolCall[];
  readonly aggregate: BenchmarkAggregate;
}

export interface BuildBenchmarkRecordInput {
  readonly scenario: string;
  readonly provider: string;
  readonly model: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly totalWallMs: number;
  readonly events: readonly AgentEvent[];
  readonly result: AgentResult;
  readonly correctnessOk: boolean;
  readonly correctnessNotes?: readonly string[];
  /** Optional harness-measured persistence time (ms). */
  readonly totalPersistMs?: number;
}

/** Count failed tool metrics + agent.failed (prefer metrics over outcome double-count). */
function countFailures(
  events: readonly AgentEvent[],
  result: AgentResult,
): number {
  const metricFails = events.filter(
    (e) => e.type === "tool.execution.metrics" && !e.success,
  ).length;
  const agentFails = events.filter((e) => e.type === "agent.failed").length;
  if (metricFails > 0 || agentFails > 0) {
    return metricFails + agentFails;
  }
  return result.toolOutcomes.filter((o) => o.status === "failed").length;
}

/**
 * Heuristic retry count: same tool name failed then succeeded later, or
 * authoring-timeout / nudge turns. Conservative — never invents retries.
 */
function countRetries(events: readonly AgentEvent[]): number {
  const failedNames = new Set<string>();
  let retries = 0;
  for (const event of events) {
    if (event.type === "tool.execution.metrics") {
      if (!event.success) {
        failedNames.add(event.toolName);
      } else if (failedNames.has(event.toolName)) {
        retries += 1;
        failedNames.delete(event.toolName);
      }
    }
  }
  return retries;
}

export function buildBenchmarkRecord(
  input: BuildBenchmarkRecordInput,
): BenchmarkRunRecord {
  const turns: BenchmarkModelTurn[] = [];
  const tools: BenchmarkToolCall[] = [];
  let versionsCreated = 0;

  for (const event of input.events) {
    if (event.type === "model.turn.metrics") {
      turns.push({
        turnIndex: event.turnIndex,
        turnId: event.turnId,
        wallMs: event.modelWallMs,
        ...(event.timeToFirstTokenMs !== undefined
          ? { timeToFirstTokenMs: event.timeToFirstTokenMs }
          : {}),
        ...(event.inputTokens !== undefined
          ? { inputTokens: event.inputTokens }
          : {}),
        ...(event.cachedInputTokens !== undefined
          ? { cachedInputTokens: event.cachedInputTokens }
          : {}),
        ...(event.outputTokens !== undefined
          ? { outputTokens: event.outputTokens }
          : {}),
        ...(event.reasoningTokens !== undefined
          ? { reasoningTokens: event.reasoningTokens }
          : {}),
        contextBytes: event.contextMessageBytes,
        toolSchemaBytes: event.toolCatalogBytes,
        toolArgumentBytes: event.toolArgumentBytes,
        toolCallCount: event.toolCallCount,
        ...(event.finishReason !== undefined
          ? { finishReason: event.finishReason }
          : {}),
        ...(event.provider !== undefined ? { provider: event.provider } : {}),
        ...(event.modelId !== undefined ? { modelId: event.modelId } : {}),
      });
    } else if (event.type === "tool.execution.metrics") {
      tools.push({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        wallMs: event.wallMs,
        success: event.success,
        inputBytes: event.inputBytes,
        resultBytes: event.resultBytes,
      });
    } else if (event.type === "document.version.advanced") {
      versionsCreated += 1;
    } else if (event.type === "document.created") {
      versionsCreated += 1;
    }
  }

  const totalModelMs = turns.reduce((sum, t) => sum + t.wallMs, 0);
  const totalToolMs = tools.reduce((sum, t) => sum + t.wallMs, 0);

  const aggregate: BenchmarkAggregate = {
    totalModelMs,
    totalToolMs,
    ...(input.totalPersistMs !== undefined
      ? { totalPersistMs: input.totalPersistMs }
      : {}),
    inputTokens: turns.reduce((s, t) => s + (t.inputTokens ?? 0), 0),
    cachedInputTokens: turns.reduce(
      (s, t) => s + (t.cachedInputTokens ?? 0),
      0,
    ),
    outputTokens: turns.reduce((s, t) => s + (t.outputTokens ?? 0), 0),
    reasoningTokens: turns.reduce((s, t) => s + (t.reasoningTokens ?? 0), 0),
    maxContextBytes: turns.reduce((m, t) => Math.max(m, t.contextBytes), 0),
    totalToolArgumentBytes: turns.reduce(
      (s, t) => s + t.toolArgumentBytes,
      0,
    ),
  };

  const failures = countFailures(input.events, input.result);
  const success =
    input.result.status === "completed" && input.correctnessOk;

  return {
    scenario: input.scenario,
    provider: input.provider,
    model: input.model,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    totalWallMs: input.totalWallMs,
    status: input.result.status,
    summary: input.result.summary,
    success,
    correctnessOk: input.correctnessOk,
    correctnessNotes: input.correctnessNotes ?? [],
    modelTurns: turns.length,
    toolCalls: tools.length,
    versionsCreated,
    failures,
    retries: countRetries(input.events),
    turns,
    tools,
    aggregate,
  };
}

/** Compact one-line row for terminal tables. */
export function formatBenchmarkSummaryRow(
  record: BenchmarkRunRecord,
): string {
  const flag = record.success ? "ok" : "FAIL";
  return [
    record.scenario,
    String(record.modelTurns),
    String(record.toolCalls),
    `${(record.totalWallMs / 1000).toFixed(1)}s`,
    `${(record.aggregate.totalModelMs / 1000).toFixed(1)}s`,
    `${(record.aggregate.totalToolMs / 1000).toFixed(1)}s`,
    String(record.aggregate.inputTokens || "—"),
    String(record.aggregate.outputTokens || "—"),
    String(record.failures),
    flag,
  ].join("\t");
}
