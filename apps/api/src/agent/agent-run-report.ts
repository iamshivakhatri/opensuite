import {
  getRunMetricsFromError,
  type AgentRunMetrics,
  type FuseEventMetric,
  type MetricsStopReason,
  type StopReason,
} from "@opensuite/agent-core-v3";

import type { ProviderCredentialProvider } from "../credentials/types.js";
import {
  estimateModelCost,
  MICRO_USD_PER_USD,
  type ModelPricingEntry,
} from "../model-usage/pricing.js";

export type AgentRunOutcome = "success" | "failure" | "partial" | "cancelled";

export interface DocumentVersionAdvance {
  readonly fromVersionId: string;
  readonly toVersionId: string;
  readonly toolName?: string;
}

export interface DocumentTransition {
  readonly kind: "created" | "duplicated";
  readonly fromDocumentId: string | null;
  readonly toDocumentId: string;
  readonly title: string;
}

export interface AgentRunReportDocument {
  readonly initialDocumentId?: string;
  readonly finalDocumentId?: string;
  readonly initialVersionId?: string;
  readonly finalVersionId?: string;
  readonly versionAdvances: readonly DocumentVersionAdvance[];
  readonly transitions: readonly DocumentTransition[];
}

export interface AgentRunReportFailure {
  readonly source: "model" | "tool" | "runtime";
  readonly code?: string;
  readonly toolName?: string;
}

export interface AgentRunReportTool {
  readonly sequence: number;
  readonly turn: number;
  readonly name: string;
  readonly kind: string;
  readonly durationMs: number;
  readonly outcome: string;
  readonly failureCode?: string;
}

export interface AgentRunReportRetrieval {
  readonly cache: "hit" | "miss";
  readonly blockCount: number;
  readonly reason?: string;
  readonly detail?: { readonly kind: "table_rows"; readonly itemCount: number };
}

export interface AgentRunReportContext {
  readonly checkpointUsed: boolean;
  readonly checkpointThroughMessageId?: string;
  readonly historicalMessagesLoaded: number;
  readonly historicalMessagesAfterCheckpoint: number;
  readonly historicalMessagesProjected: number;
  readonly historicalCharactersLoaded: number;
  readonly historicalCharactersProjected: number;
  readonly estimatedHistoricalTokens: number;
  readonly historyWasTrimmed: boolean;
  readonly modelContextLength?: number;
  readonly estimatedInputTokens: number;
  readonly approximateTokenBudgetApplied: boolean;
  readonly historyTrimmedByTokenBudget: boolean;
}

export interface AgentRunReport {
  readonly runId: string;
  readonly instruction: string;
  readonly provider?: string;
  readonly model?: string;
  readonly outcome: AgentRunOutcome;
  readonly stopReason?: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly totalDurationMs: number;
  readonly modelTurns: number;
  readonly modelTimeMs: number;
  readonly toolCalls: number;
  readonly toolTimeMs: number;
  readonly tools: readonly AgentRunReportTool[];
  readonly usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  };
  readonly estimatedCostUsd?: number;
  readonly failures: readonly AgentRunReportFailure[];
  readonly fuseEvents: readonly FuseEventMetric[];
  readonly document?: AgentRunReportDocument;
  readonly retrieval?: AgentRunReportRetrieval;
  readonly context?: AgentRunReportContext;
}

export interface ComposeAgentRunReportInput {
  readonly runId: string;
  readonly instruction: string;
  readonly provider?: string;
  readonly model?: string;
  readonly metrics: AgentRunMetrics;
  /** Product stop reason when the run returned normally from agent-core. */
  readonly stopReason?: StopReason | MetricsStopReason;
  readonly cancelled?: boolean;
  /** True when the runtime threw (model/infra error path). */
  readonly thrown?: boolean;
  readonly initialDocumentId?: string | null;
  readonly finalDocumentId?: string | null;
  readonly initialVersionId?: string | null;
  readonly finalVersionId?: string | null;
  readonly versionAdvances?: readonly DocumentVersionAdvance[];
  readonly documentTransitions?: readonly DocumentTransition[];
  readonly retrieval?: AgentRunReportRetrieval;
  readonly context?: AgentRunReportContext;
  readonly pricing?: ModelPricingEntry | null;
  readonly pricingProvider?: ProviderCredentialProvider;
}

