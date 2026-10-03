import assert from "node:assert/strict";
import { test } from "node:test";
import { defineTool, runAgent } from "@opensuite/agent-core-v3";
import { jsonSchema } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createToolSurface } from "../runtime/tool-surface.js";
import { CapabilityRegistry } from "../core/registry.js";
import { CapabilitySession } from "../core/session.js";
import { createCapabilityTelemetry, type StoredCapabilityEvent } from "./recorder.js";

const registry = new CapabilityRegistry([
  { id: "document", parentId: null, kind: "group", title: "Document", description: "Edit", projection: "dynamic" },
  { id: "document.edit", parentId: "document", kind: "tool", title: "Edit", description: "Edit", projection: "always", toolName: "document.edit" },
]);
const session = new CapabilitySession(registry, { "document.edit": defineTool({ kind: "mutate", description: "Edit",
  inputSchema: jsonSchema({ type: "object", properties: {} }), execute: () => ({ ok: true }) }) });
session.projectTools();

test("dispatch events map to capability execution, success, failure, latency, model, and run", async () => {
  let saved: readonly StoredCapabilityEvent[] = [];
  const telemetry = createCapabilityTelemetry("run-1", "model-1", async (events) => { saved = events; });
  telemetry.runtimeEvent({ type: "model_turn_started", turn: 2 }, session);
  telemetry.runtimeEvent({ type: "tool_started", toolCallId: "a", toolName: "document.edit" }, session);
  telemetry.runtimeEvent({ type: "tool_completed", toolCallId: "a", toolName: "document.edit" }, session);
  telemetry.runtimeEvent({ type: "tool_started", toolCallId: "b", toolName: "document.edit" }, session);
  telemetry.runtimeEvent({ type: "tool_failed", toolCallId: "b", toolName: "document.edit", error: "BAD_TARGET" }, session);
  await telemetry.flush();
  assert.deepEqual(saved.map((event) => event.type), ["executed", "succeeded", "executed", "failed"]);
  assert.ok(saved.every((event) => event.runId === "run-1" && event.model === "model-1" && event.turn === 2 && event.capabilityId === "document.edit"));
  assert.ok(saved.every((event) => event.kind === "tool"));
  assert.ok(saved[1]!.latencyMs !== undefined);
  assert.equal(saved[3]!.errorCode, "BAD_TARGET");
});

test("skill discovery and loading retain instruction kind without execution events", async () => {
  let saved: readonly StoredCapabilityEvent[] = [];
  const telemetry = createCapabilityTelemetry("run-skill", "mock", async (events) => { saved = events; });
  const surface = createToolSurface({}, telemetry.record);
  surface.session.list("skills.scientific-writing", 1);
  surface.session.load(["skills.scientific-writing.scientific-paper"], 1);
  await telemetry.flush();
  assert.deepEqual(saved.map((event) => [event.kind, event.type]),
    [["instruction", "discovered"], ["instruction", "loaded"]]);
});

test("telemetry write errors do not fail the run", async () => {
  const telemetry = createCapabilityTelemetry("run-2", "model-1", async () => { throw new Error("db offline"); });
  telemetry.record({ capabilityId: "document.edit", kind: "tool", type: "loaded" });
  const warn = console.warn;
  console.warn = () => {};
  try { await assert.doesNotReject(telemetry.flush()); }
  finally { console.warn = warn; }
});

test("normal tool dispatch emits capability events without tool-specific logging", async () => {
  let saved: readonly StoredCapabilityEvent[] = [];
  const telemetry = createCapabilityTelemetry("run-3", "mock", async (events) => { saved = events; });
  const surface = createToolSurface({ "document.inspect": defineTool({ kind: "read", description: "Inspect",
    inputSchema: jsonSchema({ type: "object", properties: {} }), execute: () => ({ ok: true }) }) }, telemetry.record);
  let turn = 0;
  const model = new MockLanguageModelV4({ doStream: async () => {
    const calls = turn++ === 0 ? [{ type: "tool-call" as const, toolCallId: "inspect-1", toolName: "document_inspect", input: "{}" }] : [];
    return { stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] }, ...calls,
      { type: "finish", finishReason: { unified: calls.length ? "tool-calls" : "stop", raw: "stop" },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ] }) };
  } });
  await runAgent({ model, messages: [{ role: "user", content: "Inspect" }], tools: surface.tools,
    projectTools: surface.projectTools, onEvent: (event) => telemetry.runtimeEvent(event, surface.session) });
  await telemetry.flush();
  assert.deepEqual(saved.map((event) => [event.capabilityId, event.type]),
    [["document.inspect", "executed"], ["document.inspect", "succeeded"]]);
});
