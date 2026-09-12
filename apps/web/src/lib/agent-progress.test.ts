import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityFamilyForTool,
  agentRunDurationMs,
  detailsAffordanceLabel,
  formatProgressElapsed,
  groupProgressLines,
  latestProgressHeadline,
  presentAgentRun,
  progressElapsedLabel,
  progressMarker,
  progressSummaryLabel,
  reduceAgentProgress,
  summarizeAgentActivities,
  technicalProgressLines,
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

function reduceAll(
  events: Array<{ type: string; data?: Record<string, unknown>; at?: number }>,
): AgentProgressLine[] {
  let lines: AgentProgressLine[] = [];
  for (const item of events) {
    lines = reduceAgentProgress(
      lines,
      event(item.type, item.data ?? {}),
      item.at ?? 1,
    );
  }
  return lines;
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
    [
      { status: "done", label: "Thought" },
      { status: "active", label: "Inspecting document…" },
    ],
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
      { status: "done", label: "Thought" },
      { status: "done", label: "Inspected document" },
      { status: "active", label: "Generating…" },
    ],
  );
  assert.equal(lines[1]?.toolName, "document.inspect");
  assert.equal(lines[1]?.startedAt, t0 + 100);
  assert.equal(lines[1]?.endedAt, t0 + 500);
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
      { status: "done", label: "Thought" },
      { status: "done", label: "Inspected document" },
      { status: "done", label: "Thought" },
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
    lines.filter((line) => line.label === "Thought").length,
    2,
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
  assert.equal(thoughtForLabel(12_000), "Done in 12s");
  assert.equal(thoughtForLabel(12_000, "cancelled"), "Stopped after 12s");
  assert.equal(thoughtForLabel(12_000, "completed", 15), "Done in 12s");
  assert.equal(thoughtForLabel(12_000, "failed"), "Couldn't complete · 12s");
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
});

test("technicalProgressLines hides Thought cadence", () => {
  const lines: AgentProgressLine[] = [
    { id: "thought:1", label: "Thought", status: "done" },
    {
      id: "tool:t1",
      label: "Formatted paragraph",
      status: "done",
      toolName: "document.set_paragraph_formatting",
    },
    { id: "writing", label: "Generating…", status: "active" },
  ];
  assert.deepEqual(
    technicalProgressLines(lines).map((line) => line.id),
    ["tool:t1"],
  );
});

test("semantic grouping collapses formatting family", () => {
  const lines = reduceAll([
    { type: "agent.started", at: 1 },
    {
      type: "tool.completed",
      data: { toolCallId: "a", toolName: "workspace.create_blank_docx" },
      at: 2,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "b", toolName: "document.insert_paragraphs" },
      at: 3,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "c", toolName: "document.set_paragraph_style" },
      at: 4,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "d", toolName: "document.set_paragraph_formatting" },
      at: 5,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "e", toolName: "document.set_text_formatting" },
      at: 6,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "f", toolName: "document.set_paragraph_formatting" },
      at: 7,
    },
  ]);

  const activities = summarizeAgentActivities(lines);
  assert.deepEqual(
    activities.map((a) => ({
      family: a.family,
      label: a.label,
      status: a.status,
      changeCount: a.changeCount,
    })),
    [
      { family: "create", label: "Created document", status: "done", changeCount: 1 },
      { family: "content", label: "Added content", status: "done", changeCount: 1 },
      {
        family: "structure",
        label: "Structured sections",
        status: "done",
        changeCount: 1,
      },
      {
        family: "formatting",
        label: "Formatted document",
        status: "done",
        changeCount: 3,
      },
    ],
  );
  assert.equal(activityFamilyForTool("document.set_page_number"), "layout");
});

test("repeated formatting collapses in primary and details", () => {
  const lines = reduceAll([
    {
      type: "tool.completed",
      data: { toolCallId: "1", toolName: "document.set_paragraph_formatting" },
      at: 1,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "2", toolName: "document.set_paragraph_formatting" },
      at: 2,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "3", toolName: "document.set_text_formatting" },
      at: 3,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "4", toolName: "document.set_paragraph_formatting" },
      at: 4,
    },
  ]);

  const presentation = presentAgentRun(lines, {
    durationMs: 20_000,
    outcome: "completed",
  });
  assert.deepEqual(
    presentation.activities.map((a) => a.label),
    ["Formatted document"],
  );
  assert.equal(presentation.activities[0]?.changeCount, 4);
  assert.equal(presentation.headline, "Done in 20s");
  assert.ok(presentation.actionCount >= 4);
  // Details still show technical labels, collapsed by consecutive same label.
  assert.ok(
    presentation.details.some(
      (g) => g.label === "Formatted paragraph" || g.label === "Formatted paragraphs",
    ),
  );
});