/**
 * Technical run outcome from runtime + document facts — never LLM-judged.
 *
 * - cancelled: abort signal / cancelled settlement
 * - partial: terminal failure after at least one version advance
 * - failure: terminal failure with no version advance
 * - success: clean successful stop (completed / finish_tool)
 */
export function deriveRunOutcome(input: {
  readonly cancelled?: boolean;
  readonly terminalFailure?: boolean;
  readonly versionAdvanceCount: number;
}): AgentRunOutcome {
  if (input.cancelled) return "cancelled";
  if (input.terminalFailure && input.versionAdvanceCount > 0) return "partial";
  if (input.terminalFailure) return "failure";
  return "success";
}

/**
 * Estimate USD cost from usage + optional pricing entry.
 *
 * Cached-token semantics follow `estimateModelCost` / OpenRouter usage:
 * `inputTokens` is openai_inclusive (total input including cache reads), so
 * uncached = input − cached. Unknown pricing → undefined.
 */
export function estimateModelCostUsd(
  usage: AgentRunMetrics["usage"],
  pricing: ModelPricingEntry | null | undefined,
  provider: ProviderCredentialProvider | undefined,
  model: string | undefined,
): number | undefined {
  if (!pricing || !provider || !model) return undefined;
  const estimated = estimateModelCost({
    provider,
    model,
    tokens: {
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      reasoningTokens: null,
    },
    pricing,
  });
  if (estimated.status !== "priced") return undefined;
  return estimated.estimatedCostMicros / MICRO_USD_PER_USD;
}

export function composeAgentRunReport(
  input: ComposeAgentRunReportInput,
): AgentRunReport {
  const advances = input.versionAdvances ?? [];
  const stopReason = input.stopReason ?? input.metrics.stopReason;
  const cancelled =
    input.cancelled === true || stopReason === "cancelled";

  const successfulStop =
    stopReason === "completed" || stopReason === "finish_tool";

  const terminalFailure =
    !cancelled &&
    (input.thrown === true ||
      (stopReason !== undefined && !successfulStop));

  const outcome = deriveRunOutcome({
    cancelled,
    terminalFailure,
    versionAdvanceCount: advances.length,
  });

  const modelTimeMs = input.metrics.modelTurns.reduce(
    (sum, turn) => sum + turn.durationMs,
    0,
  );
  const toolTimeMs = input.metrics.toolCalls.reduce(
    (sum, call) => sum + call.durationMs,
    0,
  );

  const failures = collectFailures(input.metrics, {
    thrown: input.thrown === true,
    stopReason,
  });

  const transitions = input.documentTransitions ?? [];
  const initialDocumentId = input.initialDocumentId ?? undefined;
  const finalDocumentId =
    input.finalDocumentId ??
    (transitions.length > 0
      ? transitions[transitions.length - 1]!.toDocumentId
      : initialDocumentId);
  const initialVersionId = input.initialVersionId ?? undefined;
  const finalVersionId =
    input.finalVersionId ??
    (advances.length > 0
      ? advances[advances.length - 1]!.toVersionId
      : initialVersionId);

  const estimatedCostUsd = estimateModelCostUsd(
    input.metrics.usage,
    input.pricing,
    input.pricingProvider,
    input.model,
  );

  const hasDocumentFacts =
    initialDocumentId !== undefined ||
    finalDocumentId !== undefined ||
    initialVersionId !== undefined ||
    finalVersionId !== undefined ||
    advances.length > 0 ||
    transitions.length > 0;

  return {
    runId: input.runId,
    instruction: input.instruction,
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    outcome,
    ...(stopReason !== undefined ? { stopReason } : {}),
    startedAtMs: input.metrics.startedAtMs,
    completedAtMs: input.metrics.completedAtMs,
    totalDurationMs: input.metrics.completedAtMs - input.metrics.startedAtMs,
    modelTurns: input.metrics.modelTurns.length,
    modelTimeMs,
    toolCalls: input.metrics.toolCalls.length,
    toolTimeMs,
    tools: input.metrics.toolCalls.map((call) => ({
      sequence: call.sequence,
      turn: call.turn,
      name: call.toolName,
      kind: call.kind,
      durationMs: call.durationMs,
      outcome: call.outcome,
      ...(call.failureCode !== undefined
        ? { failureCode: call.failureCode }
        : {}),
    })),
    usage: { ...input.metrics.usage },
    ...(estimatedCostUsd !== undefined ? { estimatedCostUsd } : {}),
    failures,
    fuseEvents: input.metrics.fuseEvents,
    ...(hasDocumentFacts
      ? {
          document: {
            ...(initialDocumentId !== undefined
              ? { initialDocumentId }
              : {}),
            ...(finalDocumentId !== undefined ? { finalDocumentId } : {}),
            ...(initialVersionId !== undefined
              ? { initialVersionId }
              : {}),
            ...(finalVersionId !== undefined ? { finalVersionId } : {}),
            versionAdvances: advances,
            transitions,
          },
        }
      : {}),
    ...(input.retrieval !== undefined ? { retrieval: input.retrieval } : {}),
    ...(input.context !== undefined ? { context: input.context } : {}),
  };
}

