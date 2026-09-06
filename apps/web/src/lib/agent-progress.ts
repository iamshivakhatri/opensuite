import type { AgentLiveEvent } from "./api";

export type ProgressLineStatus = "pending" | "active" | "done" | "error";

export interface AgentProgressLine {
  readonly id: string;
  readonly label: string;
  readonly status: ProgressLineStatus;
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
  "slides.update_text": {
    active: "Updating slide text…",
    done: "Updated slide text",
  },
  "workbook.set_cells": {
    active: "Updating cells…",
    done: "Updated cells",
  },
};

/** Keep a short trail of finished tools so the UI does not bounce back to Thinking. */
const MAX_DONE_TOOLS = 4;

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

function withThinking(
  lines: readonly AgentProgressLine[],
): AgentProgressLine[] {
  const base = withoutThinking(lines);
  return [
    ...base,
    { id: "thinking", label: "Thinking…", status: "active" },
  ];
}

function trimDoneTools(
  lines: readonly AgentProgressLine[],
): AgentProgressLine[] {
  const done = lines.filter((line) => line.status === "done");
  if (done.length <= MAX_DONE_TOOLS) {
    return [...lines];
  }
  const drop = new Set(done.slice(0, done.length - MAX_DONE_TOOLS).map((l) => l.id));
  return lines.filter((line) => !drop.has(line.id));
}

/**
 * Fold live SSE events into durable status lines shown *before* assistant text.
 * Completed tools stay visible (✓) so fast tools do not flicker back to Thinking.
 * Cleared once non-empty tokens stream.
 */
export function reduceAgentProgress(
  lines: readonly AgentProgressLine[],
  event: AgentLiveEvent,
): AgentProgressLine[] {
  switch (event.type) {
    case "agent.started": {
      if (lines.some((line) => line.id === "thinking" && line.status === "active")) {
        return [...lines];
      }
      return [{ id: "thinking", label: "Thinking…", status: "active" }];
    }
    case "message.started":
      return [...lines];
    case "message.delta": {
      const delta = event.data?.delta;
      if (typeof delta === "string" && delta.length > 0) {
        return [];
      }
      return [...lines];
    }
    case "message.completed":
      return [];
    case "tool.started": {
      const toolCallId = String(event.data.toolCallId ?? "tool");
      const toolName = String(event.data.toolName ?? "tool");
      const labels = toolLabels(toolName);
      const kept = withoutThinking(lines).filter(
        (line) => line.id !== `tool:${toolCallId}`,
      );
      return trimDoneTools([
        ...kept,
        {
          id: `tool:${toolCallId}`,
          label: labels.active,
          status: "active",
        },
      ]);
    }
    case "tool.completed": {
      const toolCallId = String(event.data.toolCallId ?? "tool");
      const toolName = String(event.data.toolName ?? "tool");
      const labels = toolLabels(toolName);
      const id = `tool:${toolCallId}`;
      const withoutActive = withoutThinking(lines).filter((line) => line.id !== id);
      return trimDoneTools(
        withThinking([
          ...withoutActive,
          { id, label: labels.done, status: "done" },
        ]),
      );
    }
    case "tool.failed": {
      const toolCallId = String(event.data.toolCallId ?? "tool");
      const toolName = String(event.data.toolName ?? "tool");
      const id = `tool:${toolCallId}`;
      const withoutActive = withoutThinking(lines).filter((line) => line.id !== id);
      return trimDoneTools(
        withThinking([
          ...withoutActive,
          {
            id,
            label: `${toolName} failed`,
            status: "error",
          },
        ]),
      );
    }
    case "confirmation.required": {
      const toolCallId = String(event.data.toolCallId ?? "confirm");
      return [
        ...withoutThinking(lines).filter(
          (line) => line.status === "done" || line.status === "error",
        ),
        {
          id: `confirm:${toolCallId}`,
          label: "Waiting for confirmation…",
          status: "active",
        },
      ];
    }
    case "agent.completed":
      return [];
    case "agent.failed":
      return [
        {
          id: "failed",
          label: "Something went wrong",
          status: "error",
        },
      ];
    case "agent.cancelled":
      return [
        {
          id: "cancelled",
          label: "Stopped",
          status: "done",
        },
      ];
    default:
      return [...lines];
  }
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
