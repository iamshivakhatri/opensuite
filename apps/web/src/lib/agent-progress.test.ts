import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityFamilyForTool,
  activityKindForTool,
  agentRunDurationMs,
  detailsAffordanceLabel,
  formatProgressElapsed,
  groupProgressLines,
  latestProgressHeadline,
  presentAgentRun,
  progressElapsedLabel,
  progressMarker,
  progressSummaryLabel,
  projectActivityRows,
  reduceAgentProgress,
  reduceLiveTranscript,
  technicalProgressLines,
  thoughtForLabel,
  visibleAgentProgress,
  type AgentProgressLine,
  type LiveTranscriptEntry,
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

test("live transcript keeps narration and tool activity interleaved", () => {
  let lines: AgentProgressLine[] = [];
  let transcript: LiveTranscriptEntry[] = [];
  const apply = (type: string, data: Record<string, unknown> = {}) => {
    const next = event(type, data);
    lines = reduceAgentProgress(lines, next, 1);
    transcript = reduceLiveTranscript(transcript, next, lines);
  };

  apply("message.delta", { messageId: "m1", delta: "I'll inspect " });
  apply("message.delta", { messageId: "m1", delta: "the document." });
  apply("tool.started", { toolCallId: "i1", toolName: "document.inspect" });
  apply("tool.started", { toolCallId: "i1", toolName: "document.inspect" });
  apply("tool.completed", { toolCallId: "i1", toolName: "document.inspect" });
  apply("message.delta", { messageId: "m1", delta: "I found the Risks section." });
  apply("tool.started", { toolCallId: "r1", toolName: "document.replace_text" });
  apply("tool.failed", { toolCallId: "r1", toolName: "document.replace_text" });

  assert.deepEqual(
    transcript.map((entry) =>
      entry.kind === "narration"
        ? [entry.kind, entry.content]
        : [entry.kind, entry.line.id, entry.line.status],
    ),
    [
      ["narration", "I'll inspect the document."],
      ["activity", "tool:i1", "done"],
      ["narration", "I found the Risks section."],
      ["activity", "tool:r1", "error"],
    ],
  );
  assert.equal(new Set(transcript.map((entry) => entry.id)).size, transcript.length);
});

test("1. active run shows Thinking when model-active", () => {
  const t0 = 1_000;
  let lines = reduceAgentProgress([], event("agent.started"), t0);
  assert.equal(lines[0]?.label, "Thinking");
  assert.equal(lines[0]?.status, "active");

  const live = presentAgentRun(lines, { live: true });
  assert.equal(live.headline, "Thinking");
  assert.equal(live.activities[0]?.kind, "thinking");
  assert.equal(live.activities[0]?.liveElapsed, true);
});

test("2–4. tool started/completed/failed update same logical activity", () => {
  const t0 = 1_000;
  let lines = reduceAgentProgress([], event("agent.started"), t0);
  lines = reduceAgentProgress(
    lines,
    event("tool.started", {
      toolCallId: "t1",
      toolName: "document.inspect",
    }),
    t0 + 100,
  );
  assert.deepEqual(
    lines
      .filter((l) => !l.id.startsWith("thought:"))
      .map((line) => ({ status: line.status, label: line.label })),
    [{ status: "active", label: "Inspecting document" }],
  );
  let rows = projectActivityRows(lines);
  assert.equal(rows.some((r) => r.label === "Inspecting document" && r.status === "active"), true);
  assert.equal(rows.some((r) => r.kind === "thinking" && r.status === "active"), false);

  lines = reduceAgentProgress(
    lines,
    event("tool.completed", {
      toolCallId: "t1",
      toolName: "document.inspect",
    }),
    t0 + 500,
  );
  assert.ok(
    lines.some((line) => line.id === "tool:t1" && line.status === "done"),
  );
  assert.ok(
    lines.some((line) => line.id === "thinking" && line.status === "active"),
  );
  rows = projectActivityRows(lines);
  assert.ok(rows.some((r) => r.label === "Inspected document" && r.status === "done"));
  assert.ok(rows.some((r) => r.kind === "thinking" && r.status === "active"));

  lines = reduceAgentProgress(
    lines,
    event("tool.started", {
      toolCallId: "t2",
      toolName: "document.insert_table_rows",
    }),
    t0 + 600,
  );
  lines = reduceAgentProgress(
    lines,
    event("tool.failed", {
      toolCallId: "t2",
      toolName: "document.insert_table_rows",
      code: "TARGET_NOT_FOUND",
    }),
    t0 + 700,
  );
  assert.ok(
    lines.some(
      (line) =>
        line.id === "tool:t2" &&
        line.status === "error" &&
        line.label === "Table row target not found",
    ),
  );
  rows = projectActivityRows(lines);
  assert.ok(rows.some((r) => r.status === "error"));
});

