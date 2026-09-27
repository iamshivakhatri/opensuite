/**
 * Short human-readable agent run logs for local dogfooding.
 * Formatting only — does not own accounting.
 */

const RULE = "────────────────────────────────────────";

export function formatCompactTokens(n: number): string {
  if (n >= 1000) {
    const rounded = Math.round((n / 1000) * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded}k` : `${rounded.toFixed(1)}k`;
  }
  return String(Math.round(n));
}

export function formatCompactDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export function formatCompactUsd(value: number): string {
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(6)}`;
}

export function sanitizeLogName(name: string): string {
  return name.replace(/[\r\n\t\x00-\x1f]/g, " ").slice(0, 80);
}

function pad(label: string, width = 11): string {
  return label.padEnd(width);
}

function info(line: string): void {
  console.info(line);
}

export function formatAgentRunBanner(input: {
  readonly runId: string;
  readonly model: string;
  readonly target?: string;
  readonly sources?: readonly string[];
  readonly retrievalMode?: string;
  readonly documentCount?: number;
  readonly contextTokens?: number;
}): string {
  const runShort = input.runId.length > 12 ? input.runId.slice(0, 8) : input.runId;
  const lines = [RULE, `AGENT RUN ${runShort}`, RULE, `${pad("Model")}${input.model}`];
  if (input.target) lines.push(`${pad("Target")}${sanitizeLogName(input.target)}`);
  if (input.sources && input.sources.length > 0) {
    const shown = input.sources.slice(0, 3).map(sanitizeLogName);
    const more = input.sources.length > 3 ? ` +${input.sources.length - 3} more` : "";
    lines.push(`${pad("Sources")}${shown.join(", ")}${more}`);
  } else if (input.target) {
    lines.push(`${pad("Sources")}none`);
  }
  if (input.retrievalMode) {
    const docs = input.documentCount ?? 0;
    const ctx =
      input.contextTokens !== undefined
        ? ` · ~${formatCompactTokens(input.contextTokens)} context tokens`
        : "";
    lines.push(
      `${pad("Retrieval")}${input.retrievalMode.toUpperCase()} · ${docs} doc${docs === 1 ? "" : "s"}${ctx}`,
    );
  }
  return lines.join("\n");
}

export function logAgentRunBanner(input: {
  readonly runId: string;
  readonly model: string;
  readonly target?: string;
  readonly sources?: readonly string[];
  readonly retrievalMode?: string;
  readonly documentCount?: number;
  readonly contextTokens?: number;
}): void {
  info(formatAgentRunBanner(input));
}

export function formatModelTurnStarted(turn: number): string {
  return `[Turn ${turn}]\n→ LLM call started`;
}

export function formatModelTurnFirstOutput(elapsedMs: number): string {
  return `  first output ${formatCompactDuration(elapsedMs)}`;
}

export function formatModelTurnCompleted(input: {
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly toolNames: readonly string[];
}): string {
  const lines = [
    `← LLM responded ${formatCompactDuration(input.durationMs)}`,
    `  input ${formatCompactTokens(input.inputTokens)}` +
      ` · cached ${formatCompactTokens(input.cachedInputTokens)}` +
      ` · output ${formatCompactTokens(input.outputTokens)}` +
      (input.reasoningTokens > 0
        ? ` · reasoning ${formatCompactTokens(input.reasoningTokens)}`
        : ""),
  ];
  const tools = input.toolNames.filter((name) => name !== "finish");
  if (tools.length === 0) {
    lines.push(
      input.toolNames.includes("finish")
        ? "  finish · turn complete"
        : "  no tools · turn complete",
    );
  } else {
    lines.push(
      `  requested ${tools.length} tool${tools.length === 1 ? "" : "s"}` +
        (tools.length <= 3 ? `: ${tools.join(", ")}` : ""),
    );
  }
  return lines.join("\n");
}

export function formatToolStarted(toolName: string): string {
  return `→ ${toolName}`;
}

export function formatToolFinished(input: {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly code?: string;
  readonly skipped?: boolean;
}): string {
  if (input.skipped) {
    return `– skipped ${input.code ?? "SKIPPED"} · ${formatCompactDuration(input.durationMs)}`;
  }
  if (input.ok) {
    return `✓ completed ${formatCompactDuration(input.durationMs)}`;
  }
  return `✗ ${input.code ?? "TOOL_FAILED"} · ${formatCompactDuration(input.durationMs)}`;
}

export function formatMutationsApplied(count: number): string {
  return `[Mutations]\n✓ ${count} edit${count === 1 ? "" : "s"} applied`;
}

export function formatDocumentSaved(name: string, versionNumber: number): string {
  return `[Save]\n✓ ${sanitizeLogName(name)} → v${versionNumber}`;
}

export function formatValidationChecks(
  checks: readonly { readonly status: string; readonly message: string }[],
): string {
  const lines = ["[Validation]"];
  for (const check of checks) {
    const mark =
      check.status === "pass"
        ? "✓"
        : check.status === "warning"
          ? "⚠"
          : check.status === "skipped"
            ? "–"
            : "✗";
    const text =
      check.message.length > 0
        ? check.message.charAt(0).toLowerCase() + check.message.slice(1)
        : check.message;
    lines.push(`${mark} ${text}`);
  }
  return lines.join("\n");
}

export function formatAgentRunDone(input: {
  readonly outcome: "success" | "failure" | "partial" | "cancelled";
  readonly totalDurationMs: number;
  readonly modelTimeMs: number;
  readonly toolTimeMs: number;
  readonly modelTurns: number;
  readonly toolCalls: number;
  readonly persistedVersions: number;
  readonly costUsd?: number;
  readonly stopReason?: string;
}): string {
  const mark =
    input.outcome === "success"
      ? "✓"
      : input.outcome === "cancelled"
        ? "–"
        : "✗";
  const lines = [
    RULE,
    `DONE ${mark} ${formatCompactDuration(input.totalDurationMs)}`,
    `${pad("Model")}${formatCompactDuration(input.modelTimeMs)}`,
    `${pad("Tools")}${formatCompactDuration(input.toolTimeMs)}`,
    `${pad("Turns")}${input.modelTurns}`,
    `${pad("Tool calls")}${input.toolCalls}`,
    `${pad("Versions")}${input.persistedVersions}`,
  ];
  if (input.costUsd !== undefined) {
    lines.push(`${pad("Cost")}${formatCompactUsd(input.costUsd)}`);
  }
  if (input.outcome !== "success" && input.stopReason) {
    lines.push(`${pad("Stop")}${input.stopReason}`);
  }
  lines.push(RULE);
  return lines.join("\n");
}

export function logAgentLine(message: string): void {
  info(message);
}