function collectFailures(
  metrics: AgentRunMetrics,
  opts: {
    readonly thrown: boolean;
    readonly stopReason: string | undefined;
  },
): AgentRunReportFailure[] {
  const failures: AgentRunReportFailure[] = [];

  for (const call of metrics.toolCalls) {
    if (call.outcome === "failure") {
      failures.push({
        source: "tool",
        ...(call.failureCode !== undefined ? { code: call.failureCode } : {}),
        toolName: call.toolName,
      });
    }
  }

  if (opts.thrown && opts.stopReason === "model_error") {
    failures.push({ source: "model", code: "MODEL_ERROR" });
  } else if (
    opts.stopReason === "max_turns" ||
    opts.stopReason === "deadline"
  ) {
    failures.push({
      source: "runtime",
      code: opts.stopReason === "max_turns" ? "AGENT_MAX_TURNS" : "AGENT_DEADLINE",
    });
  }

  return failures;
}

/** Resolve metrics from a normal result or a thrown error. */
export function resolveRunMetrics(input: {
  readonly metrics?: AgentRunMetrics;
  readonly error?: unknown;
}): AgentRunMetrics | undefined {
  if (input.metrics) return input.metrics;
  if (input.error !== undefined) return getRunMetricsFromError(input.error);
  return undefined;
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

function formatUsd(value: number): string {
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(0, 8) : id;
}

function padLabel(label: string, width = 13): string {
  return label.padEnd(width);
}

/**
 * Compact human-readable summary for server-side dogfooding logs.
 */
export function formatAgentRunSummary(report: AgentRunReport): string {
  const modelLabel =
    report.provider && report.model
      ? `${report.provider}/${report.model}`
      : report.model ?? report.provider ?? "unknown";

  const lines: string[] = [];
  lines.push(`Agent Run ${report.runId}`);
  lines.push("────────────────────────");
  lines.push(`${padLabel("Outcome")}${report.outcome}`);
  lines.push(`${padLabel("Model")}${modelLabel}`);
  lines.push(`${padLabel("Turns")}${report.modelTurns}`);
  lines.push(`${padLabel("Tool calls")}${report.toolCalls}`);

  if (report.document) {
    const initialDoc = report.document.initialDocumentId;
    const finalDoc = report.document.finalDocumentId;
    if (initialDoc && finalDoc && initialDoc !== finalDoc) {
      lines.push(
        `${padLabel("Document")}${shortId(initialDoc)} → ${shortId(finalDoc)}`,
      );
    } else if (finalDoc) {
      lines.push(`${padLabel("Document")}${shortId(finalDoc)}`);
    }

    const lastTransition =
      report.document.transitions[report.document.transitions.length - 1];
    if (lastTransition) {
      lines.push(`${padLabel("Transition")}${lastTransition.kind}`);
    }

    const initial = report.document.initialVersionId;
    const final = report.document.finalVersionId;
    if (initial && final && initial !== final) {
      lines.push(
        `${padLabel("Versions")}${shortId(initial)} → ${shortId(final)}`,
      );
    } else if (final) {
      lines.push(`${padLabel("Versions")}${shortId(final)} (unchanged)`);
    } else if (!lastTransition) {
      lines.push(`${padLabel("Versions")}none`);
    }
  } else {
    lines.push(`${padLabel("Versions")}none`);
  }

  lines.push("");
  lines.push("Tool sequence");
  if (report.tools.length === 0) {
    lines.push("(none)");
  } else {
    for (const tool of report.tools) {
      const seq = `${tool.sequence}.`.padEnd(4);
      const name = tool.name.padEnd(28);
      const dur = `${tool.durationMs} ms`.padStart(8);
      const fail =
        tool.failureCode !== undefined ? `  ${tool.failureCode}` : "";
      lines.push(`${seq}${name}${dur}   ${tool.outcome}${fail}`);
    }
  }

  lines.push("");
  lines.push(`${padLabel("Model time")}${formatMs(report.modelTimeMs)}`);
  lines.push(`${padLabel("Tool time")}${formatMs(report.toolTimeMs)}`);
  lines.push(`${padLabel("Total")}${formatMs(report.totalDurationMs)}`);
  lines.push("");
  lines.push("Tokens");
  lines.push(
    `${padLabel("input")}${report.usage.inputTokens.toLocaleString("en-US")}`,
  );
  lines.push(
    `${padLabel("cached")}${report.usage.cachedInputTokens.toLocaleString("en-US")}`,
  );
  lines.push(
    `${padLabel("output")}${report.usage.outputTokens.toLocaleString("en-US")}`,
  );
  lines.push("");
  lines.push(
    `${padLabel("Est. cost")}${
      report.estimatedCostUsd !== undefined
        ? formatUsd(report.estimatedCostUsd)
        : "n/a"
    }`,
  );
  lines.push(`${padLabel("Failures")}${report.failures.length}`);
  lines.push(`${padLabel("Fuse events")}${report.fuseEvents.length}`);
  if (report.stopReason) {
    lines.push(`${padLabel("Stop")}${report.stopReason}`);
  }

  return lines.join("\n");
}

/** Log structured report + compact summary via existing console logger. */
export function logAgentRunReport(report: AgentRunReport): void {
  const summary = formatAgentRunSummary(report);
  console.info(`[agent-run-report]\n${summary}`);
  console.info(
    `[agent-run-report:json] ${JSON.stringify({
      runId: report.runId,
      outcome: report.outcome,
      stopReason: report.stopReason,
      modelTurns: report.modelTurns,
      toolCalls: report.toolCalls,
      modelTimeMs: report.modelTimeMs,
      toolTimeMs: report.toolTimeMs,
      totalDurationMs: report.totalDurationMs,
      usage: report.usage,
      estimatedCostUsd: report.estimatedCostUsd,
      failures: report.failures,
      fuseEvents: report.fuseEvents,
      document: report.document,
      retrieval: report.retrieval,
      context: report.context,
      tools: report.tools,
    })}`,
  );
}
