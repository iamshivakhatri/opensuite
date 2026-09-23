import assert from "node:assert/strict";
import { test } from "node:test";

import { openRouterCostUsd } from "./model.js";
import { RunMetricsCollector } from "./run-metrics.js";

test("openRouterCostUsd reads OpenRouter usage.cost and ignores invalid values", () => {
  assert.equal(
    openRouterCostUsd({
      openrouter: { usage: { cost: 0.000013244, promptTokens: 88 } },
    }),
    0.000013244,
  );
  assert.equal(openRouterCostUsd({ openrouter: { usage: { cost: -1 } } }), undefined);
  assert.equal(openRouterCostUsd({ openrouter: { usage: {} } }), undefined);
  assert.equal(openRouterCostUsd(undefined), undefined);
  assert.equal(openRouterCostUsd(null), undefined);
});

test("usage aggregates reasoning tokens and provider cost across turns", () => {
  const collector = new RunMetricsCollector(() => 0);
  collector.recordModelTurn({
    turn: 1,
    durationMs: 10,
    inputTokens: 88,
    cachedInputTokens: 0,
    outputTokens: 18,
    reasoningTokens: 16,
    providerReportedCostUsd: 0.001,
  });
  collector.recordModelTurn({
    turn: 2,
    durationMs: 10,
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 20,
    reasoningTokens: 4,
    providerReportedCostUsd: 0.002,
  });
  const metrics = collector.finish("completed");
  assert.deepEqual(metrics.usage, {
    inputTokens: 188,
    cachedInputTokens: 40,
    outputTokens: 38,
    reasoningTokens: 20,
    providerReportedCostUsd: 0.003,
  });
});

test("usage stays without provider cost when no turn reported one", () => {
  const collector = new RunMetricsCollector(() => 0);
  collector.recordModelTurn({
    turn: 1,
    durationMs: 1,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 2,
    reasoningTokens: 0,
  });
  const metrics = collector.finish("completed");
  assert.equal(metrics.usage.providerReportedCostUsd, undefined);
  assert.equal(metrics.usage.reasoningTokens, 0);
});
