import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentRunDurationMs,
  formatProgressElapsed,
  latestProgressHeadline,
  progressElapsedLabel,
  progressMarker,
  reduceAgentProgress,
  thoughtForLabel,
  visibleAgentProgress,
  type AgentProgressLine,
} from "./agent-progress.ts";
import { shouldAcceptSubmit } from "./agent-submit.ts";
import type { AgentLiveEvent } from "./api.ts";

function event(
  type: string,
  data: Record<string, unknown> = {},
  at = new Date().toISOString(),
): AgentLiveEvent {
  return {
    id: 1,
    runId: "run-1",
    type,
    at,
    data,
  };
}

test("reduceAgentProgress keeps completed tools with Thinking", () => {
  const t0 = 1_000;
  let lines: AgentProgressLine[] = [];
  lines = reduceAgentProgress(lines, event("agent.started"), t0);
  assert.equal(lines[0]?.label, "Thinking…");
  assert.equal(lines[0]?.startedAt, t0);

  lines = reduceAgentProgress(
    lines,
    event("tool.started", {
      toolCallId: "t1",
      toolName: "document.inspect",
    }),
    t0 + 100,
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
    t0 + 500,
  );
  assert.deepEqual(
    lines.map((line) => ({ status: line.status, label: line.label })),
    [
      { status: "done", label: "Inspected document" },
      { status: "active", label: "Thinking…" },
    ],
  );
  assert.equal(lines[0]?.startedAt, t0 + 100);
  assert.equal(lines[0]?.endedAt, t0 + 500);

  lines = reduceAgentProgress(
    lines,
    event("tool.started", { toolCallId: "t2", toolName: "document.find" }),
    t0 + 600,
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
    t0 + 900,
  );
  assert.ok(lines.some((line) => line.label === "Search complete" && line.status === "done"));
  assert.ok(lines.some((line) => line.label === "Thinking…" && line.status === "active"));

  lines = reduceAgentProgress(lines, event("message.started"), t0 + 1000);
  assert.ok(lines.some((line) => line.label === "Thinking…" && line.status === "active"));
});

test("reduceAgentProgress keeps Thinking on empty delta / message.started", () => {
  let lines = reduceAgentProgress([], event("agent.started"), 1);
  lines = reduceAgentProgress(lines, event("message.started"), 2);
  assert.equal(lines[0]?.label, "Thinking…");
  lines = reduceAgentProgress(lines, event("message.delta", { delta: "" }), 3);
  assert.equal(lines[0]?.label, "Thinking…");
});

test("reduceAgentProgress swaps Thinking to Generating on first token", () => {
  let lines = reduceAgentProgress([], event("agent.started"), 1);
  lines = reduceAgentProgress(lines, event("message.delta", { delta: "Hi" }), 2);
  assert.equal(latestProgressHeadline(lines)?.label, "Generating…");
  assert.ok(lines.some((line) => line.id === "writing" && line.status === "active"));
  assert.equal(lines.some((line) => line.id === "thinking"), false);
});

test("reduceAgentProgress freezes active tools on message.completed", () => {
  let lines = reduceAgentProgress(
    [],
    event("tool.started", {
      toolCallId: "t1",
      toolName: "document.find",
    }),
    10,
  );
  lines = reduceAgentProgress(
    lines,
    event("message.completed", { content: "done" }),
    50,
  );
  assert.ok(
    lines.some(
      (line) => line.id === "tool:t1" && line.status === "done",
    ),
  );
  assert.equal(
    lines.some((line) => line.id === "thinking"),
    false,
  );
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
  assert.equal(latestProgressHeadline(lines)?.id, "b");
});

test("reduceAgentProgress preserves history on failed and cancelled", () => {
  let lines = reduceAgentProgress([], event("agent.started"), 1);
  lines = reduceAgentProgress(
    lines,
    event("tool.failed", {
      toolCallId: "t1",
      toolName: "document.mutate",
      code: "UNKNOWN_TOOL",
    }),
    2,
  );
  assert.ok(lines.some((line) => line.label === "Tool not available"));

  lines = reduceAgentProgress(lines, event("agent.failed"), 3);
  assert.ok(lines.some((line) => line.id === "failed"));
  assert.ok(lines.some((line) => line.label === "Tool not available"));

  lines = reduceAgentProgress([], event("agent.started"), 4);
  lines = reduceAgentProgress(
    lines,
    event("tool.completed", {
      toolCallId: "t2",
      toolName: "document.find",
    }),
    5,
  );
  lines = reduceAgentProgress(lines, event("agent.cancelled"), 6);
  assert.ok(lines.some((line) => line.label === "Stopped"));
  assert.ok(lines.some((line) => line.label === "Search complete"));
});

test("unsupported inspect failure uses friendly label", () => {
  let lines = reduceAgentProgress(
    [],
    event("tool.started", {
      toolCallId: "t1",
      toolName: "document.inspect",
    }),
    10,
  );
  lines = reduceAgentProgress(
    lines,
    event("tool.failed", {
      toolCallId: "t1",
      toolName: "document.inspect",
      code: "UNSUPPORTED_OPERATION",
    }),
    50,
  );
  assert.ok(
    lines.some(
      (line) =>
        line.status === "error" &&
        line.label === "Inspect unsupported (use Search)",
    ),
  );
});

test("formatProgressElapsed, progressElapsedLabel, agentRunDurationMs, thoughtForLabel", () => {
  assert.equal(formatProgressElapsed(800), "0.8s");
  assert.equal(formatProgressElapsed(12_400), "12s");
  assert.equal(
    progressElapsedLabel(
      { id: "t", label: "x", status: "done", startedAt: 1000, endedAt: 2500 },
      3000,
    ),
    "1.5s",
  );
  assert.equal(
    agentRunDurationMs(
      "2020-01-01T00:00:00.000Z",
      "2020-01-01T00:00:12.500Z",
    ),
    12_500,
  );
  assert.equal(thoughtForLabel(12_000), "Thought for 12s");
  assert.equal(thoughtForLabel(12_000, "cancelled"), "Stopped after 12s");
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