test("5. repeated reads group/collapse after completion", () => {
  const lines = reduceAll([
    { type: "agent.started", at: 1 },
    {
      type: "tool.completed",
      data: { toolCallId: "a", toolName: "document.inspect" },
      at: 2,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "b", toolName: "document.inspect" },
      at: 3,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "c", toolName: "document.inspect" },
      at: 4,
    },
  ]);
  const rows = projectActivityRows(lines);
  const readGroup = rows.find((r) => r.kind === "read" && r.status === "done");
  assert.ok(readGroup);
  assert.equal(readGroup!.detail, "3 inspections");
  assert.equal(rows.filter((r) => r.kind === "read").length, 1);
});

test("5b. active repeated read stays visible while running", () => {
  const lines = reduceAll([
    {
      type: "tool.completed",
      data: { toolCallId: "a", toolName: "document.inspect" },
      at: 1,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "b", toolName: "document.inspect" },
      at: 2,
    },
    {
      type: "tool.started",
      data: { toolCallId: "c", toolName: "document.inspect" },
      at: 3,
    },
  ]);
  const rows = projectActivityRows(lines);
  assert.ok(rows.some((r) => r.detail === "2 inspections"));
  assert.ok(
    rows.some(
      (r) => r.label === "Inspecting document" && r.status === "active",
    ),
  );
});

test("6. mutation activities remain individually visible", () => {
  const lines = reduceAll([
    {
      type: "tool.completed",
      data: { toolCallId: "a", toolName: "document.insert_table_rows" },
      at: 1,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "b", toolName: "document.replace_text" },
      at: 2,
    },
    {
      type: "tool.started",
      data: { toolCallId: "c", toolName: "document.set_text_formatting" },
      at: 3,
    },
  ]);
  const rows = projectActivityRows(lines);
  assert.ok(rows.some((r) => r.label === "Added table rows" && r.weight === "emphasis"));
  assert.ok(rows.some((r) => r.label === "Replaced text"));
  assert.ok(
    rows.some(
      (r) =>
        r.label === "Formatting text" &&
        r.status === "active" &&
        r.weight === "emphasis",
    ),
  );
});

test("7. create/duplicate get human-readable lifecycle labels", () => {
  assert.equal(activityKindForTool("workspace.create_blank_document"), "lifecycle");
  assert.equal(activityKindForTool("workspace.duplicate_current_document"), "lifecycle");

  let lines = reduceAll([
    {
      type: "tool.started",
      data: {
        toolCallId: "d",
        toolName: "workspace.duplicate_current_document",
      },
      at: 1,
    },
  ]);
  assert.ok(lines.some((l) => l.label === "Duplicating document"));

  lines = reduceAgentProgress(
    lines,
    event("tool.completed", {
      toolCallId: "d",
      toolName: "workspace.duplicate_current_document",
    }),
    2,
  );
  assert.ok(lines.some((l) => l.label === "Created copy"));

  lines = reduceAgentProgress(
    lines,
    event("document.created", {
      documentId: "doc-2",
      name: "Weekly Plan copy",
      kind: "duplicated",
    }),
    3,
  );
  assert.ok(lines.some((l) => l.label === "Created Weekly Plan copy"));
});

