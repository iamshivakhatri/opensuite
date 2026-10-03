import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "@opensuite/agent-core-v3";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createToolSurface } from "../../runtime/tool-surface.js";
import { calculate, createCalculatorTool } from "./calculator.js";
import { createCapabilityTelemetry, type StoredCapabilityEvent } from "../../telemetry/recorder.js";

test("calculator handles arithmetic, percentages, powers, roots, and grouping", () => {
  assert.deepEqual(calculate("17.5% of 428,000"), { ok: true, expression: "17.5% of 428,000", result: 74_900 });
  assert.deepEqual(calculate("sqrt(81) + 2^3"), { ok: true, expression: "sqrt(81) + 2^3", result: 17 });
  assert.deepEqual(calculate("(10 - 4) / 3"), { ok: true, expression: "(10 - 4) / 3", result: 2 });
  assert.deepEqual(calculate("-2^2"), { ok: true, expression: "-2^2", result: -4 });
});

test("calculator rejects invalid input and arbitrary code safely", () => {
  assert.equal(calculate("1/0").ok, false);
  assert.equal(calculate("sqrt(-1)").ok, false);
  for (const input of ["process.exit()", "globalThis.alert(1)", "2; throw Error()", "Math.random()", "1,2"]) {
    assert.deepEqual(calculate(input).ok, false, input);
  }
});

test("calculator schema appears after load and tool telemetry records execution", async () => {
  let saved: readonly StoredCapabilityEvent[] = [];
  const telemetry = createCapabilityTelemetry("run-calc", "mock", async (events) => { saved = events; });
  const surface = createToolSurface({ "compute.calculator": createCalculatorTool() }, telemetry.record);
  assert.equal(surface.initialTools["compute.calculator"], undefined);
  assert.deepEqual(surface.session.recommend("Calculate 17.5% of 428,000").map((item) => item.id), ["compute.calculator"]);
  let turn = 0;
  const model = new MockLanguageModelV4({ doStream: async (options) => {
    assert.equal(options.tools!.some((item) => item.name === "compute_calculator"), turn > 0);
    const calls = turn === 0 ? [{ name: "capabilities_load", input: { ids: ["compute.calculator"] } }]
      : turn === 1 ? [{ name: "compute_calculator", input: { expression: "17.5% of 428,000" } }] : [];
    turn++;
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] },
      ...calls.map((call, index) => ({ type: "tool-call" as const, toolCallId: `${turn}-${index}`, toolName: call.name, input: JSON.stringify(call.input) })),
      { type: "finish", finishReason: { unified: calls.length ? "tool-calls" as const : "stop" as const, raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ] }) };
  } });
  await runAgent({ model, messages: [{ role: "user", content: "Calculate 17.5%" }], tools: surface.tools,
    projectTools: surface.projectTools, maxTurns: 3,
    onEvent: (event) => telemetry.runtimeEvent(event, surface.session) });
  await telemetry.flush();
  assert.equal(turn, 3);
  assert.deepEqual(saved.filter((event) => event.capabilityId === "compute.calculator").map((event) => event.type),
    ["recommended", "loaded", "executed", "succeeded"]);
  assert.ok(saved.find((event) => event.type === "succeeded")?.latencyMs !== undefined);
});
