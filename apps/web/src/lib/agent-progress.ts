import type { AgentLiveEvent } from "./api";

export type ProgressLineStatus = "pending" | "active" | "done" | "error";

export interface AgentProgressLine {
  readonly id: string;
  readonly label: string;
  readonly status: ProgressLineStatus;
  /** Epoch ms when this line became active (for elapsed display). */
  readonly startedAt?: number;
  /** Epoch ms when this line finished (done/error). */
  readonly endedAt?: number;
}

/** Durable per-turn progress snapshot for timeline + total time display. */
export interface AgentTurnProgress {
  readonly runId: string;
  readonly durationMs: number;
  readonly lines: readonly AgentProgressLine[];
  readonly outcome: "completed" | "cancelled" | "failed";
}

const TOOL_LABELS: Record<string, { active: string; done: string }> = {
  "document.inspect": {
    active: "Inspecting document…",
    done: "Inspected document",
  },
  "document.find": {
    active: "Searching document…",
    done: "Search complete",
  },
  "document.capabilities": {
    active: "Checking capabilities…",
    done: "Capabilities ready",
  },
  "document.replace_text": {
    active: "Replacing text…",
    done: "Replaced text",
  },
  "document.set_table_cells_text": {
    active: "Updating table cells…",
    done: "Updated table cells",
  },
  "document.insert_table_rows": {
    active: "Inserting table rows…",
    done: "Inserted table rows",
  },
  "document.insert_table_column": {
    active: "Inserting table column…",
    done: "Inserted table column",
  },
  "slides.update_text": {
    active: "Updating slide text…",
    done: "Updated slide text",
  },
  "workbook.set_cells": {
    active: "Updating cells…",
    done: "Updated cells",
  },
};

function toolLabels(toolName: string): { active: string; done: string } {
  return (
    TOOL_LABELS[toolName] ?? {
      active: "Running tool…",
      done: "Tool completed",
    }
  );
}

function withoutThinking(
  lines: readonly AgentProgressLine[],
): AgentProgressLine[] {
  return lines.filter((line) => line.id !== "thinking");
}

function withoutTransient(
  lines: readonly AgentProgressLine[],
): AgentProgressLine[] {
  return lines.filter(
    (line) => line.id !== "thinking" && line.id !== "writing",
  );
}

/** Model is working between tools — never re-introduce initial "Thinking…". */
function withGenerating(
  lines: readonly AgentProgressLine[],
  now: number,
): AgentProgressLine[] {
  const base = withoutTransient(lines);
  const existing = lines.find(
    (line) => line.id === "writing" && line.status === "active",
  );
  return [
    ...base,
    {
      id: "writing",
      label: "Generating…",
      status: "active",
      startedAt: existing?.startedAt ?? now,
    },
  ];
}

function freezeActive(
  lines: readonly AgentProgressLine[],
  nowMs: number,
): AgentProgressLine[] {
  return lines.map((line) =>
    line.status === "active"
      ? {
          ...line,
          status: "done" as const,
          endedAt: line.endedAt ?? nowMs,
        }
      : line,
  );
}

function failedToolLabel(toolName: string, code: string | undefined): string {
  if (code === "UNKNOWN_TOOL" || toolName === "document.mutate") {
    return "Tool not available";
  }
  if (code === "INVALID_TOOL_INPUT") {
    return "Invalid tool input";
  }
  if (code === "UNSUPPORTED_OPERATION" || code === "UNSUPPORTED_CAPABILITY") {
    if (toolName === "document.inspect") {
      return "Inspect unsupported (use Search)";
    }
    if (toolName.startsWith("document.insert_table")) {
      return "Table structure unsupported";
    }
    if (toolName === "document.set_table_cells_text") {
      return "Table cell update unsupported";
    }
  }
  if (code === "TARGET_NOT_FOUND" || code === "TARGET_AMBIGUOUS") {
    if (toolName === "document.insert_table_rows") {
      return code === "TARGET_AMBIGUOUS"
        ? "Table row target ambiguous"
        : "Table row target not found";
    }
    if (toolName === "document.set_table_cells_text") {
      return code === "TARGET_AMBIGUOUS"
        ? "Table cell target ambiguous"
        : "Table cell target not found";
    }
  }
  if (
    toolName === "document.inspect" &&
    (code === "UNSUPPORTED_OPERATION" || code === "UNSUPPORTED_CAPABILITY")
  ) {
    return "Inspect unsupported (use Search)";
  }
  switch (toolName) {
    case "document.inspect":
      return "Inspect failed";
    case "document.find":
      return "Search failed";
    case "document.replace_text":
      return "Replace failed";
    case "document.set_table_cells_text":
      return "Table cell update failed";
    case "document.insert_table_rows":
      return "Table row insert failed";
    case "document.insert_table_column":
      return "Table column insert failed";
    case "document.capabilities":
      return "Capabilities check failed";
    default:
      return `${toolName} failed`;
  }
}

/** Format elapsed ms as 0.8s / 12s / 1m 05s. */
export function formatProgressElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0.0s";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function progressElapsedLabel(
  line: AgentProgressLine,
  nowMs: number = Date.now(),
): string | null {
  if (line.startedAt === undefined) return null;
  const end = line.endedAt ?? (line.status === "active" ? nowMs : line.startedAt);
  const ms = Math.max(0, end - line.startedAt);
  if (line.status === "active" && ms < 100) return null;
  return formatProgressElapsed(ms);
}

/** Duration from agent_run startedAt/completedAt ISO strings. */
export function agentRunDurationMs(
  startedAt: string | null | undefined,
  completedAt: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const end = completedAt ? Date.parse(completedAt) : nowMs;
  if (!Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

/**
 * Single status line shown by default — newest active step, else last
 * finished/error step. Full history stays in `lines` for the timeline.
 */
export function latestProgressHeadline(
  lines: readonly AgentProgressLine[],
): AgentProgressLine | null {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line && line.status === "active") return line;
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line && (line.status === "done" || line.status === "error")) return line;
  }
  return null;
}