test("7b. document.created before tool.completed keeps document name", () => {
  let lines = reduceAll([
    {
      type: "tool.started",
      data: {
        toolCallId: "d",
        toolName: "workspace.duplicate_current_document",
      },
      at: 1,
    },
  ]);
  lines = reduceAgentProgress(
    lines,
    event("document.created", {
      documentId: "doc-2",
      name: "Weekly Plan copy",
      kind: "duplicated",
    }),
    2,
  );
  lines = reduceAgentProgress(
    lines,
    event("tool.completed", {
      toolCallId: "d",
      toolName: "workspace.duplicate_current_document",
    }),
    3,
  );
  assert.ok(lines.some((l) => l.label === "Created Weekly Plan copy"));
});

test("8. completed run becomes compact", () => {
  const lines = reduceAll([
    {
      type: "tool.completed",
      data: { toolCallId: "a", toolName: "document.inspect" },
      at: 1,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "b", toolName: "document.insert_table_rows" },
      at: 2,
    },
    { type: "agent.completed", at: 3 },
  ]);
  const presentation = presentAgentRun(lines, {
    durationMs: 12_000,
    outcome: "completed",
  });
  assert.match(presentation.headline, /^Updated document · \d+ actions · 12s$/);
  assert.ok(presentation.actionCount >= 2);
  assert.ok(presentation.details.length >= 1);
});

test("reduceAgentProgress keeps Thinking between tools (not Generating)", () => {
  const t0 = 1_000;
  let lines = reduceAgentProgress([], event("agent.started"), t0);
  lines = reduceAgentProgress(
    lines,
    event("tool.started", {
      toolCallId: "t1",
      toolName: "document.inspect",
    }),
    t0 + 100,
  );
  lines = reduceAgentProgress(
    lines,
    event("tool.completed", {
      toolCallId: "t1",
      toolName: "document.inspect",
    }),
    t0 + 500,
  );
  assert.ok(lines.some((l) => l.id === "thinking" && l.status === "active"));
  assert.equal(lines.some((l) => l.label === "Generating…"), false);
  assert.equal(
    presentAgentRun(lines, { live: true }).headline,
    "Thinking",
  );
});

test("message.delta freezes Thinking without Generating filler", () => {
  let lines = reduceAgentProgress([], event("agent.started"), 1);
  lines = reduceAgentProgress(lines, event("message.delta", { delta: "Hi" }), 2);
  assert.equal(lines.some((line) => line.id === "thinking" && line.status === "active"), false);
  assert.equal(lines.some((line) => line.id === "writing"), false);
  assert.equal(
    presentAgentRun(lines, { live: true, streamingAnswer: true }).headline,
    "Finishing up",
  );
});

test("visibleAgentProgress includes done rows", () => {
  const lines: AgentProgressLine[] = [
    { id: "a", label: "Inspected document", status: "done" },
    { id: "b", label: "Thinking", status: "active" },
    { id: "c", label: "failed", status: "error" },
  ];
  assert.deepEqual(
    visibleAgentProgress(lines).map((line) => line.id),
    ["a", "b", "c"],
  );
  assert.equal(progressMarker("done"), "✓");
  assert.equal(latestProgressHeadline(lines)?.id, "b");
});

test("formatProgressElapsed helpers", () => {
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
});

