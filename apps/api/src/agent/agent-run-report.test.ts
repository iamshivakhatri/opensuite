import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentRunMetrics } from "@opensuite/agent-core-v3";

import {
  composeAgentRunReport,
  deriveRunOutcome,
  estimateModelCostUsd,
  formatAgentRunSummary,
} from "./agent-run-report.js";
import type { ModelPricingEntry } from "../model-usage/pricing.js";

function baseMetrics(
  overrides: Partial<AgentRunMetrics> = {},
): AgentRunMetrics {
  return {
    startedAtMs: 1_000,
    completedAtMs: 2_000,
    modelTurns: [
      {
        turn: 1,
        durationMs: 800,
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 10,
      },
    ],
    toolCalls: [
      {
        sequence: 1,
        turn: 1,
        toolName: "document.find",
        kind: "read",
        durationMs: 40,
        outcome: "success",
      },
      {
        sequence: 2,
        turn: 1,
        toolName: "document.insert_paragraph",
        kind: "mutate",
        durationMs: 120,
        outcome: "success",
      },
    ],
    fuseEvents: [],
    usage: {
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 10,
    },
    stopReason: "finish_tool",
    ...overrides,
  };
}

const openrouterInclusivePricing: ModelPricingEntry = {
  provider: "openrouter",
  model: "test/model",
  pricingVersion: "test-v1",
  currency: "USD",
  inputMicrosPerMTok: 1_000_000, // $1 / MTok
  outputMicrosPerMTok: 2_000_000, // $2 / MTok
  cachedInputMicrosPerMTok: 100_000, // $0.10 / MTok
  cachedInputBilling: "openai_inclusive",
};

test("deriveRunOutcome: cancelled / partial / failure / success", () => {
  assert.equal(
    deriveRunOutcome({ cancelled: true, versionAdvanceCount: 0 }),
    "cancelled",
  );
  assert.equal(
    deriveRunOutcome({
      terminalFailure: true,
      versionAdvanceCount: 1,
    }),
    "partial",
  );
  assert.equal(
    deriveRunOutcome({
      terminalFailure: true,
      versionAdvanceCount: 0,
    }),
    "failure",
  );
  assert.equal(
    deriveRunOutcome({ versionAdvanceCount: 2 }),
    "success",
  );
});

test("composeAgentRunReport merges runtime metrics + document facts", () => {
  const report = composeAgentRunReport({
    runId: "run-1",
    instruction: "insert a paragraph",
    provider: "openrouter",
    model: "test/model",
    metrics: baseMetrics(),
    stopReason: "finish_tool",
    initialVersionId: "ver-1",
    versionAdvances: [
      { fromVersionId: "ver-1", toVersionId: "ver-2" },
    ],
    pricing: openrouterInclusivePricing,
    pricingProvider: "openrouter",
  });

  assert.equal(report.outcome, "success");
  assert.equal(report.modelTurns, 1);
  assert.equal(report.modelTimeMs, 800);
  assert.equal(report.toolCalls, 2);
  assert.equal(report.toolTimeMs, 160);
  assert.equal(report.totalDurationMs, 1_000);
  assert.equal(report.document?.initialVersionId, "ver-1");
  assert.equal(report.document?.finalVersionId, "ver-2");
  assert.equal(report.document?.versionAdvances.length, 1);
  assert.equal(report.tools[0]!.name, "document.find");
  assert.ok(typeof report.estimatedCostUsd === "number");
});

test("composeAgentRunReport includes retrieval observation without model context", () => {
  const report = composeAgentRunReport({
    runId: "run-retrieval",
    instruction: "add milestones to the table",
    metrics: baseMetrics(),
    retrieval: { cache: "hit", blockCount: 1, reason: "single_table" },
  });
  assert.deepEqual(report.retrieval, {
    cache: "hit",
    blockCount: 1,
    reason: "single_table",
  });
});

