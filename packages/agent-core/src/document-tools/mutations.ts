import type {
  DocumentTableCellUpdate,
  DocumentTableRowAnchor,
  DocumentTableTarget,
  PersistedDocumentMutationToolResult,
} from "../document-mutation.js";
import type { AgentTool } from "../model.js";
import type { OperationResult } from "../runtime.js";
import {
  assertObject,
  defineDocumentTool,
  executePersistedMutation,
  executeRuntimeMutation,
  invalidInput,
} from "./define-tool.js";
import { DOCUMENT_TOOL_NAMES, DOCX_ENGINE_CAPS, MOCK_FORMAT_CAPS } from "./names.js";
import {
  OCCURRENCE_PROPERTY,
  ROW_ANCHOR_SCHEMA,
  tableTargetSchema,
} from "./shared-schema.js";
import {
  parseCellTarget,
  parseRowAnchor,
  parseTableTarget,
} from "./selectors.js";

export interface DocumentReplaceTextInput {
  readonly find: string;
  readonly replace: string;
  readonly scope?: "all" | "headings" | "paragraphs";
}

export interface DocumentSetTableCellsTextInput {
  readonly table: DocumentTableTarget;
  readonly updates: readonly DocumentTableCellUpdate[];
}

export interface DocumentInsertTableRowsInput {
  readonly table: DocumentTableTarget;
  readonly after: DocumentTableRowAnchor;
  readonly rows: readonly (readonly string[])[];
}

export interface DocumentInsertTableColumnInput {
  readonly table: DocumentTableTarget;
  readonly afterColumnHeader?: string;
  readonly afterColumnHandle?: string;
  readonly header: string;
  readonly cells: readonly string[];
}

export interface SlidesUpdateTextInput {
  readonly slideIndex: number;
  readonly existingText?: string;
  readonly newText?: string;
  readonly title?: string;
}

export interface WorkbookSetCellsInput {
  readonly sheet: string;
  readonly cells: readonly {
    readonly address: string;
    readonly value: string | number | null;
  }[];
}

export function createDocumentReplaceTextTool(): AgentTool<
  DocumentReplaceTextInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.replaceText,
    description:
      "Replace prose/heading text in the active DOCX document (not for semantic table cells). " +
      "Success means an immutable new document version was persisted. " +
      "For table cell updates prefer document.set_table_cells_text after inspect(tables).",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.replaceText,
    inputSchema: {
      type: "object",
      properties: {
        find: { type: "string", description: "Exact substring to replace" },
        replace: { type: "string", description: "Replacement text" },
        scope: {
          type: "string",
          enum: ["all", "headings", "paragraphs"],
          description: "Where to search (default all; ignored by engine runtime)",
        },
      },
      required: ["find", "replace"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.replaceText);
      if (typeof obj.find !== "string" || !obj.find) {
        invalidInput("document.replace_text requires a non-empty find string");
      }
      if (typeof obj.replace !== "string") {
        invalidInput("document.replace_text requires a replace string");
      }
      let scope: "all" | "headings" | "paragraphs" | undefined;
      if (obj.scope !== undefined) {
        if (
          obj.scope !== "all" &&
          obj.scope !== "headings" &&
          obj.scope !== "paragraphs"
        ) {
          invalidInput(
            "document.replace_text scope must be all, headings, or paragraphs",
          );
        }
        scope = obj.scope;
      }
      return {
        find: obj.find,
        replace: obj.replace,
        ...(scope !== undefined ? { scope } : {}),
      };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.replaceText,
        (document, mutations) =>
          mutations.replaceText({
            document,
            find: input.find,
            replace: input.replace,
            signal: ctx.signal,
            runId: ctx.runId,
          }),
        input,
      ),
  });
}