/**
 * Fold live SSE events into durable status lines.
 * New activity replaces the headline; full history is kept for expand-on-click.
 */
export function reduceAgentProgress(
  lines: readonly AgentProgressLine[],
  event: AgentLiveEvent,
  nowMs: number = Date.now(),
): AgentProgressLine[] {
  switch (event.type) {
    case "agent.started": {
      if (lines.some((line) => line.id === "thinking" && line.status === "active")) {
        return [...lines];
      }
      return [
        {
          id: "thinking",
          label: "Thinking…",
          status: "active",
          startedAt: nowMs,
        },
      ];
    }
    case "message.started":
      // Between tools / before tokens: show Generating, not Thinking.
      if (lines.some((line) => line.id === "thinking" && line.status === "active")) {
        return [...lines];
      }
      return withGenerating(lines, nowMs);
    case "message.delta": {
      // Seamless handoff: swap Thinking → Writing without clearing history.
      const hasDelta =
        typeof event.data.delta === "string" && event.data.delta.length > 0;
      if (!hasDelta) return [...lines];
      const thinking = lines.find(
        (line) => line.id === "thinking" && line.status === "active",
      );
      if (!thinking) {
        if (lines.some((line) => line.id === "writing" && line.status === "active")) {
          return [...lines];
        }
        return [
          ...freezeActive(withoutTransient(lines), nowMs),
          {
            id: "writing",
            label: "Generating…",
            status: "active",
            startedAt: nowMs,
          },
        ];
      }
      return lines.map((line) =>
        line.id === "thinking" && line.status === "active"
          ? {
              ...line,
              id: "writing",
              label: "Generating…",
            }
          : line,
      );
    }
    case "message.completed":
      return freezeActive(withoutTransient(lines), nowMs);
    case "tool.started": {
      const toolCallId = String(event.data.toolCallId ?? "tool");
      const toolName = String(event.data.toolName ?? "tool");
      const labels = toolLabels(toolName);
      const kept = withoutTransient(lines).filter(
        (line) => line.id !== `tool:${toolCallId}`,
      );
      return [
        ...kept,
        {
          id: `tool:${toolCallId}`,
          label: labels.active,
          status: "active",
          startedAt: nowMs,
        },
      ];
    }
    case "tool.completed": {
      const toolCallId = String(event.data.toolCallId ?? "tool");
      const toolName = String(event.data.toolName ?? "tool");
      const labels = toolLabels(toolName);
      const id = `tool:${toolCallId}`;
      const previous = lines.find((line) => line.id === id);
      const withoutActive = withoutTransient(lines).filter((line) => line.id !== id);
      return withGenerating(
        [
          ...withoutActive,
          {
            id,
            label: labels.done,
            status: "done",
            startedAt: previous?.startedAt ?? nowMs,
            endedAt: nowMs,
          },
        ],
        nowMs,
      );
    }
    case "tool.failed": {
      const toolCallId = String(event.data.toolCallId ?? "tool");
      const toolName = String(event.data.toolName ?? "tool");
      const code =
        typeof event.data.code === "string" ? event.data.code : undefined;
      const id = `tool:${toolCallId}`;
      const previous = lines.find((line) => line.id === id);
      const withoutActive = withoutTransient(lines).filter((line) => line.id !== id);
      return withGenerating(
        [
          ...withoutActive,
          {
            id,
            label: failedToolLabel(toolName, code),
            status: "error",
            startedAt: previous?.startedAt ?? nowMs,
            endedAt: nowMs,
          },
        ],
        nowMs,
      );
    }
    case "confirmation.required": {
      const toolCallId = String(event.data.toolCallId ?? "confirm");
      return [
        ...freezeActive(withoutTransient(lines), nowMs).filter(
          (line) => line.status === "done" || line.status === "error",
        ),
        {
          id: `confirm:${toolCallId}`,
          label: "Waiting for confirmation…",
          status: "active",
          startedAt: nowMs,
        },
      ];
    }
    case "agent.completed":
      return freezeActive(withoutTransient(lines), nowMs);
    case "agent.failed":
      return [
        ...freezeActive(withoutTransient(lines), nowMs),
        {
          id: "failed",
          label: "Something went wrong",
          status: "error",
          startedAt: nowMs,
          endedAt: nowMs,
        },
      ];
    case "agent.cancelled":
      return [
        ...freezeActive(withoutTransient(lines), nowMs),
        {
          id: "cancelled",
          label: "Stopped",
          status: "done",
          startedAt: nowMs,
          endedAt: nowMs,
        },
      ];
    default:
      return [...lines];
  }
}

/** Cursor-style summary for a finished turn. */
export function thoughtForLabel(
  durationMs: number,
  outcome: AgentTurnProgress["outcome"] = "completed",
): string {
  const elapsed = formatProgressElapsed(durationMs);
  if (outcome === "cancelled") return `Stopped after ${elapsed}`;
  if (outcome === "failed") return `Failed after ${elapsed}`;
  return `Thought for ${elapsed}`;
}

/** Show done + active + error (completed tools stay visible during the run). */
export function visibleAgentProgress(
  lines: readonly AgentProgressLine[],
): AgentProgressLine[] {
  return lines.filter(
    (line) =>
      line.status === "active" ||
      line.status === "error" ||
      line.status === "done",
  );
}

export function progressMarker(status: ProgressLineStatus): string {
  switch (status) {
    case "done":
      return "✓";
    case "active":
      return "●";
    case "error":
      return "!";
    case "pending":
      return "·";
  }
}