test("composeAgentRunReport includes history diagnostics without message content", () => {
  const report = composeAgentRunReport({
    runId: "run-1",
    instruction: "test",
    metrics: baseMetrics(),
    context: {
      checkpointUsed: false,
      historicalMessagesLoaded: 100,
      historicalMessagesAfterCheckpoint: 100,
      historicalMessagesProjected: 40,
      historicalCharactersLoaded: 50_000,
      historicalCharactersProjected: 32_000,
      historyWasTrimmed: true,
    },
  });
  assert.deepEqual(report.context, {
    checkpointUsed: false,
    historicalMessagesLoaded: 100,
    historicalMessagesAfterCheckpoint: 100,
    historicalMessagesProjected: 40,
    historicalCharactersLoaded: 50_000,
    historicalCharactersProjected: 32_000,
    historyWasTrimmed: true,
  });
});

test("composeAgentRunReport: max_turns with version advance is partial", () => {
  const report = composeAgentRunReport({
    runId: "run-2",
    instruction: "keep going",
    metrics: baseMetrics({ stopReason: "max_turns" }),
    stopReason: "max_turns",
    initialVersionId: "v1",
    versionAdvances: [{ fromVersionId: "v1", toVersionId: "v2" }],
  });
  assert.equal(report.outcome, "partial");
  assert.equal(report.failures.some((f) => f.source === "runtime"), true);
});

test("composeAgentRunReport: document transition is not a version advance", () => {
  const report = composeAgentRunReport({
    runId: "run-dup",
    instruction: "duplicate",
    metrics: baseMetrics({
      toolCalls: [
        {
          sequence: 1,
          turn: 1,
          toolName: "workspace.duplicate_current_document",
          kind: "mutate",
          durationMs: 10,
          outcome: "success",
        },
      ],
    }),
    stopReason: "finish_tool",
    initialDocumentId: "doc-a",
    finalDocumentId: "doc-b",
    initialVersionId: "ver-a1",
    finalVersionId: "ver-b1",
    versionAdvances: [],
    documentTransitions: [
      {
        kind: "duplicated",
        fromDocumentId: "doc-a",
        toDocumentId: "doc-b",
        title: "Copy.docx",
      },
    ],
  });
  assert.equal(report.document?.versionAdvances.length, 0);
  assert.equal(report.document?.transitions.length, 1);
  assert.equal(report.document?.transitions[0]!.kind, "duplicated");
  assert.equal(report.document?.initialDocumentId, "doc-a");
  assert.equal(report.document?.finalDocumentId, "doc-b");
  const summary = formatAgentRunSummary(report);
  assert.match(summary, /Transition\s+duplicated/);
  assert.match(summary, /Document\s+doc-a → doc-b/);
});

test("cost estimation: openai_inclusive does not double-count cached tokens", () => {
  // input=1000 includes 400 cached → uncached 600
  // cost = 600*$1/M + 400*$0.10/M + 100*$2/M
  //      = 0.0006 + 0.00004 + 0.0002 = 0.00084
  const cost = estimateModelCostUsd(
    { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100 },
    openrouterInclusivePricing,
    "openrouter",
    "test/model",
  );
  assert.equal(cost, 0.00084);

  const uncachedOnly = estimateModelCostUsd(
    { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 0 },
    openrouterInclusivePricing,
    "openrouter",
    "test/model",
  );
  assert.equal(uncachedOnly, 0.001);

  assert.equal(
    estimateModelCostUsd(
      { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 },
      null,
      "openrouter",
      "test/model",
    ),
    undefined,
  );
});

test("formatAgentRunSummary is compact and deterministic", () => {
  const report = composeAgentRunReport({
    runId: "01JABCDEF",
    instruction: "edit doc",
    provider: "openrouter",
    model: "test/model",
    metrics: baseMetrics(),
    stopReason: "finish_tool",
    initialVersionId: "ver-aaaa-1111",
    versionAdvances: [
      { fromVersionId: "ver-aaaa-1111", toVersionId: "ver-bbbb-2222" },
    ],
    pricing: openrouterInclusivePricing,
    pricingProvider: "openrouter",
  });
  const summary = formatAgentRunSummary(report);
  assert.match(summary, /Agent Run 01JABCDEF/);
  assert.match(summary, /Outcome\s+success/);
  assert.match(summary, /document\.find/);
  assert.match(summary, /document\.insert_paragraph/);
  assert.match(summary, /Versions\s+ver-aaaa → ver-bbbb/);
  assert.match(summary, /Fuse events\s+0/);
  assert.equal(summary, formatAgentRunSummary(report));
});