export function createDocumentSetTableCellsTextTool(): AgentTool<
  DocumentSetTableCellsTextInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.setTableCellsText,
    description:
      "Atomically update multiple existing cells in one supported DOCX table. " +
      "Inspect tables first; supply expectedCurrentText from actual cell values. " +
      "Prefer semantic rowLabel + columnHeader when labels are clear and unique. " +
      "Use target.handle with an opaque cell handle from document.inspect(tables) when the row is blank, " +
      "a header is blank, labels are duplicated, or exact structural targeting is easier — blank cells are editable by handle. " +
      "Prefer one multi-cell call over several replace_text calls. " +
      "All updates validate before mutation — one invalid target fails the whole operation. " +
      "After a successful mutation, re-inspect before reusing structural handles. " +
      "On TARGET_NOT_FOUND / PRECONDITION_FAILED / UNSUPPORTED_OPERATION: do not retry; explain and stop. " +
      "Success = immutable version persisted. Capability does not guarantee every table shape is mutable.",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.setTableCellsText,
    inputSchema: {
      type: "object",
      properties: {
        table: tableTargetSchema({
          description:
            "Table target from inspect(tables): headerCells (+ optional occurrence) and/or opaque table handle",
        }),
        updates: {
          type: "array",
          description: "Cell updates in one atomic engine operation",
          items: {
            type: "object",
            properties: {
              target: {
                type: "object",
                description:
                  "Cell selector: { handle } from inspect, or { rowLabel, columnHeader, occurrence? }",
                properties: {
                  handle: {
                    type: "string",
                    description:
                      "Opaque cell handle from inspect(tables) — use for blank/duplicate/awkward cells",
                  },
                  rowLabel: {
                    type: "string",
                    description: "First-column / row-label text from inspection",
                  },
                  columnHeader: {
                    type: "string",
                    description: "Column header text from inspection",
                  },
                  occurrence: OCCURRENCE_PROPERTY,
                },
                additionalProperties: false,
              },
              rowLabel: {
                type: "string",
                description:
                  "Legacy flat semantic selector (same as target.rowLabel)",
              },
              columnHeader: {
                type: "string",
                description:
                  "Legacy flat semantic selector (same as target.columnHeader)",
              },
              expectedCurrentText: {
                type: "string",
                description: "Current cell text (precondition from inspection)",
              },
              replacement: { type: "string", description: "New cell text" },
              occurrence: {
                type: "number",
                description:
                  "Optional 1-based disambiguation for legacy flat semantic form; omit when unique (never send 0)",
              },
            },
            required: ["expectedCurrentText", "replacement"],
            additionalProperties: false,
          },
        },
      },
      required: ["table", "updates"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.setTableCellsText);
      const table = parseTableTarget(
        obj.table,
        DOCUMENT_TOOL_NAMES.setTableCellsText,
      );
      if (!Array.isArray(obj.updates) || obj.updates.length === 0) {
        invalidInput(
          "document.set_table_cells_text requires a non-empty updates array",
        );
      }
      const updates: DocumentTableCellUpdate[] = [];
      for (const item of obj.updates) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          invalidInput(
            "document.set_table_cells_text updates entries must be objects",
          );
        }
        const entry = item as Record<string, unknown>;
        if (
          typeof entry.expectedCurrentText !== "string" ||
          typeof entry.replacement !== "string"
        ) {
          invalidInput(
            "document.set_table_cells_text updates require expectedCurrentText and replacement",
          );
        }
        updates.push({
          target: parseCellTarget(
            entry,
            DOCUMENT_TOOL_NAMES.setTableCellsText,
          ),
          expectedCurrentText: entry.expectedCurrentText,
          replacement: entry.replacement,
        });
      }
      return { table, updates };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.setTableCellsText,
        (document, mutations) =>
          mutations.setTableCellsText({
            document,
            table: input.table,
            updates: input.updates,
            signal: ctx.signal,
            runId: ctx.runId,
          }),
        input,
      ),
  });
}

export function createDocumentInsertTableRowsTool(): AgentTool<
  DocumentInsertTableRowsInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.insertTableRows,
    description:
      "Insert one contiguous block of rows into a supported DOCX table after a row anchor. " +
      "Inspect tables first; preserve column order; every row must supply exactly one string per column. " +
      "Anchor with after.firstCellText (non-empty semantic label) or after.handle (opaque row handle from inspect) " +
      "— use the handle for blank, duplicate, or awkward first cells. " +
      "Use for adding records/guests/items. Do not invent column counts. " +
      "After a successful mutation, re-inspect before reusing structural handles. " +
      "On UNSUPPORTED_OPERATION / TARGET_NOT_FOUND / PRECONDITION_FAILED: do not retry; explain and stop. " +
      "Capability does not guarantee complex/merged/messy tables are writable. Success = immutable version persisted.",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.insertTableRows,
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "object",
          properties: {
            headerCells: {
              type: "array",
              items: { type: "string" },
            },
            occurrence: {
              type: "number",
              description:
                "Optional 1-based table disambiguation; omit when unique (never send 0)",
            },
            handle: {
              type: "string",
              description: "Opaque table handle from inspect(tables)",
            },
          },
          additionalProperties: false,
        },
        after: ROW_ANCHOR_SCHEMA,
        rows: {
          type: "array",
          description: "New rows; each row length must match table width",
          items: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
      required: ["table", "after", "rows"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.insertTableRows);
      const table = parseTableTarget(
        obj.table,
        DOCUMENT_TOOL_NAMES.insertTableRows,
      );
      if (!obj.after || typeof obj.after !== "object" || Array.isArray(obj.after)) {
        invalidInput("document.insert_table_rows requires after row anchor");
      }
      const after = parseRowAnchor(
        obj.after as Record<string, unknown>,
        DOCUMENT_TOOL_NAMES.insertTableRows,
      );
      if (!Array.isArray(obj.rows) || obj.rows.length === 0) {
        invalidInput(
          "document.insert_table_rows requires a non-empty rows array",
        );
      }
      const rows: string[][] = [];
      for (const row of obj.rows) {
        if (!Array.isArray(row) || row.length === 0) {
          invalidInput(
            "document.insert_table_rows each row must be a non-empty string array",
          );
        }
        const cells: string[] = [];
        for (const cell of row) {
          if (typeof cell !== "string") {
            invalidInput(
              "document.insert_table_rows row cells must be strings",
            );
          }
          cells.push(cell);
        }
        rows.push(cells);
      }
      return { table, after, rows };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.insertTableRows,
        (document, mutations) =>
          mutations.insertTableRows({
            document,
            table: input.table,
            after: input.after,
            rows: input.rows,
            signal: ctx.signal,
            runId: ctx.runId,
          }),
        input,
      ),
  });
}

