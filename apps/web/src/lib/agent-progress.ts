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
  /** Technical tool name when this line is a tool step. */
  readonly toolName?: string;
  /** Error code when status is error. */
  readonly errorCode?: string;
}

/** Durable per-turn progress snapshot for timeline + total time display. */
export interface AgentTurnProgress {
  readonly runId: string;
  readonly durationMs: number;
  readonly lines: readonly AgentProgressLine[];
  readonly outcome: "completed" | "cancelled" | "failed";
}

/** Semantic activity family — used for details recovery grouping. */
export type ActivityFamily =
  | "create"
  | "content"
  | "structure"
  | "formatting"
  | "table"
  | "list"
  | "media"
  | "layout"
  | "inspect"
  | "confirm"
  | "other";

/** Presentation weight for progressive activity rows. */
export type ActivityKind =
  | "thinking"
  | "read"
  | "mutate"
  | "lifecycle"
  | "finish"
  | "other";

/**
 * Progressive activity row projected from real SSE progress lines.
 * Presentation only — not a second runtime.
 */
export interface AgentActivity {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly label: string;
  readonly status: "active" | "done" | "error";
  /** Compact trustworthy meta under the label (e.g. "3 inspections"). */
  readonly detail?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** True for model-wait rows — UI shows a local elapsed timer. */
  readonly liveElapsed?: boolean;
  /** Reads quieter; mutations slightly stronger. */
  readonly weight: "quiet" | "normal" | "emphasis";
}

export interface AgentRunPresentation {
  /** Compact status: live current step, or completed summary. */
  readonly headline: string;
  /** Progressive activity rows (live expanded; completed usually collapsed). */
  readonly activities: readonly AgentActivity[];
  /** Tool/action count for the details affordance. */
  readonly actionCount: number;
  /** Technical timeline groups (no Thought cadence rows). */
  readonly details: readonly ProgressGroup[];
}

/** Ordered, user-visible SSE content for the active run. */
export type LiveTranscriptEntry =
  | { readonly kind: "narration"; readonly id: string; readonly content: string }
  | { readonly kind: "activity"; readonly id: string; readonly line: AgentProgressLine };

/** Local-only cursor state; it is deliberately not part of the transcript. */
export function reduceLiveWorking(
  working: boolean,
  event: AgentLiveEvent,
): boolean {
  switch (event.type) {
    case "agent.started":
    case "tool.completed":
      return true;
    case "message.delta":
    case "message.completed":
    case "tool.started":
    case "tool.failed":
    case "document.created":
    case "document.version.advanced":
    case "agent.completed":
    case "agent.failed":
    case "agent.cancelled":
      return false;
    default:
      return working;
  }
}

/**
 * Keep narration beside the tool rows that bound it. Deltas append to one
 * entry; activity rows retain their existing ids as they move active → done.
 */
export function reduceLiveTranscript(
  entries: readonly LiveTranscriptEntry[],
  event: AgentLiveEvent,
  lines: readonly AgentProgressLine[],
): LiveTranscriptEntry[] {
  if (event.type === "message.delta") {
    const messageId = String(event.data.messageId ?? "message");
    const delta = typeof event.data.delta === "string" ? event.data.delta : "";
    if (!delta) return [...entries];
    const last = entries.at(-1);
    if (last?.kind === "narration") {
      return [...entries.slice(0, -1), { ...last, content: last.content + delta }];
    }
    return [
      ...entries,
      {
        kind: "narration",
        id: `narration:${messageId}:${entries.filter((entry) => entry.kind === "narration").length}`,
        content: delta,
      },
    ];
  }

  const toolCallId =
    event.type === "tool.started" ||
    event.type === "tool.completed" ||
    event.type === "tool.failed"
      ? String(event.data.toolCallId ?? "tool")
      : null;
  const toolLine = toolCallId
    ? lines.find((line) => line.id === `tool:${toolCallId}`)
    : undefined;
  let next = toolLine && event.type === "tool.started" && !entries.some((entry) => entry.id === toolLine.id)
    ? [...entries, { kind: "activity" as const, id: toolLine.id, line: toolLine }]
    : [...entries];

  // document.created enriches an existing lifecycle row without adding a row.
  return next.map((entry) =>
    entry.kind === "activity"
      ? { ...entry, line: lines.find((line) => line.id === entry.id) ?? entry.line }
      : entry,
  );
}

