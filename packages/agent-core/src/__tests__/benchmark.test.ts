import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBenchmarkRecord,
  formatBenchmarkSummaryRow,
  type AgentEvent,
  type AgentResult,
} from "../index.js";

test("buildBenchmarkRecord aggregates model/tool metrics from Efficiency v1 events", () => {
  const events: AgentEvent[] = [
    {
      type: "model.turn.metrics",
      runId: "r1",
      turnId: "t0",
      turnIndex: 0,
      at: "2026-01-01T00:00:00.000Z",
      provider: "openrouter",
      modelId: "test/model",
      modelWallMs: 1200,
      timeToFirstTokenMs: 200,
      inputTokens: 100,
      cachedInputTokens: 10,
      outputTokens: 40,
      toolCallCount: 1,
      toolArgumentBytes: 50,
      contextMessageBytes: 2000,
      toolCatalogBytes: 8000,
      finishReason: "tool_calls",
    },
    {
      type: "tool.execution.metrics",
      runId: "r1",
      toolCallId: "c1",
      toolName: "document.inspect",
      at: "2026-01-01T00:00:01.000Z",
      wallMs: 15,
      inputBytes: 20,
      resultBytes: 400,
      success: true,
    },
    {
      type: "model.turn.metrics",
      runId: "r1",
      turnId: "t1",
      turnIndex: 1,
      at: "2026-01-01T00:00:02.000Z",
      modelWallMs: 800,
      inputTokens: 150,
      outputTokens: 30,
      toolCallCount: 0,
      toolArgumentBytes: 0,
      contextMessageBytes: 2500,
      toolCatalogBytes: 8000,
      finishReason: "stop",
    },
    {
      type: "document.version.advanced",
      runId: "r1",
      documentId: "d1",
      versionId: "v2",
      versionNumber: 2,
      baseVersionId: "v1",
      at: "2026-01-01T00:00:01.500Z",
    },
  ];

  const result: AgentResult = {
    status: "completed",
    summary: "The second paragraph says hello.",
    diagnostics: [],
    toolOutcomes: [
      {
        toolCallId: "c1",
        toolName: "document.inspect",
        status: "succeeded",
      },
    ],
  };

  const record = buildBenchmarkRecord({
    scenario: "simple-read",
    provider: "openrouter",
    model: "test/model",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:03.000Z",
    totalWallMs: 2100,
    events,
    result,
    correctnessOk: true,
    totalPersistMs: 2,
  });

  assert.equal(record.success, true);
  assert.equal(record.modelTurns, 2);
  assert.equal(record.toolCalls, 1);
  assert.equal(record.versionsCreated, 1);
  assert.equal(record.aggregate.totalModelMs, 2000);
  assert.equal(record.aggregate.totalToolMs, 15);
  assert.equal(record.aggregate.totalPersistMs, 2);
  assert.equal(record.aggregate.inputTokens, 250);
  assert.equal(record.aggregate.outputTokens, 70);
  assert.equal(record.aggregate.maxContextBytes, 2500);
  assert.equal(record.turns[0]?.timeToFirstTokenMs, 200);
  assert.match(formatBenchmarkSummaryRow(record), /simple-read/);
});

test("buildBenchmarkRecord surfaces correctness failure without hiding it", () => {
  const result: AgentResult = {
    status: "completed",
    summary: "ok",
    diagnostics: [],
    toolOutcomes: [],
  };
  const record = buildBenchmarkRecord({
    scenario: "simple-edit",
    provider: "openai",
    model: "gpt",
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:00:01.000Z",
    totalWallMs: 100,
    events: [],
    result,
    correctnessOk: false,
    correctnessNotes: ["expected set_paragraph_style"],
  });
  assert.equal(record.success, false);
  assert.deepEqual(record.correctnessNotes, ["expected set_paragraph_style"]);
});