export function createDocumentInsertTableColumnTool(): AgentTool<
  DocumentInsertTableColumnInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.insertTableColumn,
    description:
      "Insert exactly one column into a simple rectangular DOCX table after an existing column. " +
      "Inspect tables first; always pass table.headerCells from inspect (required). " +
      "Optional table.handle / afterColumnHandle refine targeting; cells[] must supply one value per existing data row. " +
      "Anchor with afterColumnHeader (semantic) or afterColumnHandle (opaque column handle from inspect). " +
      "Not a general layout editor — merged/nested/complex tables may return UNSUPPORTED_OPERATION. " +
      "After a successful mutation, re-inspect before reusing structural handles. " +
      "Success = immutable version persisted.",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.insertTableColumn,
    inputSchema: {
      type: "object",
      properties: {
        table: tableTargetSchema({
          requireHeaderCells: true,
          description:
            "Must include headerCells from inspect(tables). Optional handle may accompany them.",
        }),
        afterColumnHeader: {
          type: "string",
          description: "Existing column header to insert after (semantic)",
        },
        afterColumnHandle: {
          type: "string",
          description: "Opaque column handle from inspect(tables)",
        },
        header: {
          type: "string",
          description: "New column header text",
        },
        cells: {
          type: "array",
          items: { type: "string" },
          description: "One value per existing data row, in inspection order",
        },
      },
      required: ["table", "header", "cells"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.insertTableColumn);
      const table = parseTableTarget(
        obj.table,
        DOCUMENT_TOOL_NAMES.insertTableColumn,
      );
      if (!table.headerCells || table.headerCells.length === 0) {
        invalidInput(
          "document.insert_table_column requires non-empty table.headerCells from inspect (handle alone is not enough)",
        );
      }
      const afterColumnHeader =
        typeof obj.afterColumnHeader === "string" && obj.afterColumnHeader
          ? obj.afterColumnHeader
          : undefined;
      const afterColumnHandle =
        typeof obj.afterColumnHandle === "string" && obj.afterColumnHandle
          ? obj.afterColumnHandle
          : undefined;
      if (!afterColumnHeader && !afterColumnHandle) {
        invalidInput(
          "document.insert_table_column requires afterColumnHeader or afterColumnHandle",
        );
      }
      if (typeof obj.header !== "string" || !obj.header) {
        invalidInput(
          "document.insert_table_column requires a non-empty header string",
        );
      }
      if (!Array.isArray(obj.cells)) {
        invalidInput("document.insert_table_column requires a cells array");
      }
      const cells: string[] = [];
      for (const cell of obj.cells) {
        if (typeof cell !== "string") {
          invalidInput("document.insert_table_column cells must be strings");
        }
        cells.push(cell);
      }
      return {
        table,
        ...(afterColumnHeader !== undefined ? { afterColumnHeader } : {}),
        ...(afterColumnHandle !== undefined ? { afterColumnHandle } : {}),
        header: obj.header,
        cells,
      };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.insertTableColumn,
        (document, mutations) =>
          mutations.insertTableColumn({
            document,
            table: input.table,
            ...(input.afterColumnHeader !== undefined
              ? { afterColumnHeader: input.afterColumnHeader }
              : {}),
            ...(input.afterColumnHandle !== undefined
              ? { afterColumnHandle: input.afterColumnHandle }
              : {}),
            header: input.header,
            cells: input.cells,
            signal: ctx.signal,
            runId: ctx.runId,
          }),
        input,
      ),
  });
}

