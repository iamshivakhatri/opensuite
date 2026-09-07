/**
 * Request-shape selectors for document tools.
 * Validates model input shape only — target validity / mutation safety is Rust.
 */

import type {
  DocumentParagraphPlacement,
  DocumentTableCellTarget,
  DocumentTableRowAnchor,
  DocumentTableTarget,
  DocumentTextTarget,
} from "../document-mutation.js";
import type { DocumentInspectFocus } from "../runtime.js";
import { AgentCoreError } from "../errors.js";
import {
  parseOptionalNonNegativeInt,
  parseOptionalOccurrence,
  parseOptionalPositiveInt,
  type StructuralHandle,
} from "./shared-schema.js";

export type { StructuralHandle };

export function parseParagraphPlacement(
  raw: unknown,
  toolName: string,
): DocumentParagraphPlacement {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${toolName} requires a placement object`,
    );
  }
  const placement = raw as Record<string, unknown>;
  const kind = placement.kind;
  if (kind === "start" || kind === "end") {
    return { kind };
  }
  if (kind === "before" || kind === "after") {
    const handle = parseOptionalHandle(placement.handle);
    if (!handle) {
      throw new AgentCoreError(
        "INVALID_TOOL_INPUT",
        `${toolName} placement.${kind} requires a non-empty handle`,
      );
    }
    return { kind, handle };
  }
  throw new AgentCoreError(
    "INVALID_TOOL_INPUT",
    `${toolName} placement.kind must be start|end|before|after`,
  );
}

export function parseTextTarget(
  raw: unknown,
  toolName: string,
): DocumentTextTarget {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${toolName} requires a target object`,
    );
  }
  const target = raw as Record<string, unknown>;
  if (typeof target.text !== "string" || !target.text) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${toolName} target.text must be a non-empty string`,
    );
  }
  const occurrence = parseOptionalOccurrence(
    target.occurrence,
    `${toolName} target.occurrence`,
  );
  return {
    text: target.text,
    ...(occurrence !== undefined ? { occurrence } : {}),
  };
}

export function parseTableTarget(
  raw: unknown,
  toolName: string,
): DocumentTableTarget {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${toolName} requires a table target object`,
    );
  }
  const table = raw as Record<string, unknown>;
  const handle = parseOptionalHandle(table.handle);
  const headerCellsRaw = Array.isArray(table.headerCells)
    ? table.headerCells
    : null;
  if (!handle && (!headerCellsRaw || headerCellsRaw.length === 0)) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${toolName} table requires handle or non-empty headerCells`,
    );
  }
  const headerCells: string[] = [];
  if (headerCellsRaw) {
    for (const cell of headerCellsRaw) {
      if (typeof cell !== "string") {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          `${toolName} table.headerCells must be strings`,
        );
      }
      headerCells.push(cell);
    }
  }
  const occurrence = parseOptionalOccurrence(
    table.occurrence,
    `${toolName} table.occurrence`,
  );
  return {
    ...(headerCells.length > 0 ? { headerCells } : {}),
    ...(occurrence !== undefined ? { occurrence } : {}),
    ...(handle !== undefined ? { handle } : {}),
  };
}

export function parseRowAnchor(
  raw: Record<string, unknown>,
  toolName: string,
): DocumentTableRowAnchor {
  const handle = parseOptionalHandle(raw.handle);
  const firstCellText =
    typeof raw.firstCellText === "string" && raw.firstCellText
      ? raw.firstCellText
      : undefined;
  if (!handle && !firstCellText) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${toolName} after requires handle or non-empty firstCellText`,
    );
  }
  const occurrence = parseOptionalOccurrence(
    raw.occurrence,
    `${toolName} after.occurrence`,
  );
  return {
    ...(firstCellText !== undefined ? { firstCellText } : {}),
    ...(occurrence !== undefined ? { occurrence } : {}),
    ...(handle !== undefined ? { handle } : {}),
  };
}