const TOOL_LABELS: Record<string, { active: string; done: string }> = {
  "document.inspect": {
    active: "Inspecting document",
    done: "Inspected document",
  },
  "document.find": {
    active: "Searching document",
    done: "Searched document",
  },
  "document.capabilities": {
    active: "Checking capabilities",
    done: "Checked capabilities",
  },
  "document.replace_text": {
    active: "Replacing text",
    done: "Replaced text",
  },
  "document.set_table_cells_text": {
    active: "Updating table cells",
    done: "Updated table cells",
  },
  "document.insert_table_rows": {
    active: "Adding table rows",
    done: "Added table rows",
  },
  "document.insert_table_row": {
    active: "Adding table row",
    done: "Added table row",
  },
  "document.insert_table_column": {
    active: "Adding table column",
    done: "Added table column",
  },
  "document.create_table": {
    active: "Creating table",
    done: "Created table",
  },
  "document.delete_table": {
    active: "Deleting table",
    done: "Deleted table",
  },
  "document.delete_table_row": {
    active: "Deleting table row",
    done: "Deleted table row",
  },
  "document.delete_table_column": {
    active: "Deleting table column",
    done: "Deleted table column",
  },
  "document.set_table_formatting": {
    active: "Formatting table",
    done: "Formatted table",
  },
  "document.set_table_column_widths": {
    active: "Sizing table columns",
    done: "Sized table columns",
  },
  "document.set_table_cell_shading": {
    active: "Shading table cells",
    done: "Shaded table cells",
  },
  "document.insert_paragraph": {
    active: "Adding content",
    done: "Added content",
  },
  "document.insert_paragraphs": {
    active: "Adding content",
    done: "Added content",
  },
  "document.delete_paragraph": {
    active: "Removing content",
    done: "Removed content",
  },
  "document.set_paragraph_style": {
    active: "Setting paragraph style",
    done: "Set paragraph style",
  },
  "document.set_paragraph_formatting": {
    active: "Formatting paragraph",
    done: "Formatted paragraph",
  },
  "document.set_text_formatting": {
    active: "Formatting text",
    done: "Formatted text",
  },
  "document.set_paragraphs_list": {
    active: "Adding list",
    done: "Added list",
  },
  "document.set_hyperlink": {
    active: "Adding link",
    done: "Added link",
  },
  "document.set_content_control_text": {
    active: "Updating field",
    done: "Updated field",
  },
  "document.insert_picture": {
    active: "Adding image",
    done: "Added image",
  },
  "document.delete_picture": {
    active: "Removing image",
    done: "Removed image",
  },
  "document.set_picture_size": {
    active: "Sizing image",
    done: "Sized image",
  },
  "document.replace_picture": {
    active: "Replacing image",
    done: "Replaced image",
  },
  "document.insert_page_break": {
    active: "Adding page break",
    done: "Added page break",
  },
  "document.delete_page_break": {
    active: "Removing page break",
    done: "Removed page break",
  },
  "document.set_page_setup": {
    active: "Updating page setup",
    done: "Updated page setup",
  },
  "document.set_header_footer_text": {
    active: "Updating header/footer",
    done: "Updated header/footer",
  },
  "document.set_page_number": {
    active: "Adding page numbers",
    done: "Added page numbers",
  },
  "workspace.create_blank_docx": {
    active: "Creating document",
    done: "Created document",
  },
  "workspace.create_blank_document": {
    active: "Creating document",
    done: "Created document",
  },
  "workspace.duplicate_current_document": {
    active: "Duplicating document",
    done: "Created copy",
  },
  finish: {
    active: "Completing task",
    done: "Completed task",
  },
  "slides.update_text": {
    active: "Updating slide text",
    done: "Updated slide text",
  },
  "workbook.set_cells": {
    active: "Updating cells",
    done: "Updated cells",
  },
};

const READ_TOOLS = new Set([
  "document.inspect",
  "document.find",
  "document.capabilities",
]);

const LIFECYCLE_TOOLS = new Set([
  "workspace.create_blank_docx",
  "workspace.create_blank_document",
  "workspace.duplicate_current_document",
]);