export function createSlidesUpdateTextTool(): AgentTool<
  SlidesUpdateTextInput,
  OperationResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.updateSlideText,
    description:
      "Update text on a PPTX slide. Provide slideIndex (0-based) plus either " +
      "title, or existingText+newText to replace matching title/body text. " +
      "Verify with document.inspect afterward.",
    effect: "write",
    executionMode: "sequential",
    capability: MOCK_FORMAT_CAPS.updateSlideText,
    inputSchema: {
      type: "object",
      properties: {
        slideIndex: {
          type: "number",
          description: "0-based slide index",
        },
        existingText: {
          type: "string",
          description: "Existing substring to replace on the slide",
        },
        newText: {
          type: "string",
          description: "Replacement text when using existingText",
        },
        title: {
          type: "string",
          description: "Set the slide title directly (optional alternative)",
        },
      },
      required: ["slideIndex"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.updateSlideText);
      if (typeof obj.slideIndex !== "number" || !Number.isFinite(obj.slideIndex)) {
        invalidInput("slides.update_text requires numeric slideIndex");
      }
      const title =
        obj.title === undefined
          ? undefined
          : typeof obj.title === "string"
            ? obj.title
            : null;
      if (title === null) {
        invalidInput("slides.update_text title must be a string when provided");
      }
      const existingText =
        obj.existingText === undefined
          ? undefined
          : typeof obj.existingText === "string"
            ? obj.existingText
            : null;
      const newText =
        obj.newText === undefined
          ? undefined
          : typeof obj.newText === "string"
            ? obj.newText
            : null;
      if (existingText === null || newText === null) {
        invalidInput(
          "slides.update_text existingText/newText must be strings when provided",
        );
      }
      if (title === undefined && (existingText === undefined || newText === undefined)) {
        invalidInput(
          "slides.update_text requires title, or existingText+newText",
        );
      }
      return {
        slideIndex: Math.floor(obj.slideIndex),
        ...(title !== undefined ? { title } : {}),
        ...(existingText !== undefined ? { existingText } : {}),
        ...(newText !== undefined ? { newText } : {}),
      };
    },
    execute: (input, ctx) =>
      executeRuntimeMutation(ctx, "slides.update_text", {
        slideIndex: input.slideIndex,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.existingText !== undefined
          ? { existingText: input.existingText }
          : {}),
        ...(input.newText !== undefined ? { newText: input.newText } : {}),
      }),
  });
}

export function createWorkbookSetCellsTool(): AgentTool<
  WorkbookSetCellsInput,
  OperationResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.setCells,
    description:
      "Set one or more cell values on an XLSX sheet (small range write). " +
      "Provide sheet name and cells[{address,value}]. Verify with document.inspect afterward.",
    effect: "write",
    executionMode: "sequential",
    capability: MOCK_FORMAT_CAPS.setCells,
    inputSchema: {
      type: "object",
      properties: {
        sheet: { type: "string", description: "Sheet name" },
        cells: {
          type: "array",
          description: "Cells to write",
          items: {
            type: "object",
            properties: {
              address: { type: "string", description: "A1-style address" },
              value: {
                description: "New cell value (string, number, or null)",
              },
            },
            required: ["address", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["sheet", "cells"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.setCells);
      if (typeof obj.sheet !== "string" || !obj.sheet.trim()) {
        invalidInput("workbook.set_cells requires a non-empty sheet name");
      }
      if (!Array.isArray(obj.cells) || obj.cells.length === 0) {
        invalidInput("workbook.set_cells requires a non-empty cells array");
      }
      const cells: { address: string; value: string | number | null }[] = [];
      for (const entry of obj.cells) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          invalidInput("workbook.set_cells cells entries must be objects");
        }
        const row = entry as Record<string, unknown>;
        if (typeof row.address !== "string" || !row.address.trim()) {
          invalidInput(
            "workbook.set_cells cells[].address must be a non-empty string",
          );
        }
        const value = row.value;
        if (
          value !== null &&
          typeof value !== "string" &&
          typeof value !== "number"
        ) {
          invalidInput(
            "workbook.set_cells cells[].value must be string, number, or null",
          );
        }
        cells.push({
          address: row.address.trim(),
          value: value as string | number | null,
        });
      }
      return { sheet: obj.sheet.trim(), cells };
    },
    execute: (input, ctx) =>
      executeRuntimeMutation(ctx, "workbook.set_cells", {
        sheet: input.sheet,
        cells: input.cells.map((cell) => ({
          address: cell.address,
          value: cell.value,
        })),
      }),
  });
}
