/** Injectable clock — tests pass a fake; production uses Date.now. */
export type NowFn = () => number;

export type ToolCallOutcome = "success" | "failure" | "cancelled";

export type ToolCallKindMetric = "read" | "mutate" | "other";

/**
 * How a run ended, for metrics only.
 * Includes thrown-path reasons (`cancelled`, `model_error`) that are not
 * returned as `StopReason` (those still throw to preserve runtime behavior).
 */
export type MetricsStopReason =
  | "completed"
  | "finish_tool"
  | "max_turns"
  | "deadline"
  | "cancelled"
  | "model_error";

export interface ModelTurnMetric {
  readonly turn: number;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
  readonly providerReportedCostUsd?: number;
}

export interface ToolCallMetric {
  readonly sequence: number;
  readonly turn: number;
  readonly toolName: string;
  readonly kind: ToolCallKindMetric;
  readonly durationMs: number;
  readonly outcome: ToolCallOutcome;
  readonly failureCode?: string;
}

export interface FuseEventMetric {
  readonly turn: number;
  readonly toolName?: string;
  readonly reason: string;
}

export interface AgentRunUsage {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  /** Sum of provider-reported turn costs when at least one turn reported cost. */
  readonly providerReportedCostUsd?: number;
}

export interface AgentRunMetrics {
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly modelTurns: readonly ModelTurnMetric[];
  readonly toolCalls: readonly ToolCallMetric[];
  readonly fuseEvents: readonly FuseEventMetric[];
  readonly usage: AgentRunUsage;
  readonly stopReason?: MetricsStopReason;
}

export type ToolCallMetricInput = Omit<ToolCallMetric, "sequence">;

function zeroUsage(): AgentRunUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

function addUsage(usage: AgentRunUsage, turn: ModelTurnMetric): AgentRunUsage {
  const providerReportedCostUsd =
    turn.providerReportedCostUsd !== undefined
      ? (usage.providerReportedCostUsd ?? 0) + turn.providerReportedCostUsd
      : usage.providerReportedCostUsd;
  return {
    inputTokens: usage.inputTokens + turn.inputTokens,
    cachedInputTokens: usage.cachedInputTokens + turn.cachedInputTokens,
    outputTokens: usage.outputTokens + turn.outputTokens,
    reasoningTokens: usage.reasoningTokens + (turn.reasoningTokens ?? 0),
    ...(providerReportedCostUsd !== undefined
      ? { providerReportedCostUsd }
      : {}),
  };
}

/**
 * Mutable per-run collector. Finalize once into immutable `AgentRunMetrics`.
 * Sequence is allocated when a tool starts so concurrent reads stay ordered
 * by call initiation, not completion.
 */
export class RunMetricsCollector {
  private readonly startedAtMs: number;
  private readonly modelTurns: ModelTurnMetric[] = [];
  private readonly toolCalls: ToolCallMetric[] = [];
  private readonly fuseEvents: FuseEventMetric[] = [];
  private usage: AgentRunUsage = zeroUsage();
  private nextToolSequence = 1;
  private finalized: AgentRunMetrics | undefined;

  constructor(private readonly now: NowFn = Date.now) {
    this.startedAtMs = now();
  }

  /** Allocate the next tool sequence number (call once per actual execution). */
  allocToolSequence(): number {
    const sequence = this.nextToolSequence;
    this.nextToolSequence += 1;
    return sequence;
  }

  recordModelTurn(metric: ModelTurnMetric): void {
    this.modelTurns.push(metric);
    this.usage = addUsage(this.usage, metric);
  }

  recordToolCall(metric: ToolCallMetric): void {
    this.toolCalls.push(metric);
  }

  recordFuseEvent(event: FuseEventMetric): void {
    this.fuseEvents.push(event);
  }

  finish(stopReason?: MetricsStopReason): AgentRunMetrics {
    if (this.finalized) return this.finalized;
    const toolCalls = this.toolCalls
      .slice()
      .sort((a, b) => a.sequence - b.sequence);
    this.finalized = {
      startedAtMs: this.startedAtMs,
      completedAtMs: this.now(),
      modelTurns: this.modelTurns.slice(),
      toolCalls,
      fuseEvents: this.fuseEvents.slice(),
      usage: { ...this.usage },
      ...(stopReason !== undefined ? { stopReason } : {}),
    };
    return this.finalized;
  }
}

const METRICS_KEY = "agentRunMetrics";

/** Attach finalized metrics to a thrown error without changing its type. */
export function attachRunMetrics(error: unknown, metrics: AgentRunMetrics): void {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    Object.defineProperty(error, METRICS_KEY, {
      value: metrics,
      enumerable: false,
      configurable: true,
    });
  }
}

/** Read metrics attached by `attachRunMetrics`, if present. */
export function getRunMetricsFromError(error: unknown): AgentRunMetrics | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[METRICS_KEY];
  return value as AgentRunMetrics | undefined;
}
