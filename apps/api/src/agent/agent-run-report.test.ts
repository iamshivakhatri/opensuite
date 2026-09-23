import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentRunMetrics } from "@opensuite/agent-core-v3";

import {
  composeAgentRunReport,
  deriveRunOutcome,
  estimateModelCostUsd,
  formatAgentRunSummary,
  logAgentRunReport,
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
      reasoningTokens: 0,
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

test("composeAgentRunReport includes workspace retrieval trace without model context", () => {
  const report = composeAgentRunReport({
    runId: "run-retrieval",
    instruction: "add milestones to the table",
    metrics: baseMetrics(),
    retrieval: {
      workspaceArtifactCount: 3,
      workingSetArtifactCount: 1,
      documentMapCharacters: 80,
      contextStrategy: "hierarchical",
      availableEvidenceTokens: 18_000,
      candidateCount: 2,
      evidenceCount: 1,
      durationMs: 12,
      contextCharacters: 240,
      candidates: [{ documentId: "doc", versionId: "v1", name: "Plan.docx", format: "docx", reason: "primary" }],
    },
  });
  assert.deepEqual(report.retrieval, {
    workspaceArtifactCount: 3,
    workingSetArtifactCount: 1,
    documentMapCharacters: 80,
    contextStrategy: "hierarchical",
    availableEvidenceTokens: 18_000,
    candidateCount: 2,
    evidenceCount: 1,
    durationMs: 12,
    contextCharacters: 240,
    candidates: [{ documentId: "doc", versionId: "v1", name: "Plan.docx", format: "docx", reason: "primary" }],
  });
});

test("run report JSON is multiline and includes the evidence budget", () => {
  const report = composeAgentRunReport({
    runId: "run-log",
    instruction: "test",
    metrics: baseMetrics(),
    retrieval: {
      workspaceArtifactCount: 1,
      workingSetArtifactCount: 1,
      documentMapCharacters: 20,
      contextStrategy: "hierarchical",
      availableEvidenceTokens: 18_000,
      candidateCount: 1,
      evidenceCount: 0,
      durationMs: 1,
      contextCharacters: 20,
      candidates: [],
    },
  });
  const messages: string[] = [];
  const original = console.info;
  console.info = (message?: unknown) => messages.push(String(message));
  try {
    logAgentRunReport(report);
  } finally {
    console.info = original;
  }
  assert.match(messages[1] ?? "", /^\[agent-run-report:json\]\n\{/);
  assert.match(messages[1] ?? "", /\n    "availableEvidenceTokens": 18000/);
});

test("composeAgentRunReport includes history diagnostics without message content", () => {
  const report = composeAgentRunReport({
    runId: "run-1",
    instruction: "test",
    metrics: baseMetrics(),
    context: {
      checkpointUsed: false,
      historyQueryMode: "recent",
      historicalMessagesLoaded: 100,
      historicalMessagesAfterCheckpoint: 100,
      historicalMessagesProjected: 40,
      historicalCharactersLoaded: 50_000,
      historicalCharactersProjected: 32_000,
      estimatedHistoricalTokens: 10_667,
      historyWasTrimmed: true,
      estimatedInputTokens: 12_000,
      approximateTokenBudgetApplied: false,
      historyTrimmedByTokenBudget: false,
    },
  });
  assert.deepEqual(report.context, {
    checkpointUsed: false,
    historyQueryMode: "recent",
    historicalMessagesLoaded: 100,
    historicalMessagesAfterCheckpoint: 100,
    historicalMessagesProjected: 40,
    historicalCharactersLoaded: 50_000,
    historicalCharactersProjected: 32_000,
    estimatedHistoricalTokens: 10_667,
    historyWasTrimmed: true,
    estimatedInputTokens: 12_000,
    approximateTokenBudgetApplied: false,
    historyTrimmedByTokenBudget: false,
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
    { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100, reasoningTokens: 0 },
    openrouterInclusivePricing,
    "openrouter",
    "test/model",
  );
  assert.equal(cost, 0.00084);

  const uncachedOnly = estimateModelCostUsd(
    { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
    openrouterInclusivePricing,
    "openrouter",
    "test/model",
  );
  assert.equal(uncachedOnly, 0.001);

  assert.equal(
    estimateModelCostUsd(
      { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 },
      null,
      "openrouter",
      "test/model",
    ),
    undefined,
  );
});

test("composeAgentRunReport prefers actual provider cost over list-price estimate", () => {
  const report = composeAgentRunReport({
    runId: "run-cost",
    instruction: "test",
    provider: "openrouter",
    model: "test/model",
    metrics: baseMetrics({
      usage: {
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 10,
        reasoningTokens: 4,
        providerReportedCostUsd: 0.000013244,
      },
    }),
    pricing: openrouterInclusivePricing,
    pricingProvider: "openrouter",
  });
  assert.equal(report.actualProviderCostUsd, 0.000013244);
  assert.equal(report.usage.reasoningTokens, 4);
  assert.ok(typeof report.estimatedCostUsd === "number");
  assert.notEqual(report.actualProviderCostUsd, report.estimatedCostUsd);
  const summary = formatAgentRunSummary(report);
  assert.match(summary, /Actual cost/);
  assert.doesNotMatch(summary, /Est\. cost/);
});

test("estimated and actual token fields remain distinct in report JSON", () => {
  const report = composeAgentRunReport({
    runId: "run-tokens",
    instruction: "test",
    metrics: baseMetrics({
      usage: {
        inputTokens: 88,
        cachedInputTokens: 0,
        outputTokens: 18,
        reasoningTokens: 16,
      },
    }),
    context: {
      checkpointUsed: false,
      historyQueryMode: "recent",
      historicalMessagesLoaded: 0,
      historicalMessagesAfterCheckpoint: 0,
      historicalMessagesProjected: 0,
      historicalCharactersLoaded: 0,
      historicalCharactersProjected: 0,
      estimatedHistoricalTokens: 0,
      historyWasTrimmed: false,
      modelContextLength: 1_048_576,
      outputReserveTokens: 16_384,
      safeInputBudgetTokens: 1_027_072,
      estimatedInputTokens: 12_000,
      approximateTokenBudgetApplied: true,
      historyTrimmedByTokenBudget: false,
    },
    retrieval: {
      workspaceArtifactCount: 1,
      workingSetArtifactCount: 1,
      documentMapCharacters: 10,
      contextStrategy: "hierarchical",
      availableEvidenceTokens: 900_000,
      candidateCount: 1,
      evidenceCount: 0,
      durationMs: 1,
      contextCharacters: 10,
      candidates: [],
    },
  });
  assert.equal(report.usage.inputTokens, 88);
  assert.equal(report.context?.estimatedInputTokens, 12_000);
  assert.notEqual(report.usage.inputTokens, report.context?.estimatedInputTokens);
  assert.equal(report.retrieval?.availableEvidenceTokens, 900_000);
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
