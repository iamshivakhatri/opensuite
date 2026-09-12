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

/** Semantic activity family for the primary (non-technical) run UX. */
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

export interface AgentActivity {
  readonly family: ActivityFamily;
  readonly label: string;
  readonly status: "active" | "done" | "error";
  /** Successful underlying operations collapsed into this row. */
  readonly changeCount: number;
}

export interface AgentRunPresentation {
  /** Compact status line: active verb or "Done in …". */
  readonly headline: string;
  /** Meaningful grouped milestones for the default view. */
  readonly activities: readonly AgentActivity[];
  /** Tool/action count for the details affordance. */
  readonly actionCount: number;
  /** Technical timeline groups (no Thought cadence rows). */
  readonly details: readonly ProgressGroup[];
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
  "document.insert_table_row": {
    active: "Inserting table row…",
    done: "Inserted table row",
  },
  "document.insert_table_column": {
    active: "Inserting table column…",
    done: "Inserted table column",
  },
  "document.create_table": {
    active: "Creating table…",
    done: "Created table",
  },
  "document.delete_table": {
    active: "Deleting table…",
    done: "Deleted table",
  },
  "document.delete_table_row": {
    active: "Deleting table row…",
    done: "Deleted table row",
  },
  "document.delete_table_column": {
    active: "Deleting table column…",
    done: "Deleted table column",
  },
  "document.set_table_formatting": {
    active: "Formatting table…",
    done: "Formatted table",
  },
  "document.set_table_column_widths": {
    active: "Sizing table columns…",
    done: "Sized table columns",
  },
  "document.set_table_cell_shading": {
    active: "Shading table cells…",
    done: "Shaded table cells",
  },
  "document.insert_paragraph": {
    active: "Inserting paragraph…",
    done: "Inserted paragraph",
  },
  "document.insert_paragraphs": {
    active: "Inserting paragraphs…",
    done: "Inserted paragraphs",
  },
  "document.delete_paragraph": {
    active: "Deleting paragraph…",
    done: "Deleted paragraph",
  },
  "document.set_paragraph_style": {
    active: "Setting paragraph style…",
    done: "Set paragraph style",
  },
  "document.set_paragraph_formatting": {
    active: "Formatting paragraph…",
    done: "Formatted paragraph",
  },
  "document.set_text_formatting": {
    active: "Formatting text…",
    done: "Formatted text",
  },
  "document.set_paragraphs_list": {
    active: "Adding list…",
    done: "Added list",
  },
  "document.set_hyperlink": {
    active: "Adding link…",
    done: "Added link",
  },
  "document.set_content_control_text": {
    active: "Updating field…",
    done: "Updated field",
  },
  "document.insert_picture": {
    active: "Adding image…",
    done: "Added image",
  },
  "document.delete_picture": {
    active: "Removing image…",
    done: "Removed image",
  },
  "document.set_picture_size": {
    active: "Sizing image…",
    done: "Sized image",
  },
  "document.replace_picture": {
    active: "Replacing image…",
    done: "Replaced image",
  },
  "document.insert_page_break": {
    active: "Adding page break…",
    done: "Added page break",
  },
  "document.delete_page_break": {
    active: "Removing page break…",
    done: "Removed page break",
  },
  "document.set_page_setup": {
    active: "Updating page setup…",
    done: "Updated page setup",
  },
  "document.set_header_footer_text": {
    active: "Updating header/footer…",
    done: "Updated header/footer",
  },
  "document.set_page_number": {
    active: "Adding page numbers…",
    done: "Added page numbers",
  },
  "workspace.create_blank_docx": {
    active: "Creating document…",
    done: "Created document",
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
      active: "Working…",
      done: "Completed step",
    }
  );
}