test("groupProgressLines collapses repeated inserts", () => {
  const lines: AgentProgressLine[] = [
    { id: "t1", label: "Inspected document", status: "done", startedAt: 1, endedAt: 2 },
    { id: "t2", label: "Inspected document", status: "done", startedAt: 3, endedAt: 4 },
    { id: "t3", label: "Added content", status: "done", startedAt: 5, endedAt: 6 },
    { id: "t4", label: "Added content", status: "done", startedAt: 7, endedAt: 8 },
    { id: "thinking", label: "Thinking", status: "active", startedAt: 11 },
  ];
  const groups = groupProgressLines(lines);
  assert.deepEqual(
    groups.map((g) => ({ label: g.label, count: g.count })),
    [
      { label: "Inspected document", count: 2 },
      { label: "Added content", count: 2 },
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
    { id: "thinking", label: "Thinking", status: "active" },
  ];
  assert.deepEqual(
    technicalProgressLines(lines).map((line) => line.id),
    ["tool:t1"],
  );
});

test("live status never says Finishing up between tools", () => {
  assert.equal(detailsAffordanceLabel(0), "View details");
  assert.equal(detailsAffordanceLabel(1), "View 1 action");

  const betweenTools = reduceAll([
    {
      type: "tool.completed",
      data: { toolCallId: "a", toolName: "workspace.create_blank_document" },
      at: 1,
    },
    {
      type: "tool.completed",
      data: { toolCallId: "b", toolName: "document.insert_paragraphs" },
      at: 2,
    },
    { type: "message.started", at: 3 },
  ]);
  assert.equal(presentAgentRun(betweenTools, { live: true }).headline, "Thinking");
  assert.notEqual(
    presentAgentRun(betweenTools, { live: true }).headline,
    "Finishing up",
  );
  assert.equal(
    presentAgentRun(betweenTools, {
      live: true,
      streamingAnswer: true,
    }).headline,
    "Finishing up",
  );
});

test("recovered failure stays muted in details", () => {
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
  const details = presentAgentRun(lines).details;
  const recovered = details.find((g) => g.recovered);
  assert.ok(recovered);
  assert.match(recovered!.label, /^Recovered ·/);
  assert.equal(details.some((g) => g.status === "error" && !g.recovered), false);
});

test("unrecovered failure remains visible in activity rows", () => {
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
  const rows = projectActivityRows(lines);
  assert.ok(rows.some((r) => r.status === "error"));
  assert.ok(rows.some((r) => r.label === "Added content"));
});

test("unknown tool humanizes instead of raw snake_case", () => {
  const lines = reduceAll([
    {
      type: "tool.started",
      data: { toolCallId: "x", toolName: "document.frobnicate_widget" },
      at: 1,
    },
  ]);
  const row = projectActivityRows(lines).find((r) => r.id === "tool:x");
  assert.ok(row);
  assert.equal(row!.label.includes("_"), false);
  assert.match(row!.label, /frobnicate/i);
});

test("activityFamilyForTool still classifies layout", () => {
  assert.equal(activityFamilyForTool("document.set_page_number"), "layout");
});

test("progressSummaryLabel live tracks active tool", () => {
  const lines = reduceAll([
    {
      type: "tool.started",
      data: { toolCallId: "c", toolName: "document.set_paragraph_formatting" },
      at: 4,
    },
  ]);
  assert.match(progressSummaryLabel(lines, { live: true }), /Formatting paragraph/);
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

test("duplicate agent.cancelled events yield one Cancelled activity with unique ids", () => {
  let lines = reduceAgentProgress([], event("agent.started"), 1);
  lines = reduceAgentProgress(lines, event("agent.cancelled"), 2);
  lines = reduceAgentProgress(lines, event("agent.cancelled"), 3);
  lines = reduceAgentProgress(lines, event("agent.cancelled"), 4);

  const cancelled = lines.filter((line) => line.id === "cancelled");
  assert.equal(cancelled.length, 1);

  const presentation = presentAgentRun(lines, {
    durationMs: 1200,
    outcome: "cancelled",
  });
  const ids = presentation.activities.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(
    presentation.activities.filter((a) => a.id === "cancelled").length,
    1,
  );
});

test("duplicate agent.failed events yield one failed activity", () => {
  let lines = reduceAgentProgress([], event("agent.started"), 1);
  lines = reduceAgentProgress(lines, event("agent.failed"), 2);
  lines = reduceAgentProgress(lines, event("agent.failed"), 3);
  assert.equal(lines.filter((line) => line.id === "failed").length, 1);

  const ids = projectActivityRows(lines).map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("late agent.completed after cancelled does not add another terminal row", () => {
  let lines = reduceAgentProgress([], event("agent.started"), 1);
  lines = reduceAgentProgress(lines, event("agent.cancelled"), 2);
  const after = reduceAgentProgress(lines, event("agent.completed"), 3);
  assert.equal(after.filter((line) => line.id === "cancelled").length, 1);
  assert.equal(after.filter((line) => line.id === "failed").length, 0);
});
