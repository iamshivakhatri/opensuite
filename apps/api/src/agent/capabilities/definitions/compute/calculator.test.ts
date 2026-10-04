import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "@opensuite/agent-core-v3";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createToolSurface } from "../../runtime/tool-surface.js";
import { calculate, createCalculatorTool } from "./calculator.js";
import { createCapabilityTelemetry, type StoredCapabilityEvent } from "../../telemetry/recorder.js";

test("calculator handles arithmetic, percentages, powers, roots, and grouping", () => {
  assert.deepEqual(calculate("17.5% of 428,000"), { ok: true, expression: "17.5% of 428,000", resultType: "approximate_decimal", approximateResult: 74_900 });
  assert.deepEqual(calculate("sqrt(81) + 2^3"), { ok: true, expression: "sqrt(81) + 2^3", resultType: "approximate_decimal", approximateResult: 17 });
  assert.deepEqual(calculate("(10 - 4) / 3"), { ok: true, expression: "(10 - 4) / 3", resultType: "exact_integer", exactResult: "2" });
  assert.deepEqual(calculate("-2^2"), { ok: true, expression: "-2^2", resultType: "exact_integer", exactResult: "-4" });
  assert.deepEqual(calculate("0.1 + 0.2"), { ok: true, expression: "0.1 + 0.2", resultType: "approximate_decimal", approximateResult: 0.30000000000000004 });
  assert.deepEqual(calculate("1 / 3"), { ok: true, expression: "1 / 3", resultType: "approximate_decimal", approximateResult: 1 / 3 });
});

test("large integer operations return full exact strings without Number conversion", () => {
  const expression = "993493443493534 * 24543252434645";
  const product = calculate(expression);
  assert.deepEqual(product, { ok: true, expression, resultType: "exact_integer", exactResult: "24383560375826523079815085430" });
  assert.notEqual(product.ok && "exactResult" in product ? product.exactResult : "", String(Number("24383560375826523079815085430")));
  assert.deepEqual(calculate("9007199254740993 + 9007199254740993"),
    { ok: true, expression: "9007199254740993 + 9007199254740993", resultType: "exact_integer", exactResult: "18014398509481986" });
  assert.deepEqual(calculate("9007199254740993 - 9007199254740991"),
    { ok: true, expression: "9007199254740993 - 9007199254740991", resultType: "exact_integer", exactResult: "2" });
  assert.deepEqual(calculate("2^100"),
    { ok: true, expression: "2^100", resultType: "exact_integer", exactResult: "1267650600228229401496703205376" });
  assert.deepEqual(calculate("(9007199254740993)^2"),
    { ok: true, expression: "(9007199254740993)^2", resultType: "exact_integer", exactResult: (9007199254740993n ** 2n).toString() });
});

test("calculator rejects invalid input and arbitrary code safely", () => {
  assert.equal(calculate("1/0").ok, false);
  assert.equal(calculate("sqrt(-1)").ok, false);
  assert.equal(calculate("2^10001").ok, false);
  for (const input of ["process.exit()", "globalThis.alert(1)", "2; throw Error()", "Math.random()", "Function('return 1')()", "1,2"]) {
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
    if (turn === 2) {
      assert.match(JSON.stringify(options.prompt), /"exactResult":"24383560375826523079815085430"/);
    }
    const calls = turn === 0 ? [{ name: "capabilities_load", input: { ids: ["compute.calculator"] } }]
      : turn === 1 ? [{ name: "compute_calculator", input: { expression: "993493443493534 * 24543252434645" } }] : [];
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
