import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentRunMetrics } from "@opensuite/agent-core";

import {
  composeAgentRunReport,
  countToolErrors,
  countToolsByKind,
  deriveRunOutcome,
  editsAppliedCount,
  estimateModelCostUsd,
  formatAgentRunSummary,
  logAgentRunReport,
  persistedVersionCount,
  unrecoveredFailedMutateToolNames,
} from "./agent-run-report.js";
import { mutationEffectKeys } from "./document-tools.js";
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
  assert.equal(
    deriveRunOutcome({
      versionAdvanceCount: 1,
      unrecoveredFailedMutates: 1,
    }),
    "partial",
  );
  assert.equal(
    deriveRunOutcome({
      versionAdvanceCount: 0,
      unrecoveredFailedMutates: 1,
    }),
    "failure",
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
    workingMutationCount: 5,
    versionAdvances: [
      { fromVersionId: "ver-1", toVersionId: "ver-2" },
    ],
    engine: {
      engineVersion: "0.1.4",
      capabilityFingerprint: ["inspect", "set_table_cells_text"],
    },
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
  assert.equal(report.document?.workingMutationCount, 5);
  assert.equal(report.engine?.engineVersion, "0.1.4");
  assert.deepEqual(report.engine?.capabilityFingerprint, ["inspect", "set_table_cells_text"]);
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

test("run report logs a short DONE block by default and keeps full JSON opt-in", () => {
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
  const previousVerbose = process.env.AGENT_RUN_REPORT_VERBOSE;
  console.info = (message?: unknown) => messages.push(String(message));
  try {
    process.env.AGENT_RUN_REPORT_VERBOSE = "0";
    logAgentRunReport(report);
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? "", /^\[agent\] DONE /);
    assert.match(messages[0] ?? "", /turns=1/);
    assert.match(messages[0] ?? "", /toolCalls=2/);
    assert.match(messages[0] ?? "", /versions=0/);
    assert.doesNotMatch(messages[0] ?? "", /\[agent-run-report\]/);
    process.env.AGENT_RUN_REPORT_VERBOSE = "1";
    logAgentRunReport(report);
  } finally {
    if (previousVerbose === undefined) delete process.env.AGENT_RUN_REPORT_VERBOSE;
    else process.env.AGENT_RUN_REPORT_VERBOSE = previousVerbose;
    console.info = original;
  }
  assert.match(messages[1] ?? "", /^\[agent\] DONE /);
  assert.match(messages[2] ?? "", /^\[agent-run-report\] run=run-log outcome=success/);
  assert.match(messages[2] ?? "", /toolCalls=2/);
  assert.match(messages[2] ?? "", /readCalls=1/);
  assert.match(messages[2] ?? "", /mutationCalls=1/);
  assert.match(messages[2] ?? "", /editsApplied=0/);
  assert.match(messages[2] ?? "", /persistedVersions=0/);
  assert.match(messages[2] ?? "", /toolErrors=0/);
  assert.match(messages[4] ?? "", /^\[agent-run-report:json\]\n\{/);
  assert.match(messages[4] ?? "", /\n    "availableEvidenceTokens": 18000/);
});

test("unrecovered mutate failures after a version advance are partial, not full success", () => {
  const report = composeAgentRunReport({
    runId: "run-recovered",
    instruction: "format table",
    metrics: baseMetrics({
      modelTurns: [
        {
          turn: 1,
          durationMs: 100,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
        },
        {
          turn: 2,
          durationMs: 100,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
        },
      ],
      toolCalls: [
        {
          sequence: 1,
          turn: 1,
          toolName: "document.set_paragraph_style",
          kind: "mutate",
          durationMs: 10,
          outcome: "failure",
          failureCode: "STYLE_NOT_FOUND",
          effectKeys: ["paragraph|style"],
        },
        {
          sequence: 2,
          turn: 1,
          toolName: "document.set_table_formatting",
          kind: "mutate",
          durationMs: 10,
          outcome: "failure",
          failureCode: "TABLE_NOT_FOUND",
        },
        {
          sequence: 3,
          turn: 2,
          toolName: "document.set_paragraph_style",
          kind: "mutate",
          durationMs: 20,
          outcome: "success",
          effectKeys: ["paragraph|style"],
        },
      ],
      usage: {
        inputTokens: 20,
        cachedInputTokens: 0,
        outputTokens: 10,
        reasoningTokens: 0,
      },
      stopReason: "finish_tool",
    }),
    stopReason: "finish_tool",
    workingMutationCount: 3,
    versionAdvances: [{ fromVersionId: "v1", toVersionId: "v2" }],
  });

  assert.equal(report.outcome, "partial");
  assert.equal(report.toolCalls, 3);
  assert.equal(countToolsByKind(report.tools, "mutate"), 3);
  assert.equal(countToolsByKind(report.tools, "read"), 0);
  assert.equal(editsAppliedCount(report), 3);
  assert.equal(persistedVersionCount(report), 1);
  assert.equal(countToolErrors(report.failures), 2);
  assert.equal(report.failures.every((f) => f.source === "tool"), true);

  const messages: string[] = [];
  const original = console.info;
  console.info = (message?: unknown) => messages.push(String(message));
  try {
    logAgentRunReport(report);
  } finally {
    console.info = original;
  }
  assert.match(messages[0] ?? "", /outcome=partial|DONE /);
  assert.match(messages[0] ?? "", /\[agent\] DONE /);
  assert.match(messages[0] ?? "", /toolCalls=3/);
  assert.match(messages[0] ?? "", /versions=1/);
  assert.match(messages[0] ?? "", /errors=2/);
  assert.match(messages[1] ?? "", /\[agent\] TOOL-ERROR document\.set_paragraph_style STYLE_NOT_FOUND recovered/);
  assert.match(messages[2] ?? "", /\[agent\] TOOL-ERROR document\.set_table_formatting TABLE_NOT_FOUND/);
  assert.doesNotMatch(messages[2] ?? "", /recovered/);
  assert.equal(messages.some((m) => m.startsWith("[agent-run-failure]")), false);
});

test("a later success for the exact failed edit remains success", () => {
  const report = composeAgentRunReport({
    runId: "run-all-recovered",
    instruction: "format paragraph",
    metrics: baseMetrics({
      toolCalls: [
        {
          sequence: 1,
          turn: 1,
          toolName: "document.set_paragraph_style",
          kind: "mutate",
          durationMs: 10,
          outcome: "failure",
          failureCode: "STYLE_NOT_FOUND",
          effectKeys: ["paragraph|style"],
        },
        {
          sequence: 2,
          turn: 1,
          toolName: "document.set_paragraph_style",
          kind: "mutate",
          durationMs: 20,
          outcome: "success",
          effectKeys: ["paragraph|style"],
        },
      ],
      stopReason: "finish_tool",
    }),
    stopReason: "finish_tool",
    workingMutationCount: 1,
    versionAdvances: [{ fromVersionId: "v1", toVersionId: "v2" }],
  });
  assert.equal(report.outcome, "success");
});

test("terminal failure stays distinct from recovered tool errors", () => {
  const report = composeAgentRunReport({
    runId: "run-terminal",
    instruction: "keep going",
    metrics: baseMetrics({
      toolCalls: [
        {
          sequence: 1,
          turn: 1,
          toolName: "document.find",
          kind: "read",
          durationMs: 5,
          outcome: "failure",
          failureCode: "NO_ACTIVE_DOCUMENT",
        },
      ],
      stopReason: "max_turns",
    }),
    stopReason: "max_turns",
    workingMutationCount: 0,
    versionAdvances: [],
  });
  assert.equal(report.outcome, "failure");
  assert.equal(countToolErrors(report.failures), 1);
  assert.equal(report.failures.some((f) => f.source === "runtime"), true);
  assert.equal(editsAppliedCount(report), 0);
  assert.equal(persistedVersionCount(report), 0);
});

test("read + mutation counts follow tool kind; batch edits can exceed mutation calls", () => {
  const report = composeAgentRunReport({
    runId: "run-batch",
    instruction: "rewrite",
    metrics: baseMetrics({
      toolCalls: [
        {
          sequence: 1,
          turn: 1,
          toolName: "document.inspect",
          kind: "read",
          durationMs: 5,
          outcome: "success",
        },
        {
          sequence: 2,
          turn: 1,
          toolName: "document.find",
          kind: "read",
          durationMs: 5,
          outcome: "success",
        },
        {
          sequence: 3,
          turn: 1,
          toolName: "document.replace_texts",
          kind: "mutate",
          durationMs: 40,
          outcome: "success",
        },
      ],
    }),
    stopReason: "finish_tool",
    workingMutationCount: 7,
    versionAdvances: [{ fromVersionId: "v1", toVersionId: "v2" }],
  });
  assert.equal(report.toolCalls, 3);
  assert.equal(countToolsByKind(report.tools, "read"), 2);
  assert.equal(countToolsByKind(report.tools, "mutate"), 1);
  assert.equal(editsAppliedCount(report), 7);
  assert.notEqual(editsAppliedCount(report), countToolsByKind(report.tools, "mutate"));
  assert.equal(persistedVersionCount(report), 1);
});

test("read-only run reports zero edits and zero persisted versions", () => {
  const report = composeAgentRunReport({
    runId: "run-readonly",
    instruction: "summarize",
    metrics: baseMetrics({
      toolCalls: [
        {
          sequence: 1,
          turn: 1,
          toolName: "document.inspect",
          kind: "read",
          durationMs: 8,
          outcome: "success",
        },
      ],
    }),
    stopReason: "finish_tool",
    initialVersionId: "v1",
    finalVersionId: "v1",
    workingMutationCount: 0,
    versionAdvances: [],
  });
  assert.equal(report.outcome, "success");
  assert.equal(countToolsByKind(report.tools, "read"), 1);
  assert.equal(countToolsByKind(report.tools, "mutate"), 0);
  assert.equal(editsAppliedCount(report), 0);
  assert.equal(persistedVersionCount(report), 0);
  assert.equal(countToolErrors(report.failures), 0);
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

test("failed mutate work needs a later success for the exact target and change", () => {
  const cell = (row: string, replacement: string) => ({
    table: { headerCells: ["Name", "Role"] },
    updates: [{ target: { row: { kind: "label", text: row }, column: { kind: "header", text: "Role" } }, expectedCurrentText: "x", replacement }],
  });
  const call = (sequence: number, outcome: "success" | "failure", input: unknown, toolName = "document.set_table_cells_text") => ({
    sequence, turn: sequence, toolName, kind: "mutate" as const, durationMs: 1, outcome, effectKeys: mutationEffectKeys(input, undefined),
  });
  const unrecovered = (...toolCalls: ReturnType<typeof call>[]) => unrecoveredFailedMutateToolNames(baseMetrics({ toolCalls }));

  assert.deepEqual(unrecovered(call(1, "failure", cell("Sam", "CFO")), call(2, "success", cell("Ada", "Founder"))), ["document.set_table_cells_text"]);
  assert.deepEqual(unrecovered(call(1, "failure", cell("Sam", "CFO")), call(2, "success", cell("Sam", "CFO"))), []);
  assert.deepEqual(unrecovered(call(1, "failure", cell("Sam", "CFO")), call(2, "success", cell("Ada", "CFO"))), ["document.set_table_cells_text"]);
  assert.deepEqual(unrecovered(call(1, "failure", cell("Ada", "Founder")), call(2, "success", cell("Ada", "Owner"))), ["document.set_table_cells_text"]);
  // A corrected selector alone does not prove the original edit was completed.
  const replace = (text: string) => ({ target: { text }, expectedCurrentText: text, replacement: "Team list" });
  assert.deepEqual(unrecovered(call(1, "failure", replace("Team rostr"), "document.replace_text"), call(2, "success", replace("Team roster"), "document.replace_text")), ["document.replace_text"]);
  // One success cannot recover two different failed cells.
  const bold = (rows: string[]) => ({ table: { headerCells: ["Name"] }, updates: rows.map((text) => ({ target: { row: { kind: "label", text } }, textFormatting: { bold: true } })) });
  assert.deepEqual(unrecovered(call(1, "failure", bold(["Sam", "Ada"]), "document.set_table_cells_formatting"), call(2, "success", bold(["Ada"]), "document.set_table_cells_formatting")), ["document.set_table_cells_formatting"]);
  assert.deepEqual(unrecovered(call(1, "failure", bold(["Sam"]), "document.set_table_cells_formatting"), call(2, "success", bold(["Ada"]), "document.set_table_cells_formatting")), ["document.set_table_cells_formatting"]);
  // An earlier success cannot prove the state after a later failure.
  assert.deepEqual(unrecovered(call(1, "success", cell("Ada", "Founder")), call(2, "failure", cell("Ada", "Founder"))), ["document.set_table_cells_text"]);
  // Handles identify distinct objects; unknown work cannot be matched by name.
  assert.deepEqual(unrecovered(call(1, "failure", { handle: "h1" }, "document.delete_picture"), call(2, "success", { handle: "h2" }, "document.delete_picture")), ["document.delete_picture"]);
  assert.deepEqual(unrecovered(call(1, "failure", { handle: "h1" }, "document.delete_picture"), call(2, "success", { handle: "h1" }, "document.delete_picture")), []);
  assert.deepEqual(unrecoveredFailedMutateToolNames(baseMetrics({ toolCalls: [
    { sequence: 1, turn: 1, toolName: "image.insert", kind: "mutate", durationMs: 1, outcome: "failure" },
    { sequence: 2, turn: 2, toolName: "image.insert", kind: "mutate", durationMs: 1, outcome: "success" },
  ] })), ["image.insert"]);
});

test("edit identities preserve case, spacing, and nested handles", () => {
  const replace = (replacement: string) => ({ target: { text: "Company" }, expectedCurrentText: "Company", replacement });
  for (const replacement of ["COMPANY", "Company ", "Company  name", "company"]) {
    assert.notDeepEqual(mutationEffectKeys(replace("Company"), undefined), mutationEffectKeys(replace(replacement), undefined));
  }
  assert.notDeepEqual(mutationEffectKeys({ target: { handle: "cell-1" }, replacement: "CEO" }, undefined), mutationEffectKeys({ target: { handle: "cell-2" }, replacement: "CEO" }, undefined));
  assert.deepEqual(mutationEffectKeys(replace("Name"), undefined), mutationEffectKeys({ replacement: "Name", expectedCurrentText: "Updated guard", target: { text: "Company" } }, undefined));
  assert.notDeepEqual(mutationEffectKeys(replace("Name"), undefined, "doc-1"), mutationEffectKeys(replace("Name"), undefined, "doc-2"));
});

test("a failed batch requires all remaining edits to succeed without relying on missing identities", () => {
  const operations = ["A", "B", "C"].map((text) => ({ target: { text }, replacement: `${text} updated` }));
  const failed = { sequence: 1, turn: 1, toolName: "document.batch_replace_text", kind: "mutate" as const, durationMs: 0, outcome: "failure" as const, effectKeys: mutationEffectKeys({ operations }, { ok: false, failedIndex: 1 }) };
  const success = { sequence: 2, turn: 2, toolName: failed.toolName, kind: failed.kind, durationMs: 0, outcome: "success" as const, effectKeys: mutationEffectKeys({ operations: operations.slice(1) }, { ok: true }) };
  assert.deepEqual(unrecoveredFailedMutateToolNames(baseMetrics({ toolCalls: [failed, success] })), []);
  assert.deepEqual(unrecoveredFailedMutateToolNames(baseMetrics({ toolCalls: [failed, { ...success, effectKeys: mutationEffectKeys({ operations: operations.slice(2) }, { ok: true }) }] })), [failed.toolName]);
  assert.deepEqual(unrecoveredFailedMutateToolNames(baseMetrics({ toolCalls: [failed, { ...success, effectKeys: undefined }] })), [failed.toolName]);
});
