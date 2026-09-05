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

function toolLabels(toolName: string): { active: string; done: string } {
  return (
    TOOL_LABELS[toolName] ?? {
      active: "Running tool…",
      done: "Tool completed",
    }
  );
}

/**
 * Fold live SSE events into concise status lines shown *before* assistant text.
 * Cleared once tokens stream. Never keeps a ✓ Working/Thinking pile under tools.
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
    case "message.delta":
    case "message.completed":
      return [];
    case "tool.started": {
      const toolCallId = String(event.data.toolCallId ?? "tool");
      const toolName = String(event.data.toolName ?? "tool");
      const labels = toolLabels(toolName);
      return [
        {
          id: `tool:${toolCallId}`,
          label: labels.active,
          status: "active",
        },
      ];
    }
    case "tool.completed": {
      // Drop completed tool chrome — resume Thinking until text streams.
      return [{ id: "thinking", label: "Thinking…", status: "active" }];
    }
    case "tool.failed": {
      const toolCallId = String(event.data.toolCallId ?? "tool");
      const toolName = String(event.data.toolName ?? "tool");
      return [
        {
          id: `tool:${toolCallId}`,
          label: `${toolName} failed`,
          status: "error",
        },
        { id: "thinking", label: "Thinking…", status: "active" },
      ];
    }
    case "confirmation.required": {
      const toolCallId = String(event.data.toolCallId ?? "confirm");
      return [
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

/** UI helper: only active / error rows (no stale ✓ pile). */
export function visibleAgentProgress(
  lines: readonly AgentProgressLine[],
): AgentProgressLine[] {
  return lines.filter(
    (line) => line.status === "active" || line.status === "error",
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
