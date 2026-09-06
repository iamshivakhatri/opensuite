import assert from "node:assert/strict";
import { test } from "node:test";

import {
  progressMarker,
  reduceAgentProgress,
  visibleAgentProgress,
  type AgentProgressLine,
} from "./agent-progress.ts";
import { shouldAcceptSubmit } from "./agent-submit.ts";
import type { AgentLiveEvent } from "./api.ts";

function event(
  type: string,
  data: Record<string, unknown> = {},
): AgentLiveEvent {
  return {
    id: 1,
    runId: "run-1",
    type,
    at: new Date().toISOString(),
    data,
  };
}

test("reduceAgentProgress keeps completed tools with Thinking", () => {
  let lines: AgentProgressLine[] = [];
  lines = reduceAgentProgress(lines, event("agent.started"));
  assert.equal(lines[0]?.label, "Thinking…");

  lines = reduceAgentProgress(
    lines,
    event("tool.started", {
      toolCallId: "t1",
      toolName: "document.inspect",
    }),
  );
  assert.deepEqual(
    lines.map((line) => ({ status: line.status, label: line.label })),
    [{ status: "active", label: "Inspecting document…" }],
  );

  lines = reduceAgentProgress(
    lines,
    event("tool.completed", {
      toolCallId: "t1",
      toolName: "document.inspect",
    }),
  );
  assert.deepEqual(
    lines.map((line) => ({ status: line.status, label: line.label })),
    [
      { status: "done", label: "Inspected document" },
      { status: "active", label: "Thinking…" },
    ],
  );

  lines = reduceAgentProgress(
    lines,
    event("tool.started", { toolCallId: "t2", toolName: "document.find" }),
  );
  assert.deepEqual(
    lines.map((line) => ({ status: line.status, label: line.label })),
    [
      { status: "done", label: "Inspected document" },
      { status: "active", label: "Searching document…" },
    ],
  );

  lines = reduceAgentProgress(
    lines,
    event("tool.completed", {
      toolCallId: "t2",
      toolName: "document.find",
    }),
  );
  assert.ok(lines.some((line) => line.label === "Search complete" && line.status === "done"));
  assert.ok(lines.some((line) => line.label === "Thinking…" && line.status === "active"));

  lines = reduceAgentProgress(lines, event("message.started"));
  assert.ok(lines.some((line) => line.label === "Thinking…" && line.status === "active"));
});

test("reduceAgentProgress keeps Thinking on empty delta / message.started", () => {
  let lines = reduceAgentProgress([], event("agent.started"));
  lines = reduceAgentProgress(lines, event("message.started"));
  assert.equal(lines[0]?.label, "Thinking…");
  lines = reduceAgentProgress(lines, event("message.delta", { delta: "" }));
  assert.equal(lines[0]?.label, "Thinking…");
});

test("reduceAgentProgress clears status once text streams", () => {
  let lines = reduceAgentProgress([], event("agent.started"));
  assert.equal(lines[0]?.label, "Thinking…");
  lines = reduceAgentProgress(lines, event("message.delta", { delta: "Hi" }));
  assert.deepEqual(lines, []);
});

test("visibleAgentProgress includes done rows", () => {
  const lines: AgentProgressLine[] = [
    { id: "a", label: "Inspected document", status: "done" },
    { id: "b", label: "Thinking…", status: "active" },
    { id: "c", label: "failed", status: "error" },
  ];
  assert.deepEqual(
    visibleAgentProgress(lines).map((line) => line.id),
    ["a", "b", "c"],
  );
  assert.equal(progressMarker("done"), "✓");
  assert.equal(progressMarker("active"), "●");
});

test("reduceAgentProgress maps failed and cancelled terminals", () => {
  let lines = reduceAgentProgress([], event("agent.started"));
  lines = reduceAgentProgress(lines, event("agent.failed"));
  assert.ok(lines.some((line) => line.id === "failed"));

  lines = reduceAgentProgress([], event("agent.started"));
  lines = reduceAgentProgress(lines, event("agent.cancelled"));
  assert.ok(lines.some((line) => line.label === "Stopped"));
});

test("shouldAcceptSubmit blocks empty and in-flight submits", () => {
  assert.equal(
    shouldAcceptSubmit({ instruction: "  ", busy: false, locked: false }),
    false,
  );
  assert.equal(
    shouldAcceptSubmit({ instruction: "Go", busy: true, locked: false }),
    false,
  );
  assert.equal(
    shouldAcceptSubmit({ instruction: "Go", busy: false, locked: true }),
    false,
  );
  assert.equal(
    shouldAcceptSubmit({ instruction: "Go", busy: false, locked: false }),
    true,
  );
});
