import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Capabilities,
  createCapabilities,
  createFakeDocumentRuntime,
  createRecordingEventSink,
  hasCapability,
  unsupportedCapabilityResult,
  type AgentEvent,
} from "../index.js";

test("FakeDocumentRuntime inspect returns format-discriminated payload", async () => {
  const runtime = createFakeDocumentRuntime();
  const result = await runtime.inspect({
    documentId: "doc-1",
    versionId: "ver-1",
    format: "docx",
  });
  assert.equal(result.status, "success");
  if (result.status !== "success") {
    return;
  }
  assert.equal(result.format, "docx");
  assert.equal(result.payload.format, "docx");
  assert.equal(result.payload.summary.unitKind, "page");
  assert.equal(result.focus.kind, "overview");
  assert.equal(
    hasCapability(result.capabilities, Capabilities.DocumentInspect),
    true,
  );
});

test("unsupported capability is representable as structured error", () => {
  const result = unsupportedCapabilityResult(Capabilities.DocumentMutate);
  assert.equal(result.status, "error");
  if (result.status !== "error") {
    return;
  }
  assert.equal(result.diagnostics[0]?.code, "UNSUPPORTED_CAPABILITY");
  assert.equal(
    result.diagnostics[0]?.details?.capability,
    Capabilities.DocumentMutate,
  );
});

test("FakeDocumentRuntime execute defaults to unsupported mutate", async () => {
  const runtime = createFakeDocumentRuntime({
    capabilities: createCapabilities(Capabilities.DocumentInspect),
  });
  assert.ok(runtime.execute);
  const result = await runtime.execute!(
    { documentId: "d", versionId: "v", format: "docx" },
    {
      type: "replace_text",
      baseVersionId: "v",
      payload: {},
    },
  );
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "UNSUPPORTED_CAPABILITY");
  }
});

test("AgentEvent discriminated union works with recording sink", () => {
  const sink = createRecordingEventSink();
  const started: AgentEvent = {
    type: "agent.started",
    runId: "run-1",
    at: "2026-01-01T00:00:00.000Z",
  };
  const toolFailed: AgentEvent = {
    type: "tool.failed",
    runId: "run-1",
    toolCallId: "c1",
    toolName: "document.inspect",
    diagnostic: {
      code: "RUNTIME_FAILURE",
      severity: "error",
      message: "boom",
    },
    at: "2026-01-01T00:00:01.000Z",
  };
  sink.emit(started);
  sink.emit(toolFailed);
  assert.equal(sink.events.length, 2);
  assert.equal(sink.events[0]?.type, "agent.started");
  assert.equal(sink.events[1]?.type, "tool.failed");
});