/** Presentation-only: humanize unknown tool names (no snake_case dump). */
function humanizeToolName(toolName: string): string {
  const leaf = toolName.includes(".")
    ? (toolName.split(".").pop() ?? toolName)
    : toolName;
  const words = leaf.replace(/_/g, " ").trim();
  if (!words) return "Working";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function toolLabels(toolName: string): { active: string; done: string } {
  const mapped = TOOL_LABELS[toolName];
  if (mapped) return mapped;
  const base = humanizeToolName(toolName);
  return {
    active: base.endsWith("ing") ? base : `${base}`,
    done: base,
  };
}

export function activityKindForTool(toolName: string): ActivityKind {
  if (toolName === "finish") return "finish";
  if (READ_TOOLS.has(toolName)) return "read";
  if (LIFECYCLE_TOOLS.has(toolName)) return "lifecycle";
  if (toolName.startsWith("document.") || toolName.startsWith("workspace.")) {
    return "mutate";
  }
  return "other";
}

function weightForKind(kind: ActivityKind): AgentActivity["weight"] {
  if (kind === "read" || kind === "thinking" || kind === "finish") return "quiet";
  if (kind === "mutate" || kind === "lifecycle") return "emphasis";
  return "normal";
}

/**
 * Keep finished Thinking segments in the technical timeline so details can
 * still show cadence. Primary UX filters these out.
 */
function freezeThoughtSegment(
  lines: readonly AgentProgressLine[],
  nowMs: number,
): AgentProgressLine[] {
  const out: AgentProgressLine[] = [];
  for (const line of lines) {
    if (
      (line.id === "thinking" || line.id === "writing") &&
      line.status === "active"
    ) {
      out.push({
        id: `thought:${line.startedAt ?? nowMs}`,
        label: "Thought",
        status: "done",
        startedAt: line.startedAt ?? nowMs,
        endedAt: nowMs,
      });
      continue;
    }
    if (line.id === "thinking" || line.id === "writing") {
      continue;
    }
    out.push(line);
  }
  return out;
}

/**
 * Model is waiting between tools — truthful "Thinking", not answer streaming.
 * Do not claim Thinking while a tool row is active (caller freezes first).
 */
function withModelWait(
  lines: readonly AgentProgressLine[],
  now: number,
): AgentProgressLine[] {
  const base = freezeThoughtSegment(lines, now).filter(
    (line) => line.id !== "writing" && line.id !== "thinking",
  );
  const existing = lines.find(
    (line) =>
      (line.id === "thinking" || line.id === "writing") &&
      line.status === "active",
  );
  return [
    ...base,
    {
      id: "thinking",
      label: "Thinking",
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
    if (
      toolName === "document.set_paragraph_style" ||
      toolName === "document.set_paragraph_formatting" ||
      toolName === "document.set_text_formatting"
    ) {
      return code === "TARGET_AMBIGUOUS"
        ? "Paragraph target ambiguous"
        : "Paragraph target not found";
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
          label: "Thinking",
          status: "active",
          startedAt: nowMs,
        },
      ];
    }
    case "message.started":
      // Between tools / before tokens: keep Thinking if already active.
      if (lines.some((line) => line.id === "thinking" && line.status === "active")) {
        return [...lines];
      }
      return withModelWait(lines, nowMs);
    case "message.delta": {
      // Final answer tokens — freeze model-wait; answer renders below.
      const hasDelta =
        typeof event.data.delta === "string" && event.data.delta.length > 0;
      if (!hasDelta) return [...lines];
      return freezeActive(freezeThoughtSegment(lines, nowMs), nowMs);
    }
    case "message.completed":
      return freezeActive(freezeThoughtSegment(lines, nowMs), nowMs);
    case "tool.started": {
      const toolCallId = String(event.data.toolCallId ?? "tool");
      const toolName = String(event.data.toolName ?? "tool");
      const labels = toolLabels(toolName);
      const kept = freezeThoughtSegment(lines, nowMs).filter(
        (line) => line.id !== `tool:${toolCallId}`,
      );
      return [
        ...kept,
        {
          id: `tool:${toolCallId}`,
          label: labels.active,
          status: "active",
          toolName,
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
      // Preserve document.created name enrichment if it arrived mid-tool.
      const doneLabel =
        previous &&
        previous.toolName &&
        LIFECYCLE_TOOLS.has(previous.toolName) &&
        previous.label.startsWith("Created ") &&
        previous.label !== labels.done &&
        previous.label !== labels.active
          ? previous.label
          : labels.done;
      const withoutActive = freezeThoughtSegment(lines, nowMs).filter(
        (line) => line.id !== id,
      );
      return withModelWait(
        [
          ...withoutActive,
          {
            id,
            label: doneLabel,
            status: "done",
            toolName,
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
      const withoutActive = freezeThoughtSegment(lines, nowMs).filter(
        (line) => line.id !== id,
      );
      return withModelWait(
        [
          ...withoutActive,
          {
            id,
            label: failedToolLabel(toolName, code),
            status: "error",
            toolName,
            ...(code !== undefined ? { errorCode: code } : {}),
            startedAt: previous?.startedAt ?? nowMs,
            endedAt: nowMs,
          },
        ],
        nowMs,
      );
    }
    case "document.created": {
      // Enrich the latest lifecycle tool row with the real document name.
      const name =
        typeof event.data.name === "string" && event.data.name.trim()
          ? event.data.name.trim()
          : undefined;
      if (!name) return [...lines];
      let updated = false;
      const next: AgentProgressLine[] = [];
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (
          !updated &&
          line &&
          line.toolName &&
          LIFECYCLE_TOOLS.has(line.toolName) &&
          (line.status === "done" || line.status === "active")
        ) {
          const isDuplicate =
            line.toolName === "workspace.duplicate_current_document";
          next.unshift({
            ...line,
            label: isDuplicate ? `Created ${name}` : `Created ${name}`,
            status: line.status === "active" ? "done" : line.status,
            endedAt: line.endedAt ?? nowMs,
          });
          updated = true;
          continue;
        }
        if (line) next.unshift(line);
      }
      return updated ? next : [...lines];
    }
    case "confirmation.required": {
      const toolCallId = String(event.data.toolCallId ?? "confirm");
      return [
        ...freezeActive(freezeThoughtSegment(lines, nowMs), nowMs).filter(
          (line) => line.status === "done" || line.status === "error",
        ),
        {
          id: `confirm:${toolCallId}`,
          label: "Waiting for confirmation",
          status: "active",
          startedAt: nowMs,
        },
      ];
    }
    case "agent.completed": {
      // Idempotent: duplicate/late terminal events must not re-freeze or
      // append duplicate terminal rows.
      if (lines.some((line) => isTerminalLine(line))) {
        return [...lines];
      }
      return freezeActive(freezeThoughtSegment(lines, nowMs), nowMs);
    }
    case "agent.failed": {
      if (lines.some((line) => line.id === "failed" || line.id === "cancelled")) {
        return [...lines];
      }
      return [
        ...freezeActive(freezeThoughtSegment(lines, nowMs), nowMs),
        {
          id: "failed",
          label: "Something went wrong",
          status: "error",
          startedAt: nowMs,
          endedAt: nowMs,
        },
      ];
    }
    case "agent.cancelled": {
      if (lines.some((line) => line.id === "cancelled" || line.id === "failed")) {
        return [...lines];
      }
      return [
        ...freezeActive(freezeThoughtSegment(lines, nowMs), nowMs),
        {
          id: "cancelled",
          label: "Stopped",
          status: "done",
          startedAt: nowMs,
          endedAt: nowMs,
        },
      ];
    }
    default:
      return [...lines];
  }
}

/** Cursor-style summary for a finished turn. */
export function thoughtForLabel(
  durationMs: number,
  outcome: AgentTurnProgress["outcome"] = "completed",
  stepCount?: number,
): string {
  const elapsed = formatProgressElapsed(durationMs);
  if (outcome === "cancelled") return `Stopped after ${elapsed}`;
  if (outcome === "failed") return `Couldn't complete · ${elapsed}`;
  if (stepCount !== undefined && stepCount > 0) {
    return `Done in ${elapsed}`;
  }
  return `Done in ${elapsed}`;
}

/**
 * Group consecutive same-label steps (Perplexity-style) so 13× "Inserted
 * paragraph" becomes one row: "Inserted paragraphs · 13".
 */
export interface ProgressGroup {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly status: ProgressLineStatus;
  /** Recovered tool failure — show as muted warning, not destructive error. */
  readonly recovered?: boolean;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

function normalizeGroupLabel(label: string, count: number): string {
  if (count <= 1) return label;
  // Prefer plural forms for common tool completions.
  if (label === "Added content") return "Added content";
  if (label === "Inspected document") return "Inspected document";
  if (label === "Updated table cells") return "Updated table cells";
  if (label === "Thought") return "Thoughts";
  if (label.endsWith("…")) {
    return label.replace(/…$/, "s…");
  }
  if (!label.endsWith("s")) return `${label}s`;
  return label;
}

function isThoughtLine(line: AgentProgressLine): boolean {
  return (
    line.id === "thinking" ||
    line.id === "writing" ||
    line.id.startsWith("thought:") ||
    line.label === "Thought" ||
    line.label === "Thoughts" ||
    line.label === "Thinking" ||
    line.label === "Thinking…" ||
    line.label === "Generating…"
  );
}

function isTerminalLine(line: AgentProgressLine): boolean {
  return line.id === "failed" || line.id === "cancelled";
}

/** Technical details: skip Thought cadence + live model-wait filler. */
export function technicalProgressLines(
  lines: readonly AgentProgressLine[],
): AgentProgressLine[] {
  return lines.filter((line) => !isThoughtLine(line));
}

export function groupProgressLines(
  lines: readonly AgentProgressLine[],
): ProgressGroup[] {
  const groups: ProgressGroup[] = [];
  for (const line of lines) {
    if (line.id === "writing" || line.id === "thinking") continue;

    const baseLabel = line.label
      .replace(/…$/, "")
      .replace(/^Inserting /, "Inserted ")
      .replace(/^Inspecting /, "Inspected ")
      .replace(/^Searching /, "Searched ")
      .replace(/^Updating /, "Updated ")
      .replace(/^Replacing /, "Replaced ")
      .replace(/^Creating /, "Created ")
      .replace(/^Duplicating /, "Duplicated ")
      .replace(/^Adding /, "Added ")
      .replace(/^Setting /, "Set ")
      .replace(/^Formatting /, "Formatted ")
      .replace(/^Removing /, "Removed ")
      .replace(/^Sizing /, "Sized ")
      .replace(/^Shading /, "Shaded ")
      .replace(/^Completing /, "Completed ")
      .trim();

    const last = groups[groups.length - 1];
    if (
      last &&
      last.key === baseLabel &&
      last.status !== "active" &&
      line.status !== "active"
    ) {
      groups[groups.length - 1] = {
        ...last,
        count: last.count + 1,
        label: normalizeGroupLabel(baseLabel, last.count + 1),
        status: line.status === "error" ? "error" : last.status,
        endedAt: line.endedAt ?? last.endedAt,
      };
      continue;
    }

    groups.push({
      key: baseLabel,
      label:
        line.status === "active"
          ? line.label
          : normalizeGroupLabel(baseLabel, 1),
      count: 1,
      status: line.status,
      ...(line.startedAt !== undefined ? { startedAt: line.startedAt } : {}),
      ...(line.endedAt !== undefined ? { endedAt: line.endedAt } : {}),
    });
  }
  return groups;
}

export function activityFamilyForTool(toolName: string): ActivityFamily {
  switch (toolName) {
    case "workspace.create_blank_docx":
    case "workspace.create_blank_document":
    case "workspace.duplicate_current_document":
      return "create";
    case "document.insert_paragraph":
    case "document.insert_paragraphs":
    case "document.delete_paragraph":
    case "document.replace_text":
    case "document.set_content_control_text":
    case "document.set_hyperlink":
    case "slides.update_text":
    case "workbook.set_cells":
      return "content";
    case "document.set_paragraph_style":
      return "structure";
    case "document.set_paragraph_formatting":
    case "document.set_text_formatting":
      return "formatting";
    case "document.set_paragraphs_list":
      return "list";
    case "document.create_table":
    case "document.delete_table":
    case "document.insert_table_rows":
    case "document.insert_table_row":
    case "document.insert_table_column":
    case "document.delete_table_row":
    case "document.delete_table_column":
    case "document.set_table_cells_text":
    case "document.set_table_formatting":
    case "document.set_table_column_widths":
    case "document.set_table_cell_shading":
      return "table";
    case "document.insert_picture":
    case "document.delete_picture":
    case "document.set_picture_size":
    case "document.replace_picture":
      return "media";
    case "document.insert_page_break":
    case "document.delete_page_break":
    case "document.set_page_setup":
    case "document.set_header_footer_text":
    case "document.set_page_number":
      return "layout";
    case "document.inspect":
    case "document.find":
    case "document.capabilities":
      return "inspect";
    default:
      if (toolName.includes("table")) return "table";
      if (toolName.includes("picture") || toolName.includes("image")) {
        return "media";
      }
      if (toolName.includes("page") || toolName.includes("header")) {
        return "layout";
      }
      if (toolName.includes("format") || toolName.includes("style")) {
        return "formatting";
      }
      return "other";
  }
}

function lineFamily(line: AgentProgressLine): ActivityFamily | null {
  if (line.id.startsWith("confirm:")) return "confirm";
  if (line.toolName) return activityFamilyForTool(line.toolName);
  return null;
}

function readGroupDetail(toolName: string, count: number): string {
  if (toolName === "document.inspect") {
    return count === 1 ? "1 inspection" : `${count} inspections`;
  }
  if (toolName === "document.find") {
    return count === 1 ? "1 search" : `${count} searches`;
  }
  return count === 1 ? "1 check" : `${count} checks`;
}

function lineToActivity(line: AgentProgressLine): AgentActivity {
  if (line.id === "thinking" || line.id === "writing") {
    return {
      id: line.id,
      kind: "thinking",
      label: "Thinking",
      status: line.status === "active" ? "active" : "done",
      startedAt: line.startedAt,
      endedAt: line.endedAt,
      liveElapsed: line.status === "active",
      weight: "quiet",
    };
  }
  if (line.id.startsWith("confirm:")) {
    return {
      id: line.id,
      kind: "other",
      label: line.label,
      status: line.status === "pending" ? "active" : line.status,
      startedAt: line.startedAt,
      endedAt: line.endedAt,
      weight: "normal",
    };
  }
  if (isTerminalLine(line)) {
    return {
      id: line.id,
      kind: "other",
      label: line.label,
      status: line.status === "error" ? "error" : "done",
      startedAt: line.startedAt,
      endedAt: line.endedAt,
      weight: "normal",
    };
  }
  const toolName = line.toolName ?? "other";
  const kind = activityKindForTool(toolName);
  return {
    id: line.id,
    kind,
    label: line.label,
    status: line.status === "pending" ? "active" : line.status,
    startedAt: line.startedAt,
    endedAt: line.endedAt,
    weight: weightForKind(kind),
  };
}

/**
 * Project technical progress lines into progressive activity rows.
 * Groups consecutive completed reads; keeps mutations individually visible.
 * Completed Thinking rows are omitted (not chat spam).
 */
export function projectActivityRows(
  lines: readonly AgentProgressLine[],
  options?: { readonly streamingAnswer?: boolean },
): AgentActivity[] {
  const rows: AgentActivity[] = [];
  let pendingReads: AgentProgressLine[] = [];

  const flushReads = () => {
    if (pendingReads.length === 0) return;
    const first = pendingReads[0]!;
    const toolName = first.toolName ?? "document.inspect";
    const labels = toolLabels(toolName);
    if (pendingReads.length === 1) {
      rows.push(lineToActivity(first));
    } else {
      rows.push({
        id: `read-group:${first.id}`,
        kind: "read",
        label: labels.done,
        status: "done",
        detail: readGroupDetail(toolName, pendingReads.length),
        startedAt: first.startedAt,
        endedAt: pendingReads[pendingReads.length - 1]?.endedAt,
        weight: "quiet",
      });
    }
    pendingReads = [];
  };

  for (const line of lines) {
    if (isThoughtLine(line) && line.id.startsWith("thought:")) {
      continue;
    }
    if (line.id === "writing") {
      continue;
    }
    if (line.id === "thinking") {
      flushReads();
      if (line.status !== "active") continue;
      if (options?.streamingAnswer) continue;
      rows.push(lineToActivity(line));
      continue;
    }

    const isRead =
      line.toolName !== undefined &&
      READ_TOOLS.has(line.toolName) &&
      line.status === "done";

    if (isRead) {
      const sameTool =
        pendingReads.length === 0 ||
        pendingReads[0]?.toolName === line.toolName;
      if (!sameTool) flushReads();
      pendingReads.push(line);
      continue;
    }

    flushReads();

    // Active read: keep visible; do not merge into completed group yet.
    if (
      line.toolName &&
      READ_TOOLS.has(line.toolName) &&
      line.status === "active"
    ) {
      rows.push(lineToActivity(line));
      continue;
    }

    if (line.status === "pending") continue;
    rows.push(lineToActivity(line));
  }
  flushReads();
  return rows;
}

/** @deprecated Prefer projectActivityRows — kept for callers/tests during transition. */
export function summarizeAgentActivities(
  lines: readonly AgentProgressLine[],
): AgentActivity[] {
  return projectActivityRows(lines);
}

/**
 * Live headline = newest active activity label (Thinking / tool).
 * Never say Finishing up unless the answer is actually streaming.
 */
export function liveHeadlineFromActivities(
  activities: readonly AgentActivity[],
  lines: readonly AgentProgressLine[],
  options?: { readonly streamingAnswer?: boolean },
): string {
  if (options?.streamingAnswer) return "Finishing up";

  const active = [...activities].reverse().find((a) => a.status === "active");
  if (active) {
    if (active.kind === "thinking") return "Thinking";
    return active.label;
  }

  const thinking = lines.some(
    (line) => line.id === "thinking" && line.status === "active",
  );
  if (thinking && !options?.streamingAnswer) return "Thinking";

  return "Working";
}

function completionSummaryLabel(lines: readonly AgentProgressLine[]): string {
  const technical = technicalProgressLines(visibleAgentProgress(lines));
  let createdName: string | null = null;
  let hasLifecycle = false;
  let hasMutation = false;
  let hasRead = false;

  for (const line of technical) {
    if (!line.toolName) continue;
    if (LIFECYCLE_TOOLS.has(line.toolName) && line.status === "done") {
      hasLifecycle = true;
      if (line.label.startsWith("Created ")) {
        createdName = line.label.slice("Created ".length);
      }
    } else if (READ_TOOLS.has(line.toolName)) {
      hasRead = true;
    } else if (line.toolName !== "finish") {
      hasMutation = true;
    }
  }

  if (createdName) return `Created ${createdName}`;
  if (hasLifecycle && !hasMutation) return "Created document";
  if (hasMutation) return "Updated document";
  if (hasRead) return "Reviewed document";
  return "Done";
}

function completedHeadline(
  lines: readonly AgentProgressLine[],
  outcome: AgentTurnProgress["outcome"],
  durationMs: number | null | undefined,
  actionCount: number,
): string {
  const elapsed =
    durationMs != null ? formatProgressElapsed(durationMs) : null;
  if (outcome === "cancelled") {
    return elapsed ? `Stopped after ${elapsed}` : "Stopped";
  }
  if (outcome === "failed") {
    return elapsed ? `Couldn't complete · ${elapsed}` : "Couldn't complete";
  }
  const summary = completionSummaryLabel(lines);
  const actions =
    actionCount > 0
      ? ` · ${actionCount} ${actionCount === 1 ? "action" : "actions"}`
      : "";
  const time = elapsed ? ` · ${elapsed}` : "";
  return `${summary}${actions}${time}`;
}

function recoveryDetailLabel(label: string): string {
  if (label === "Paragraph target ambiguous") {
    return "Paragraph target ambiguity";
  }
  if (label === "Table cell target ambiguous") {
    return "Table cell target ambiguity";
  }
  if (label === "Table row target ambiguous") {
    return "Table row target ambiguity";
  }
  return label;
}

/**
 * Technical details with consecutive grouping + recovered-error marking.
 * Recovered = error in a family that later succeeds.
 */
export function buildTechnicalDetails(
  lines: readonly AgentProgressLine[],
): ProgressGroup[] {
  const technical = technicalProgressLines(visibleAgentProgress(lines));
  const recoveredIds = new Set<string>();

  for (let i = 0; i < technical.length; i += 1) {
    const line = technical[i];
    if (!line || line.status !== "error") continue;
    const family = lineFamily(line);
    for (let j = i + 1; j < technical.length; j += 1) {
      const later = technical[j];
      if (!later || later.status !== "done") continue;
      if (line.toolName && later.toolName === line.toolName) {
        recoveredIds.add(line.id);
        break;
      }
      const laterFamily = lineFamily(later);
      if (family && laterFamily === family) {
        recoveredIds.add(line.id);
        break;
      }
    }
  }

  const groups: ProgressGroup[] = [];
  for (const line of technical) {
    const recovered = line.status === "error" && recoveredIds.has(line.id);
    const baseLabel = line.label
      .replace(/…$/, "")
      .replace(/^Inserting /, "Inserted ")
      .replace(/^Inspecting /, "Inspected ")
      .replace(/^Searching /, "Searched ")
      .replace(/^Updating /, "Updated ")
      .replace(/^Replacing /, "Replaced ")
      .replace(/^Creating /, "Created ")
      .replace(/^Duplicating /, "Duplicated ")
      .replace(/^Adding /, "Added ")
      .replace(/^Setting /, "Set ")
      .replace(/^Formatting /, "Formatted ")
      .replace(/^Removing /, "Removed ")
      .replace(/^Sizing /, "Sized ")
      .replace(/^Shading /, "Shaded ")
      .replace(/^Completing /, "Completed ")
      .trim();

    const displayLabel = recovered
      ? `Recovered · ${recoveryDetailLabel(baseLabel)}`
      : line.status === "active"
        ? line.label
        : normalizeGroupLabel(baseLabel, 1);

    const groupKey = recovered ? `recovered:${baseLabel}` : baseLabel;
    const last = groups[groups.length - 1];
    if (
      last &&
      last.key === groupKey &&
      last.status !== "active" &&
      line.status !== "active" &&
      Boolean(last.recovered) === recovered
    ) {
      const nextCount = last.count + 1;
      groups[groups.length - 1] = {
        ...last,
        count: nextCount,
        label: recovered
          ? `Recovered · ${recoveryDetailLabel(baseLabel)}`
          : normalizeGroupLabel(baseLabel, nextCount),
        status:
          !recovered && line.status === "error" ? "error" : last.status,
        endedAt: line.endedAt ?? last.endedAt,
      };
      continue;
    }

    groups.push({
      key: groupKey,
      label: displayLabel,
      count: 1,
      status: recovered ? "done" : line.status,
      ...(recovered ? { recovered: true } : {}),
      ...(line.startedAt !== undefined ? { startedAt: line.startedAt } : {}),
      ...(line.endedAt !== undefined ? { endedAt: line.endedAt } : {}),
    });
  }
  return groups;
}

/** Primary + details presentation from technical progress lines. */
export function presentAgentRun(
  lines: readonly AgentProgressLine[],
  options?: {
    readonly live?: boolean;
    readonly durationMs?: number | null;
    readonly outcome?: AgentTurnProgress["outcome"];
    /** True when assistant tokens are streaming (final answer). */
    readonly streamingAnswer?: boolean;
  },
): AgentRunPresentation {
  const activities = projectActivityRows(lines, {
    streamingAnswer: options?.streamingAnswer,
  });
  const details = buildTechnicalDetails(lines);
  const technical = technicalProgressLines(visibleAgentProgress(lines));
  const actionCount = technical.filter(
    (line) =>
      line.id.startsWith("tool:") ||
      line.id.startsWith("confirm:") ||
      line.status === "error" ||
      (line.status === "done" && !isThoughtLine(line) && !isTerminalLine(line)),
  ).length;

  const headline = options?.live
    ? liveHeadlineFromActivities(activities, lines, {
        streamingAnswer: options.streamingAnswer,
      })
    : completedHeadline(
        lines,
        options?.outcome ?? "completed",
        options?.durationMs,
        actionCount,
      );

  return {
    headline,
    activities,
    actionCount,
    details,
  };
}

/** Compact headline for live or finished progress (panel status row). */
export function progressSummaryLabel(
  lines: readonly AgentProgressLine[],
  options?: {
    readonly live?: boolean;
    readonly durationMs?: number | null;
    readonly outcome?: AgentTurnProgress["outcome"];
    readonly streamingAnswer?: boolean;
  },
): string {
  return presentAgentRun(lines, options).headline;
}

/** Details affordance label: "View 16 actions". */
export function detailsAffordanceLabel(actionCount: number): string {
  if (actionCount <= 0) return "View details";
  const noun = actionCount === 1 ? "action" : "actions";
  return `View ${actionCount} ${noun}`;
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