test("running activity state uses semantic headline and milestones", () => {
  const lines = reduceAll([
    { type: "agent.started", at: 1 },
    {
      type: "tool.completed",
      data: { toolCallId: "a", toolName: "workspace.create_blank_docx" },
      at: 2,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "b", toolName: "document.insert_paragraphs" },
      at: 3,
    },
    {
      type: "tool.started",
      data: { toolCallId: "c", toolName: "document.set_paragraph_formatting" },
      at: 4,
    },
  ]);

  const presentation = presentAgentRun(lines, { live: true });
  assert.equal(presentation.headline, "Formatting document…");
  assert.deepEqual(
    presentation.activities.map((a) => ({ label: a.label, status: a.status })),
    [
      { label: "Created document", status: "done" },
      { label: "Added content", status: "done" },
      { label: "Formatting document…", status: "active" },
    ],
  );
  assert.match(progressSummaryLabel(lines, { live: true }), /Formatting document/);
  assert.equal(
    progressSummaryLabel(lines, { live: true }).includes("completed"),
    false,
  );
});

test("recovered failure hidden from primary summary", () => {
  const lines = reduceAll([
    {
      type: "tool.failed",
      data: {
        toolCallId: "a",
        toolName: "document.set_paragraph_style",
        code: "TARGET_AMBIGUOUS",
      },
      at: 1,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "b", toolName: "document.set_paragraph_style" },
      at: 2,
    },
  ]);

  const activities = summarizeAgentActivities(lines);
  assert.deepEqual(
    activities.map((a) => ({ label: a.label, status: a.status })),
    [{ label: "Structured sections", status: "done" }],
  );
  // Technical details still retain the failure.
  const details = presentAgentRun(lines).details;
  assert.ok(details.some((g) => g.status === "error"));
  assert.ok(details.some((g) => g.status === "done"));
});

test("unrecovered failure remains visible in primary summary", () => {
  const lines = reduceAll([
    {
      type: "tool.completed",
      data: { toolCallId: "a", toolName: "document.insert_paragraphs" },
      at: 1,
    },
    {
      type: "tool.failed",
      data: {
        toolCallId: "b",
        toolName: "document.set_paragraph_formatting",
        code: "TARGET_AMBIGUOUS",
      },
      at: 2,
    },
  ]);

  const activities = summarizeAgentActivities(lines);
  assert.deepEqual(
    activities.map((a) => ({ label: a.label, status: a.status })),
    [
      { label: "Added content", status: "done" },
      { label: "Couldn't format one section", status: "error" },
    ],
  );
  assert.equal(
    activities.some((a) => a.label.includes("TARGET_AMBIGUOUS")),
    false,
  );
});

test("completed run collapses to Done headline", () => {
  const lines = reduceAll([
    {
      type: "tool.completed",
      data: { toolCallId: "a", toolName: "workspace.create_blank_docx" },
      at: 1,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "b", toolName: "document.insert_paragraphs" },
      at: 2,
    },
    { type: "agent.completed", at: 3 },
  ]);

  const presentation = presentAgentRun(lines, {
    durationMs: 68_000,
    outcome: "completed",
  });
  assert.equal(presentation.headline, "Done in 1m 08s");
  assert.equal(detailsAffordanceLabel(presentation.actionCount), `View ${presentation.actionCount} actions`);
  // Activities still available for callers; panel only shows them while live.
  assert.ok(presentation.activities.length >= 2);
  assert.ok(presentation.details.length >= 1);
  assert.equal(
    presentation.details.some((g) => g.key === "Thought"),
    false,
  );
});

test("details affordance and finishing-up headline", () => {
  assert.equal(detailsAffordanceLabel(0), "View details");
  assert.equal(detailsAffordanceLabel(1), "View 1 action");
  assert.equal(detailsAffordanceLabel(16), "View 16 actions");

  const lines = reduceAll([
    {
      type: "tool.completed",
      data: { toolCallId: "a", toolName: "document.insert_paragraphs" },
      at: 1,
    },
    { type: "message.started", at: 2 },
  ]);
  assert.equal(presentAgentRun(lines, { live: true }).headline, "Finishing up…");
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
