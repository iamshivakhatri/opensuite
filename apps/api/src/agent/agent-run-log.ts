/**
 * Short human-readable agent run logs for local dogfooding.
 * Formatting only — does not own accounting.
 */

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

function info(line: string): void {
  console.info(line);
}

/** Pre-model retrieval / working-set banner. */
export function formatAgentRunBanner(input: {
  readonly runId: string;
  readonly model: string;
  readonly target?: string;
  readonly sources?: readonly string[];
  readonly retrievalMode?: string;
  readonly documentCount?: number;
  readonly contextTokens?: number;
}): string {
  const mode = (input.retrievalMode ?? "skipped").toUpperCase();
  const docs = input.documentCount ?? 0;
  const ctx =
    input.contextTokens !== undefined
      ? ` · ~${formatCompactTokens(input.contextTokens)} ctx`
      : "";
  const lines = [
    `[agent] RETRIEVAL ${mode} · ${docs} doc${docs === 1 ? "" : "s"}${ctx}`,
    `  model=${input.model}`,
  ];
  if (input.target) {
    lines.push(`  target=${sanitizeLogName(input.target)}`);
  }
  if (input.sources && input.sources.length > 0) {
    const shown = input.sources.slice(0, 3).map(sanitizeLogName);
    const more = input.sources.length > 3 ? ` +${input.sources.length - 3}` : "";
    lines.push(`  sources=${shown.join(", ")}${more}`);
  } else if (input.target) {
    lines.push("  sources=none");
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

export function formatModelTurnStarted(input: {
  readonly turn: number;
  readonly model: string;
}): string {
  return `[agent] TURN ${input.turn}\n  → LLM start\n  model=${input.model}`;
}

export function formatModelTurnFirstOutput(input: {
  readonly turn: number;
  readonly elapsedMs: number;
}): string {
  return (
    `[agent] TURN ${input.turn}\n` +
    `  … first ${formatCompactDuration(input.elapsedMs)} streaming`
  );
}

export function formatModelTurnCompleted(input: {
  readonly turn: number;
  readonly durationMs: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly toolNames: readonly string[];
  readonly sawFirstOutput?: boolean;
}): string {
  const tools = input.toolNames.filter((name) => name !== "finish");
  const lines = [
    `[agent] TURN ${input.turn}`,
    `  ← LLM done ${formatCompactDuration(input.durationMs)}`,
    `  input=${formatCompactTokens(input.inputTokens)}` +
      ` cached=${formatCompactTokens(input.cachedInputTokens)}`,
    `  output=${formatCompactTokens(input.outputTokens)}` +
      (input.reasoningTokens > 0
        ? ` reasoning=${formatCompactTokens(input.reasoningTokens)}`
        : ""),
  ];
  if (tools.length === 0) {
    lines.push(
      input.toolNames.includes("finish")
        ? "  tools=0 finish"
        : "  tools=0 (none)",
    );
  } else {
    const shown = tools.slice(0, 4);
    const more = tools.length > 4 ? ` +${tools.length - 4}` : "";
    lines.push(`  tools=${tools.length} [${shown.join(", ")}${more}]`);
  }
  if (input.sawFirstOutput === false) {
    lines.push("  streaming=no");
  }
  return lines.join("\n");
}

/** @deprecated Prefer single-line formatToolFinished; kept for call-site clarity. */
export function formatToolStarted(toolName: string): string {
  return `[agent] TOOL ${toolName} →`;
}

export function formatToolFinished(input: {
  readonly toolName: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly code?: string;
  readonly skipped?: boolean;
}): string {
  const dur = formatCompactDuration(input.durationMs);
  if (input.skipped) {
    return `[agent] TOOL ${input.toolName} – ${input.code ?? "SKIPPED"} ${dur}`;
  }
  if (input.ok) {
    return `[agent] TOOL ${input.toolName} ✓ ${dur}`;
  }
  return `[agent] TOOL ${input.toolName} ✗ ${input.code ?? "TOOL_FAILED"} ${dur}`;
}

export function formatMutationsApplied(count: number): string {
  return `[agent] EDITS ${count}`;
}

export function formatDocumentSaved(name: string, versionNumber: number): string {
  return `[agent] SAVE ${sanitizeLogName(name)} → v${versionNumber}`;
}

export function formatDocumentTarget(name: string): string {
  return `[agent] TARGET ${sanitizeLogName(name)}`;
}

export function formatValidationChecks(
  checks: readonly { readonly id?: string; readonly status: string; readonly message: string }[],
): string {
  const parts = checks.map((check) => {
    const mark =
      check.status === "pass"
        ? "✓"
        : check.status === "warning"
          ? "⚠"
          : check.status === "skipped"
            ? "–"
            : "✗";
    const label =
      check.id ??
      (check.message.length > 0
        ? check.message.split(/\s+/)[0]?.toLowerCase() ?? "check"
        : "check");
    return `${mark} ${label}`;
  });
  return `[agent] VALIDATION ${parts.join(" ")}`;
}

export function formatAgentRunDone(input: {
  readonly outcome: "success" | "failure" | "partial" | "cancelled";
  readonly totalDurationMs: number;
  readonly modelTimeMs: number;
  readonly toolTimeMs: number;
  readonly modelTurns: number;
  readonly toolCalls: number;
  readonly toolErrors?: number;
  readonly persistedVersions: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly stopReason?: string;
}): string {
  const lines = [
    `[agent] DONE ${formatCompactDuration(input.totalDurationMs)}`,
    `  model=${formatCompactDuration(input.modelTimeMs)}` +
      ` tools=${formatCompactDuration(input.toolTimeMs)}`,
    `  turns=${input.modelTurns}` +
      ` toolCalls=${input.toolCalls}` +
      ` errors=${input.toolErrors ?? 0}` +
      ` versions=${input.persistedVersions}`,
  ];
  if (
    input.inputTokens !== undefined ||
    input.cachedInputTokens !== undefined ||
    input.outputTokens !== undefined ||
    input.costUsd !== undefined
  ) {
    const bits: string[] = [];
    if (input.inputTokens !== undefined) {
      bits.push(`input=${formatCompactTokens(input.inputTokens)}`);
    }
    if (input.cachedInputTokens !== undefined) {
      bits.push(`cached=${formatCompactTokens(input.cachedInputTokens)}`);
    }
    if (input.outputTokens !== undefined) {
      bits.push(`output=${formatCompactTokens(input.outputTokens)}`);
    }
    if (input.costUsd !== undefined) {
      bits.push(`cost=${formatCompactUsd(input.costUsd)}`);
    }
    lines.push(`  ${bits.join(" ")}`);
  }
  if (input.outcome !== "success" && input.stopReason) {
    lines.push(`  stop=${input.stopReason} outcome=${input.outcome}`);
  } else if (input.outcome !== "success") {
    lines.push(`  outcome=${input.outcome}`);
  }
  return lines.join("\n");
}

export function logAgentLine(message: string): void {
  info(message);
}
