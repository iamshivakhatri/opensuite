import type { BenchmarkRunRecord } from "@opensuite/agent-core";

function pad(value: string, width: number): string {
  if (value.length >= width) return value;
  return value + " ".repeat(width - value.length);
}

function fmtSec(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Print concise comparison table + per-turn detail. */
export function printBenchmarkReport(
  records: readonly BenchmarkRunRecord[],
): void {
  console.log("");
  console.log(
    [
      pad("Scenario", 22),
      pad("Turns", 6),
      pad("Tools", 6),
      pad("Total", 8),
      pad("Model", 8),
      pad("Tools", 8),
      pad("In tok", 8),
      pad("Out tok", 8),
      pad("Fail", 5),
      "OK",
    ].join(""),
  );
  console.log("-".repeat(90));

  for (const r of records) {
    console.log(
      [
        pad(r.scenario, 22),
        pad(String(r.modelTurns), 6),
        pad(String(r.toolCalls), 6),
        pad(fmtSec(r.totalWallMs), 8),
        pad(fmtSec(r.aggregate.totalModelMs), 8),
        pad(fmtSec(r.aggregate.totalToolMs), 8),
        pad(String(r.aggregate.inputTokens || "—"), 8),
        pad(String(r.aggregate.outputTokens || "—"), 8),
        pad(String(r.failures), 5),
        r.success ? "ok" : "FAIL",
      ].join(""),
    );
  }

  for (const r of records) {
    console.log("");
    console.log(`=== ${r.scenario} (${r.provider}/${r.model}) ===`);
    console.log(
      `status=${r.status} success=${r.success} versions=${r.versionsCreated} retries=${r.retries}`,
    );
    if (r.correctnessNotes.length > 0) {
      console.log(`correctness: ${r.correctnessNotes.join("; ")}`);
    }
    console.log(`summary: ${r.summary.slice(0, 200)}`);
    if (r.aggregate.totalPersistMs !== undefined) {
      console.log(`persist=${fmtSec(r.aggregate.totalPersistMs)}`);
    }
    for (const turn of r.turns) {
      const parts = [
        `turn ${turn.turnIndex}`,
        `wall=${fmtSec(turn.wallMs)}`,
        turn.timeToFirstTokenMs !== undefined
          ? `ttft=${fmtSec(turn.timeToFirstTokenMs)}`
          : null,
        `tools=${turn.toolCallCount}`,
        `argB=${turn.toolArgumentBytes}`,
        `ctxB=${turn.contextBytes}`,
        `schemaB=${turn.toolSchemaBytes}`,
        turn.inputTokens !== undefined ? `in=${turn.inputTokens}` : null,
        turn.cachedInputTokens !== undefined
          ? `cached=${turn.cachedInputTokens}`
          : null,
        turn.outputTokens !== undefined ? `out=${turn.outputTokens}` : null,
        turn.reasoningTokens !== undefined
          ? `reason=${turn.reasoningTokens}`
          : null,
        turn.finishReason ? `finish=${turn.finishReason}` : null,
      ].filter(Boolean);
      console.log(`  ${parts.join("  ")}`);
    }
    for (const tool of r.tools) {
      console.log(
        `  tool ${tool.toolName}  ${fmtSec(tool.wallMs)}  ${tool.success ? "ok" : "FAIL"}  inB=${tool.inputBytes}  outB=${tool.resultBytes}`,
      );
    }
  }
  console.log("");
}

/** Identify largest remaining latency bucket from a suite. */
export function identifyBottleneck(
  records: readonly BenchmarkRunRecord[],
): string {
  if (records.length === 0) return "no runs";

  let modelMs = 0;
  let toolMs = 0;
  let persistMs = 0;
  let maxArgBytes = 0;
  let maxCtxBytes = 0;
  let maxToolArgTurn: BenchmarkRunRecord["turns"][number] | null = null;

  for (const r of records) {
    modelMs += r.aggregate.totalModelMs;
    toolMs += r.aggregate.totalToolMs;
    persistMs += r.aggregate.totalPersistMs ?? 0;
    maxCtxBytes = Math.max(maxCtxBytes, r.aggregate.maxContextBytes);
    for (const turn of r.turns) {
      if (turn.toolArgumentBytes > maxArgBytes) {
        maxArgBytes = turn.toolArgumentBytes;
        maxToolArgTurn = turn;
      }
    }
  }

  const large = records.find((r) => r.scenario.includes("greenfield-large"));
  const largeAuthorTurn = large?.turns
    .slice()
    .sort((a, b) => b.toolArgumentBytes - a.toolArgumentBytes)[0];

  const lines = [
    `Suite totals: model=${fmtSec(modelMs)} tool=${fmtSec(toolMs)} persist=${fmtSec(persistMs)}`,
    `Max context bytes=${maxCtxBytes}; max tool-arg bytes=${maxArgBytes}` +
      (maxToolArgTurn
        ? ` (scenario turn ${maxToolArgTurn.turnIndex}, wall=${fmtSec(maxToolArgTurn.wallMs)})`
        : ""),
  ];

  if (largeAuthorTurn && large) {
    const ttft = largeAuthorTurn.timeToFirstTokenMs;
    const genAfterTtft =
      ttft !== undefined
        ? Math.max(0, largeAuthorTurn.wallMs - ttft)
        : undefined;
    lines.push(
      `greenfield-large heaviest turn: wall=${fmtSec(largeAuthorTurn.wallMs)}` +
        (ttft !== undefined ? ` ttft=${fmtSec(ttft)}` : " ttft=n/a") +
        (genAfterTtft !== undefined
          ? ` post-ttft=${fmtSec(genAfterTtft)}`
          : "") +
        ` argB=${largeAuthorTurn.toolArgumentBytes} outTok=${largeAuthorTurn.outputTokens ?? "n/a"}` +
        ` reasonTok=${largeAuthorTurn.reasoningTokens ?? "n/a"} ctxB=${largeAuthorTurn.contextBytes}`,
    );
  }

  if (modelMs > toolMs * 3 && modelMs > persistMs * 10) {
    if (
      maxArgBytes > 8_000 &&
      largeAuthorTurn &&
      largeAuthorTurn.wallMs > 15_000
    ) {
      lines.push(
        "Bottleneck: model/provider latency dominated by large structured tool-argument generation (not AgentRunner architecture).",
      );
    } else {
      lines.push(
        "Bottleneck: model/provider latency (waiting on complete()), not tool/engine/persistence.",
      );
    }
  } else if (toolMs > modelMs) {
    lines.push(
      "Bottleneck: tool/engine execution time exceeds model time.",
    );
  } else if (persistMs > toolMs * 0.5 && persistMs > 1000) {
    lines.push("Bottleneck: persistence time is material vs tool time.");
  } else {
    lines.push(
      "Bottleneck: mixed — see per-turn model vs tool split; no single category dominates 3×.",
    );
  }

  return lines.join("\n");
}
