import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentRunDurationMs,
  formatProgressElapsed,
  groupProgressLines,
  latestProgressHeadline,
  progressElapsedLabel,
  progressMarker,
  progressSummaryLabel,
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

test("reduceAgentProgress keeps completed tools then Generating (not Thinking)", () => {
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
      { status: "active", label: "Generating…" },
    ],
  );
  assert.equal(lines[0]?.startedAt, t0 + 100);
  assert.equal(lines[0]?.endedAt, t0 + 500);
  assert.equal(
    lines.some((line) => line.label === "Thinking…" && line.status === "active"),
    false,
  );

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
  assert.ok(lines.some((line) => line.label === "Generating…" && line.status === "active"));
  assert.equal(
    lines.some((line) => line.label === "Thinking…"),
    false,
  );

  lines = reduceAgentProgress(lines, event("message.started"), t0 + 1000);
  assert.ok(lines.some((line) => line.label === "Generating…" && line.status === "active"));
});

test("reduceAgentProgress keeps Thinking on empty delta / message.started before tools", () => {
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

test("INVALID_TOOL_INPUT uses distinct progress label", () => {
  let lines = reduceAgentProgress(
    [],
    event("tool.failed", {
      toolCallId: "t1",
      toolName: "document.insert_table_rows",
      code: "INVALID_TOOL_INPUT",
    }),
    10,
  );
  assert.ok(
    lines.some(
      (line) =>
        line.status === "error" && line.label === "Invalid tool input",
    ),
  );
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
  assert.equal(
    thoughtForLabel(12_000, "completed", 15),
    "Finished 15 steps · 12s",
  );
});

test("groupProgressLines collapses repeated inserts", () => {
  const lines: AgentProgressLine[] = [
    { id: "t1", label: "Inspected document", status: "done", startedAt: 1, endedAt: 2 },
    { id: "t2", label: "Inspected document", status: "done", startedAt: 3, endedAt: 4 },
    { id: "t3", label: "Inserted paragraph", status: "done", startedAt: 5, endedAt: 6 },
    { id: "t4", label: "Inserted paragraph", status: "done", startedAt: 7, endedAt: 8 },
    { id: "t5", label: "Inserted paragraph", status: "done", startedAt: 9, endedAt: 10 },
    { id: "writing", label: "Generating…", status: "active", startedAt: 11 },
  ];
  const groups = groupProgressLines(lines);
  assert.deepEqual(
    groups.map((g) => ({ label: g.label, count: g.count })),
    [
      { label: "Inspected document", count: 2 },
      { label: "Inserted paragraphs", count: 3 },
    ],
  );
  assert.equal(
    progressSummaryLabel(lines, { durationMs: 29_000, outcome: "completed" }),
    "Finished 5 steps · 29s",
  );
  assert.match(
    progressSummaryLabel(
      [
        ...lines.filter((l) => l.id !== "writing"),
        {
          id: "t6",
          label: "Inserting paragraph…",
          status: "active",
          startedAt: 12,
        },
      ],
      { live: true },
    ),
    /Inserting paragraph/,
  );
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