export function parseCellTarget(
  entry: Record<string, unknown>,
  toolName: string,
): DocumentTableCellTarget {
  const targetSource =
    entry.target && typeof entry.target === "object" && !Array.isArray(entry.target)
      ? (entry.target as Record<string, unknown>)
      : entry;
  const handle = parseOptionalHandle(targetSource.handle);
  if (handle) {
    return { handle };
  }
  const rowLabel =
    typeof targetSource.rowLabel === "string" && targetSource.rowLabel
      ? targetSource.rowLabel
      : undefined;
  const columnHeader =
    typeof targetSource.columnHeader === "string" && targetSource.columnHeader
      ? targetSource.columnHeader
      : undefined;
  if (!rowLabel || !columnHeader) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${toolName} updates require target.handle or rowLabel+columnHeader`,
    );
  }
  const occurrence = parseOptionalOccurrence(
    targetSource.occurrence,
    `${toolName} update occurrence`,
  );
  return {
    rowLabel,
    columnHeader,
    ...(occurrence !== undefined ? { occurrence } : {}),
  };
}

function parseOptionalHandle(value: unknown): StructuralHandle | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export function parseInspectFocus(raw: unknown): DocumentInspectFocus {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      "document.inspect focus must be an object",
    );
  }
  const focus = raw as Record<string, unknown>;
  const kind = focus.kind;
  if (typeof kind !== "string") {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      "document.inspect focus.kind is required",
    );
  }

  switch (kind) {
    case "overview":
    case "structure":
    case "slides":
    case "sheets":
      return { kind };
    case "headings":
    case "paragraphs":
    case "tables":
    case "body_blocks": {
      const offset = parseOptionalNonNegativeInt(
        focus.offset,
        "document.inspect focus.offset",
      );
      const limit = parseOptionalPositiveInt(
        focus.limit,
        "document.inspect focus.limit",
      );
      return {
        kind,
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
    }
    case "slide": {
      if (typeof focus.index !== "number" || !Number.isFinite(focus.index)) {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "document.inspect focus.kind=slide requires numeric index",
        );
      }
      return { kind: "slide", index: Math.floor(focus.index) };
    }
    case "range": {
      const sheet = typeof focus.sheet === "string" ? focus.sheet : undefined;
      const address =
        typeof focus.address === "string" ? focus.address : undefined;
      if (focus.sheet !== undefined && sheet === undefined) {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "document.inspect focus.sheet must be a string",
        );
      }
      if (focus.address !== undefined && address === undefined) {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "document.inspect focus.address must be a string",
        );
      }
      return {
        kind: "range",
        ...(sheet !== undefined ? { sheet } : {}),
        ...(address !== undefined ? { address } : {}),
      };
    }
    case "context": {
      if (typeof focus.text !== "string" || !focus.text) {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "document.inspect focus.kind=context requires non-empty text",
        );
      }
      let occurrence: number | undefined;
      if (focus.occurrence !== undefined) {
        occurrence = parseOptionalOccurrence(
          focus.occurrence,
          "document.inspect focus.occurrence",
        );
      }
      let before: number | undefined;
      if (focus.before !== undefined) {
        if (
          typeof focus.before !== "number" ||
          !Number.isInteger(focus.before) ||
          focus.before < 0
        ) {
          throw new AgentCoreError(
            "INVALID_TOOL_INPUT",
            "document.inspect focus.before must be a non-negative integer",
          );
        }
        before = focus.before;
      }
      let after: number | undefined;
      if (focus.after !== undefined) {
        if (
          typeof focus.after !== "number" ||
          !Number.isInteger(focus.after) ||
          focus.after < 0
        ) {
          throw new AgentCoreError(
            "INVALID_TOOL_INPUT",
            "document.inspect focus.after must be a non-negative integer",
          );
        }
        after = focus.after;
      }
      return {
        kind: "context",
        text: focus.text,
        ...(occurrence !== undefined ? { occurrence } : {}),
        ...(before !== undefined ? { before } : {}),
        ...(after !== undefined ? { after } : {}),
      };
    }
    default:
      throw new AgentCoreError(
        "INVALID_TOOL_INPUT",
        `Unsupported document.inspect focus.kind: ${kind}`,
      );
  }
}
