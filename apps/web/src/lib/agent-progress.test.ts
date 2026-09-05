import assert from "node:assert/strict";
import { test } from "node:test";

import {
  progressMarker,
  reduceAgentProgress,
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

test("reduceAgentProgress builds concise Cursor-style lines", () => {
  let lines: AgentProgressLine[] = [];
  lines = reduceAgentProgress(lines, event("agent.started"));
  lines = reduceAgentProgress(
    lines,
    event("tool.started", {
      toolCallId: "t1",
      toolName: "document.inspect",
    }),
  );
  lines = reduceAgentProgress(
    lines,
    event("tool.completed", {
      toolCallId: "t1",
      toolName: "document.inspect",
    }),
  );
  lines = reduceAgentProgress(
    lines,
    event("tool.started", { toolCallId: "t2", toolName: "other.tool" }),
  );
  lines = reduceAgentProgress(lines, event("agent.completed"));

  assert.deepEqual(
    lines.map((line) => ({
      marker: progressMarker(line.status),
      label: line.label,
    })),
    [
      { marker: "✓", label: "Working…" },
      { marker: "✓", label: "Inspected document" },
      { marker: "✓", label: "Running tool…" },
    ],
  );
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
