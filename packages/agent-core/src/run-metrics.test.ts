import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RunMetricsCollector,
  attachRunMetrics,
  getRunMetricsFromError,
} from "./run-metrics.js";

function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

test("model turns and usage aggregate correctly", () => {
  const clock = fakeClock();
  const collector = new RunMetricsCollector(clock.now);
  clock.advance(10);
  collector.recordModelTurn({
    turn: 1,
    durationMs: 100,
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 10,
  });
  collector.recordModelTurn({
    turn: 2,
    durationMs: 50,
    inputTokens: 200,
    cachedInputTokens: 80,
    outputTokens: 20,
  });
  clock.advance(5);
  const metrics = collector.finish("completed");
  assert.equal(metrics.modelTurns.length, 2);
  assert.deepEqual(metrics.usage, {
    inputTokens: 300,
    cachedInputTokens: 120,
    outputTokens: 30,
    reasoningTokens: 0,
  });
  assert.equal(metrics.startedAtMs, 1_000);
  assert.equal(metrics.completedAtMs, 1_015);
  assert.equal(metrics.stopReason, "completed");
});

test("tool call sequence is stable and allocated at start", () => {
  const collector = new RunMetricsCollector(() => 0);
  const a = collector.allocToolSequence();
  const b = collector.allocToolSequence();
  const c = collector.allocToolSequence();
  assert.deepEqual([a, b, c], [1, 2, 3]);
  collector.recordToolCall({
    sequence: b,
    turn: 1,
    toolName: "beta",
    kind: "read",
    durationMs: 2,
    outcome: "success",
  });
  collector.recordToolCall({
    sequence: a,
    turn: 1,
    toolName: "alpha",
    kind: "read",
    durationMs: 5,
    outcome: "success",
  });
  collector.recordToolCall({
    sequence: c,
    turn: 1,
    toolName: "gamma",
    kind: "mutate",
    durationMs: 1,
    outcome: "success",
  });
  // Finalized metrics are sorted by sequence, not completion order.
  const metrics = collector.finish();
  assert.deepEqual(
    metrics.toolCalls.map((t) => t.toolName),
    ["alpha", "beta", "gamma"],
  );
});

test("attachRunMetrics / getRunMetricsFromError round-trip", () => {
  const collector = new RunMetricsCollector(() => 42);
  const metrics = collector.finish("cancelled");
  const error = new Error("aborted");
  attachRunMetrics(error, metrics);
  assert.equal(getRunMetricsFromError(error), metrics);
  assert.equal(getRunMetricsFromError(new Error("other")), undefined);
});