/**
 * Keep finished Thinking/Generating segments in the technical timeline so
 * details can still show cadence. Primary UX filters these out.
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

/** Model is working between tools — never re-introduce initial "Thinking…". */
function withGenerating(
  lines: readonly AgentProgressLine[],
  now: number,
): AgentProgressLine[] {
  const base = freezeThoughtSegment(lines, now).filter(
    (line) => line.id !== "writing",
  );
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
          ...freezeActive(freezeThoughtSegment(lines, nowMs), nowMs),
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
      const withoutActive = freezeThoughtSegment(lines, nowMs).filter(
        (line) => line.id !== id,
      );
      return withGenerating(
        [
          ...withoutActive,
          {
            id,
            label: labels.done,
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
      return withGenerating(
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
    case "confirmation.required": {
      const toolCallId = String(event.data.toolCallId ?? "confirm");
      return [
        ...freezeActive(freezeThoughtSegment(lines, nowMs), nowMs).filter(
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
      return freezeActive(freezeThoughtSegment(lines, nowMs), nowMs);
    case "agent.failed":
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
    case "agent.cancelled":
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
  readonly startedAt?: number;
  readonly endedAt?: number;
}

function normalizeGroupLabel(label: string, count: number): string {
  if (count <= 1) return label;
  // Prefer plural forms for common tool completions.
  if (label === "Inserted paragraph") return "Inserted paragraphs";
  if (label === "Inserting paragraph…") return "Inserting paragraphs…";
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
    line.label === "Thinking…" ||
    line.label === "Generating…"
  );
}

function isTerminalLine(line: AgentProgressLine): boolean {
  return line.id === "failed" || line.id === "cancelled";
}

/** Technical details: skip Thought cadence + live Generating filler. */
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
    // Skip only the live Generating filler — finished "Thought" segments stay
    // when callers pass the raw timeline; primary callers use technical lines.
    if (line.id === "writing") continue;

    const baseLabel = line.label
      .replace(/…$/, "")
      .replace(/^Inserting /, "Inserted ")
      .replace(/^Inspecting /, "Inspected ")
      .replace(/^Updating /, "Updated ")
      .replace(/^Replacing /, "Replaced ")
      .replace(/^Searching /, "Searched ")
      .replace(/^Creating /, "Created ")
      .replace(/^Setting /, "Set ")
      .replace(/^Formatting /, "Formatted ")
      .replace(/^Adding /, "Added ")
      .replace(/^Removing /, "Removed ")
      .replace(/^Sizing /, "Sized ")
      .replace(/^Shading /, "Shaded ")
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

function familyFromLabel(label: string): ActivityFamily | null {
  const lower = label.toLowerCase();
  if (lower.includes("blank document") || lower.includes("creating document") || lower.includes("created document")) {
    return "create";
  }
  if (lower.includes("paragraph style") || lower.includes("structuring")) {
    return "structure";
  }
  if (lower.includes("format") || lower.includes("formatted")) {
    return "formatting";
  }
  if (lower.includes("table")) return "table";
  if (lower.includes("list")) return "list";
  if (lower.includes("image") || lower.includes("picture")) return "media";
  if (
    lower.includes("page number") ||
    lower.includes("header") ||
    lower.includes("footer") ||
    lower.includes("page break") ||
    lower.includes("page setup")
  ) {
    return "layout";
  }
  if (
    lower.includes("inspect") ||
    lower.includes("search") ||
    lower.includes("capabilities") ||
    lower.includes("review")
  ) {
    return "inspect";
  }
  if (
    lower.includes("paragraph") ||
    lower.includes("replacing") ||
    lower.includes("replaced") ||
    lower.includes("content") ||
    lower.includes("link") ||
    lower.includes("field") ||
    lower.includes("slide") ||
    lower.includes("cell")
  ) {
    return "content";
  }
  if (lower.includes("confirmation")) return "confirm";
  return null;
}

function activityLabels(family: ActivityFamily): {
  active: string;
  done: string;
  error: string;
} {
  switch (family) {
    case "create":
      return {
        active: "Creating document…",
        done: "Created document",
        error: "Couldn't create document",
      };
    case "content":
      return {
        active: "Writing content…",
        done: "Added content",
        error: "Couldn't add content",
      };
    case "structure":
      return {
        active: "Structuring sections…",
        done: "Structured sections",
        error: "Couldn't structure one section",
      };
    case "formatting":
      return {
        active: "Formatting document…",
        done: "Formatted document",
        error: "Couldn't format one section",
      };
    case "table":
      return {
        active: "Adding table…",
        done: "Added table",
        error: "Couldn't update table",
      };
    case "list":
      return {
        active: "Adding list…",
        done: "Added list",
        error: "Couldn't add list",
      };
    case "media":
      return {
        active: "Adding images…",
        done: "Added images",
        error: "Couldn't add image",
      };
    case "layout":
      return {
        active: "Setting up pages…",
        done: "Updated page layout",
        error: "Couldn't update page layout",
      };
    case "inspect":
      return {
        active: "Reviewing document…",
        done: "Reviewed document",
        error: "Couldn't review document",
      };
    case "confirm":
      return {
        active: "Waiting for confirmation…",
        done: "Confirmed",
        error: "Confirmation denied",
      };
    case "other":
      return {
        active: "Working…",
        done: "Completed step",
        error: "Couldn't finish a step",
      };
  }
}

type FamilyBucket = {
  family: ActivityFamily;
  successCount: number;
  active: boolean;
  /** True when the latest outcome for this family is an unrecovered error. */
  unrecoveredError: boolean;
};

/**
 * Collapse technical tool lines into semantic activity rows.
 * Recovered failures (error then later success in the same family) stay hidden.
 */
export function summarizeAgentActivities(
  lines: readonly AgentProgressLine[],
): AgentActivity[] {
  const order: ActivityFamily[] = [];
  const buckets = new Map<ActivityFamily, FamilyBucket>();

  const ensure = (family: ActivityFamily): FamilyBucket => {
    let bucket = buckets.get(family);
    if (!bucket) {
      bucket = {
        family,
        successCount: 0,
        active: false,
        unrecoveredError: false,
      };
      buckets.set(family, bucket);
      order.push(family);
    }
    return bucket;
  };

  for (const line of lines) {
    if (isThoughtLine(line) || isTerminalLine(line)) continue;

    if (line.id.startsWith("confirm:")) {
      const bucket = ensure("confirm");
      bucket.active = line.status === "active";
      if (line.status === "done") {
        bucket.successCount += 1;
        bucket.unrecoveredError = false;
      }
      continue;
    }

    const family =
      (line.toolName ? activityFamilyForTool(line.toolName) : null) ??
      familyFromLabel(line.label) ??
      "other";
    const bucket = ensure(family);

    if (line.status === "active") {
      bucket.active = true;
      continue;
    }

    bucket.active = false;
    if (line.status === "done") {
      bucket.successCount += 1;
      bucket.unrecoveredError = false;
      continue;
    }
    if (line.status === "error") {
      // Recovered only if a later success clears this flag.
      bucket.unrecoveredError = true;
    }
  }

  const activities: AgentActivity[] = [];
  for (const family of order) {
    const bucket = buckets.get(family);
    if (!bucket) continue;

    // Skip families that only had recovered errors and no successes/active.
    if (
      !bucket.active &&
      bucket.successCount === 0 &&
      !bucket.unrecoveredError
    ) {
      continue;
    }

    const labels = activityLabels(family);
    let status: AgentActivity["status"];
    let label: string;
    if (bucket.active) {
      status = "active";
      label = labels.active;
    } else if (bucket.unrecoveredError && bucket.successCount === 0) {
      status = "error";
      label = labels.error;
    } else if (bucket.unrecoveredError && bucket.successCount > 0) {
      // Partial: some succeeded, last attempt still failed — surface gently.
      status = "error";
      label = labels.error;
    } else {
      status = "done";
      label = labels.done;
    }

    activities.push({
      family,
      label,
      status,
      changeCount: bucket.successCount,
    });
  }
  return activities;
}

function liveHeadlineFromActivities(
  activities: readonly AgentActivity[],
  lines: readonly AgentProgressLine[],
): string {
  const active = [...activities].reverse().find((a) => a.status === "active");
  if (active) return active.label;

  const writing = lines.some(
    (line) => line.id === "writing" && line.status === "active",
  );
  if (writing) return "Finishing up…";

  const thinking = lines.some(
    (line) => line.id === "thinking" && line.status === "active",
  );
  if (thinking) {
    return activities.some((a) => a.family === "create")
      ? "Creating document…"
      : "Working…";
  }

  if (activities.length > 0) return "Working…";
  return "Working…";
}

function completedHeadline(
  outcome: AgentTurnProgress["outcome"],
  durationMs: number | null | undefined,
): string {
  const elapsed =
    durationMs != null ? formatProgressElapsed(durationMs) : null;
  if (outcome === "cancelled") {
    return elapsed ? `Stopped after ${elapsed}` : "Stopped";
  }
  if (outcome === "failed") {
    return elapsed ? `Couldn't complete · ${elapsed}` : "Couldn't complete";
  }
  return elapsed ? `Done in ${elapsed}` : "Done";
}

/** Primary + details presentation from technical progress lines. */
export function presentAgentRun(
  lines: readonly AgentProgressLine[],
  options?: {
    readonly live?: boolean;
    readonly durationMs?: number | null;
    readonly outcome?: AgentTurnProgress["outcome"];
  },
): AgentRunPresentation {
  const activities = summarizeAgentActivities(lines);
  const technical = technicalProgressLines(visibleAgentProgress(lines));
  const details = groupProgressLines(technical);
  const actionCount = technical.filter(
    (line) =>
      line.id.startsWith("tool:") ||
      line.id.startsWith("confirm:") ||
      line.status === "error" ||
      (line.status === "done" && !isThoughtLine(line) && !isTerminalLine(line)),
  ).length;

  const headline = options?.live
    ? liveHeadlineFromActivities(activities, lines)
    : completedHeadline(options?.outcome ?? "completed", options?.durationMs);

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
