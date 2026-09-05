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
 * Fold live SSE events into concise Cursor-style progress lines.
 * Hides CoT, provider payloads, and tool I/O JSON.
 */
export function reduceAgentProgress(
  lines: readonly AgentProgressLine[],
  event: AgentLiveEvent,
): AgentProgressLine[] {
  switch (event.type) {
    case "agent.started": {
      if (lines.some((line) => line.id === "working")) {
        return [...lines];
      }
      return [
        ...lines,
        { id: "working", label: "Working…", status: "active" },
      ];
    }
    case "tool.started": {
      const toolCallId = String(event.data.toolCallId ?? "tool");
      const toolName = String(event.data.toolName ?? "tool");
      const labels = toolLabels(toolName);
      const next = markWorkingDone(lines);
      return [
        ...next.filter((line) => line.id !== `tool:${toolCallId}`),
        {
          id: `tool:${toolCallId}`,
          label: labels.active,
          status: "active",
        },
      ];
    }
    case "tool.completed": {
      const toolCallId = String(event.data.toolCallId ?? "tool");
      const toolName = String(event.data.toolName ?? "tool");
      const labels = toolLabels(toolName);
      const next = markWorkingDone(lines);
      const without = next.filter((line) => line.id !== `tool:${toolCallId}`);
      return [
        ...without,
        {
          id: `tool:${toolCallId}`,
          label: labels.done,
          status: "done",
        },
      ];
    }
    case "tool.failed": {
      const toolCallId = String(event.data.toolCallId ?? "tool");
      const toolName = String(event.data.toolName ?? "tool");
      const next = markWorkingDone(lines);
      return [
        ...next.filter((line) => line.id !== `tool:${toolCallId}`),
        {
          id: `tool:${toolCallId}`,
          label: `${toolName} failed`,
          status: "error",
        },
      ];
    }
    case "confirmation.required": {
      const toolCallId = String(event.data.toolCallId ?? "confirm");
      const next = markWorkingDone(lines);
      return [
        ...next.filter((line) => line.id !== `confirm:${toolCallId}`),
        {
          id: `confirm:${toolCallId}`,
          label: "Waiting for confirmation…",
          status: "active",
        },
      ];
    }
    case "agent.completed":
      return markWorkingDone(lines).map((line) =>
        line.status === "active"
          ? { ...line, status: "done" as const }
          : line,
      );
    case "agent.failed":
      return [
        ...markWorkingDone(lines).map((line) =>
          line.status === "active"
            ? { ...line, status: "done" as const }
            : line,
        ),
        {
          id: "failed",
          label: "Something went wrong",
          status: "error",
        },
      ];
    case "agent.cancelled":
      return [
        ...markWorkingDone(lines).map((line) =>
          line.status === "active"
            ? { ...line, status: "done" as const }
            : line,
        ),
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

function markWorkingDone(
  lines: readonly AgentProgressLine[],
): AgentProgressLine[] {
  return lines.map((line) =>
    line.id === "working" && line.status === "active"
      ? { ...line, status: "done", label: "Working…" }
      : line,
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
