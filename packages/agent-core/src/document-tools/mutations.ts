import type {
  DocumentParagraphAlignment,
  DocumentParagraphPlacement,
  DocumentTableCellUpdate,
  DocumentTableRowAnchor,
  DocumentTableTarget,
  DocumentTextTarget,
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
  TEXT_TARGET_SCHEMA,
  tableTargetSchema,
} from "./shared-schema.js";
import {
  parseCellTarget,
  parseParagraphPlacement,
  parseRowAnchor,
  parseTableTarget,
  parseTextTarget,
} from "./selectors.js";

export interface DocumentReplaceTextInput {
  readonly find: string;
  readonly replace: string;
  readonly scope?: "all" | "headings" | "paragraphs";
}

export type DocumentParagraphPlacementInput =
  | { readonly kind: "start" }
  | { readonly kind: "end" }
  | { readonly kind: "before"; readonly handle: string }
  | { readonly kind: "after"; readonly handle: string };

export interface DocumentInsertParagraphInput {
  readonly text: string;
  readonly placement: DocumentParagraphPlacementInput;
}

export interface DocumentInsertParagraphsInput {
  readonly texts: readonly string[];
  readonly placement: DocumentParagraphPlacementInput;
}

export interface DocumentDeleteParagraphInput {
  readonly target: DocumentTextTarget;
}

export interface DocumentSetParagraphStyleInput {
  readonly target: DocumentTextTarget;
  /** Omit to clear the paragraph style. */
  readonly style?: string;
}

export interface DocumentSetParagraphFormattingInput {
  readonly target: DocumentTextTarget;
  readonly alignment?: DocumentParagraphAlignment;
  readonly spacingBeforeTwips?: number;
  readonly spacingAfterTwips?: number;
}

export interface DocumentSetTextFormattingInput {
  readonly target: DocumentTextTarget;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly fontSizeHalfPoints?: number;
  readonly fontFamily?: string;
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

export interface DocumentCreateTableInput {
  readonly rows: readonly (readonly string[])[];
  readonly placement: DocumentParagraphPlacementInput;
}

export interface DocumentDeleteTableInput {
  readonly table: DocumentTableTarget;
}

export interface DocumentDeleteTableRowInput {
  readonly table: DocumentTableTarget;
  readonly row: DocumentTableRowAnchor;
}

export interface DocumentDeleteTableColumnInput {
  readonly table: DocumentTableTarget;
  readonly columnHeader?: string;
  readonly columnHandle?: string;
}

export type DocumentTableAlignment = "left" | "center" | "right" | "clear";
export type DocumentTableBorders = "grid" | "none" | "clear";

export interface DocumentSetTableFormattingInput {
  readonly table: DocumentTableTarget;
  readonly alignment?: DocumentTableAlignment;
  readonly cellMarginTopTwips?: number;
  readonly cellMarginRightTwips?: number;
  readonly cellMarginBottomTwips?: number;
  readonly cellMarginLeftTwips?: number;
  readonly borders?: DocumentTableBorders;
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

export function createDocumentInsertParagraphTool(): AgentTool<
  DocumentInsertParagraphInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.insertParagraph,
    description:
      "Insert a single new paragraph into the active DOCX document. " +
      "Pass a full human paragraph (usually multiple sentences) or a short heading. " +
      "When creating several consecutive paragraphs you already know, prefer document.insert_paragraphs (one atomic version). " +
      "Use inspect(body_blocks) first when placement relative to existing content matters. " +
      "placement: start | end | before {handle} | after {handle} (body-block handles from inspect). " +
      "After a structural mutation, re-inspect before reusing handles. " +
      "Success means an immutable new document version was persisted.",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.insertParagraph,
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "Full paragraph or heading text (prefer multi-sentence prose; avoid one short line per call)",
        },
        placement: {
          type: "object",
          description:
            "Where to insert: start/end of body, or before/after a body-block handle",
          properties: {
            kind: {
              type: "string",
              enum: ["start", "end", "before", "after"],
            },
            handle: {
              type: "string",
              description:
                "Opaque body-block handle from inspect(body_blocks) when kind is before|after",
            },
          },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      required: ["text", "placement"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.insertParagraph);
      if (typeof obj.text !== "string") {
        invalidInput("document.insert_paragraph requires a text string");
      }
      const placement = parseParagraphPlacement(
        obj.placement,
        DOCUMENT_TOOL_NAMES.insertParagraph,
      );
      return { text: obj.text, placement };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.insertParagraph,
        (document, mutations) =>
          mutations.insertParagraph({
            document,
            text: input.text,
            placement: input.placement as DocumentParagraphPlacement,
            signal: ctx.signal,
            runId: ctx.runId,
          }),
        input,
      ),
  });
}

const PARAGRAPH_PLACEMENT_SCHEMA = {
  type: "object",
  description:
    "Where to insert: start/end of body, or before/after a body-block handle",
  properties: {
    kind: {
      type: "string",
      enum: ["start", "end", "before", "after"],
    },
    handle: {
      type: "string",
      description:
        "Opaque body-block handle from inspect(body_blocks) when kind is before|after",
    },
  },
  required: ["kind"],
  additionalProperties: false,
} as const;

export function createDocumentInsertParagraphsTool(): AgentTool<
  DocumentInsertParagraphsInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.insertParagraphs,
    description:
      "Atomically insert multiple consecutive paragraphs in one mutation (one immutable version). " +
      "Prefer this over repeated document.insert_paragraph when you already know several paragraphs to create. " +
      "Each texts[] entry should be a full human paragraph or short heading. " +
      "Same placement model as insert_paragraph (start|end|before|after body-block handles). " +
      "Do not pass styles here — compose with set_paragraph_style afterward. " +
      "Success means one immutable new document version was persisted.",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.insertParagraphs,
    inputSchema: {
      type: "object",
      properties: {
        texts: {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1,
          description:
            "Non-empty ordered paragraph texts (prefer multi-sentence prose per entry)",
        },
        placement: PARAGRAPH_PLACEMENT_SCHEMA,
      },
      required: ["texts", "placement"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.insertParagraphs);
      if (!Array.isArray(obj.texts)) {
        invalidInput(
          "document.insert_paragraphs requires texts: string[] (non-empty)",
        );
      }
      if (obj.texts.length === 0) {
        invalidInput(
          "document.insert_paragraphs texts must contain at least one string",
        );
      }
      const texts: string[] = [];
      for (const item of obj.texts) {
        if (typeof item !== "string") {
          invalidInput(
            "document.insert_paragraphs texts entries must be strings",
          );
        }
        if (item.length === 0) {
          invalidInput(
            "document.insert_paragraphs texts entries must be non-empty strings",
          );
        }
        texts.push(item);
      }
      if (obj.placement === undefined) {
        invalidInput(
          "document.insert_paragraphs requires placement: { kind: start|end|before|after, handle? }",
        );
      }
      const placement = parseParagraphPlacement(
        obj.placement,
        DOCUMENT_TOOL_NAMES.insertParagraphs,
      );
      return { texts, placement };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.insertParagraphs,
        (document, mutations) =>
          mutations.insertParagraphs({
            document,
            texts: input.texts,
            placement: input.placement as DocumentParagraphPlacement,
            signal: ctx.signal,
            runId: ctx.runId,
          }),
        input,
      ),
  });
}

export function createDocumentDeleteParagraphTool(): AgentTool<
  DocumentDeleteParagraphInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.deleteParagraph,
    description:
      "Delete one paragraph matched by exact visible text (optional occurrence). " +
      "Do not empty text with replace_text — use this tool. " +
      "After success, re-inspect before reusing structural handles. " +
      "Success means an immutable new document version was persisted.",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.deleteParagraph,
    inputSchema: {
      type: "object",
      properties: {
        target: TEXT_TARGET_SCHEMA,
      },
      required: ["target"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.deleteParagraph);
      return {
        target: parseTextTarget(obj.target, DOCUMENT_TOOL_NAMES.deleteParagraph),
      };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.deleteParagraph,
        (document, mutations) =>
          mutations.deleteParagraph({
            document,
            target: input.target,
            signal: ctx.signal,
            runId: ctx.runId,
          }),
        input,
      ),
  });
}

export function createDocumentSetParagraphStyleTool(): AgentTool<
  DocumentSetParagraphStyleInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.setParagraphStyle,
    description:
      "Set or clear a paragraph's style by display name (e.g. Heading 1). " +
      "Target by exact visible text after insert/inspect. Omit style to clear. " +
      "Compose with insert_paragraphs rather than embedding style in insertion. " +
      "Success means an immutable new document version was persisted.",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.setParagraphStyle,
    inputSchema: {
      type: "object",
      properties: {
        target: TEXT_TARGET_SCHEMA,
        style: {
          type: "string",
          description:
            "Existing style display name (e.g. Heading 1). Omit to clear.",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.setParagraphStyle);
      const target = parseTextTarget(
        obj.target,
        DOCUMENT_TOOL_NAMES.setParagraphStyle,
      );
      if (obj.style !== undefined && typeof obj.style !== "string") {
        invalidInput("document.set_paragraph_style style must be a string");
      }
      return {
        target,
        ...(typeof obj.style === "string" ? { style: obj.style } : {}),
      };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.setParagraphStyle,
        (document, mutations) =>
          mutations.setParagraphStyle({
            document,
            target: input.target,
            ...(input.style !== undefined ? { style: input.style } : {}),
            signal: ctx.signal,
            runId: ctx.runId,
          }),
        input,
      ),
  });
}

export function createDocumentSetParagraphFormattingTool(): AgentTool<
  DocumentSetParagraphFormattingInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.setParagraphFormatting,
    description:
      "Apply paragraph-level formatting (alignment, spacing before/after in twips). " +
      "Target by exact visible text. Use for centering, spacing adjustments, etc. " +
      "Success means an immutable new document version was persisted.",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.setParagraphFormatting,
    inputSchema: {
      type: "object",
      properties: {
        target: TEXT_TARGET_SCHEMA,
        alignment: {
          type: "string",
          enum: ["left", "center", "right"],
        },
        spacingBeforeTwips: {
          type: "number",
          description: "Spacing before paragraph in twips",
        },
        spacingAfterTwips: {
          type: "number",
          description: "Spacing after paragraph in twips",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(
        raw,
        DOCUMENT_TOOL_NAMES.setParagraphFormatting,
      );
      const target = parseTextTarget(
        obj.target,
        DOCUMENT_TOOL_NAMES.setParagraphFormatting,
      );
      let alignment: DocumentParagraphAlignment | undefined;
      if (obj.alignment !== undefined) {
        if (
          obj.alignment !== "left" &&
          obj.alignment !== "center" &&
          obj.alignment !== "right"
        ) {
          invalidInput(
            "document.set_paragraph_formatting alignment must be left|center|right",
          );
        }
        alignment = obj.alignment;
      }
      const spacingBeforeTwips = parseOptionalIntField(
        obj.spacingBeforeTwips,
        "document.set_paragraph_formatting spacingBeforeTwips",
      );
      const spacingAfterTwips = parseOptionalIntField(
        obj.spacingAfterTwips,
        "document.set_paragraph_formatting spacingAfterTwips",
      );
      return {
        target,
        ...(alignment !== undefined ? { alignment } : {}),
        ...(spacingBeforeTwips !== undefined ? { spacingBeforeTwips } : {}),
        ...(spacingAfterTwips !== undefined ? { spacingAfterTwips } : {}),
      };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.setParagraphFormatting,
        (document, mutations) =>
          mutations.setParagraphFormatting({
            document,
            target: input.target,
            ...(input.alignment !== undefined
              ? { alignment: input.alignment }
              : {}),
            ...(input.spacingBeforeTwips !== undefined
              ? { spacingBeforeTwips: input.spacingBeforeTwips }
              : {}),
            ...(input.spacingAfterTwips !== undefined
              ? { spacingAfterTwips: input.spacingAfterTwips }
              : {}),
            signal: ctx.signal,
            runId: ctx.runId,
          }),
        input,
      ),
  });
}

export function createDocumentSetTextFormattingTool(): AgentTool<
  DocumentSetTextFormattingInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.setTextFormatting,
    description:
      "Apply character formatting (bold, italic, font size in half-points, font family) " +
      "to a text run matched by exact visible text. " +
      "Success means an immutable new document version was persisted.",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.setTextFormatting,
    inputSchema: {
      type: "object",
      properties: {
        target: TEXT_TARGET_SCHEMA,
        bold: { type: "boolean" },
        italic: { type: "boolean" },
        fontSizeHalfPoints: {
          type: "number",
          description: "Font size in Word half-points (e.g. 24 = 12pt)",
        },
        fontFamily: { type: "string" },
      },
      required: ["target"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.setTextFormatting);
      const target = parseTextTarget(
        obj.target,
        DOCUMENT_TOOL_NAMES.setTextFormatting,
      );
      if (obj.bold !== undefined && typeof obj.bold !== "boolean") {
        invalidInput("document.set_text_formatting bold must be a boolean");
      }
      if (obj.italic !== undefined && typeof obj.italic !== "boolean") {
        invalidInput("document.set_text_formatting italic must be a boolean");
      }
      if (
        obj.fontFamily !== undefined &&
        typeof obj.fontFamily !== "string"
      ) {
        invalidInput(
          "document.set_text_formatting fontFamily must be a string",
        );
      }
      let fontSizeHalfPoints: number | undefined;
      if (obj.fontSizeHalfPoints !== undefined) {
        if (
          typeof obj.fontSizeHalfPoints !== "number" ||
          !Number.isInteger(obj.fontSizeHalfPoints) ||
          obj.fontSizeHalfPoints < 1
        ) {
          invalidInput(
            "document.set_text_formatting fontSizeHalfPoints must be a positive integer",
          );
        }
        fontSizeHalfPoints = obj.fontSizeHalfPoints;
      }
      return {
        target,
        ...(typeof obj.bold === "boolean" ? { bold: obj.bold } : {}),
        ...(typeof obj.italic === "boolean" ? { italic: obj.italic } : {}),
        ...(fontSizeHalfPoints !== undefined ? { fontSizeHalfPoints } : {}),
        ...(typeof obj.fontFamily === "string"
          ? { fontFamily: obj.fontFamily }
          : {}),
      };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.setTextFormatting,
        (document, mutations) =>
          mutations.setTextFormatting({
            document,
            target: input.target,
            ...(input.bold !== undefined ? { bold: input.bold } : {}),
            ...(input.italic !== undefined ? { italic: input.italic } : {}),
            ...(input.fontSizeHalfPoints !== undefined
              ? { fontSizeHalfPoints: input.fontSizeHalfPoints }
              : {}),
            ...(input.fontFamily !== undefined
              ? { fontFamily: input.fontFamily }
              : {}),
            signal: ctx.signal,
            runId: ctx.runId,
          }),
        input,
      ),
  });
}

function parseOptionalIntField(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    invalidInput(`${label} must be an integer`);
  }
  return value;
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

export function createDocumentCreateTableTool(): AgentTool<
  DocumentCreateTableInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.createTable,
    description:
      "Create a new rectangular DOCX table with a complete initial cell matrix in one atomic mutation. " +
      "Prefer this when the full initial contents are already known — do not create an empty table then fill cells. " +
      "rows[0] is typically the header row; empty string cells are allowed. " +
      "placement: start | end | before {handle} | after {handle} (body-block handles from inspect(body_blocks)). " +
      "After success, re-inspect before reusing structural handles. " +
      "Success means one immutable new document version was persisted.",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.createTable,
    inputSchema: {
      type: "object",
      properties: {
        rows: {
          type: "array",
          description:
            "Ordered rectangular matrix of cell strings (include header row when known)",
          items: {
            type: "array",
            items: { type: "string" },
          },
        },
        placement: PARAGRAPH_PLACEMENT_SCHEMA,
      },
      required: ["rows", "placement"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.createTable);
      if (!Array.isArray(obj.rows) || obj.rows.length === 0) {
        invalidInput("document.create_table requires a non-empty rows matrix");
      }
      const rows: string[][] = [];
      for (const row of obj.rows) {
        if (!Array.isArray(row)) {
          invalidInput("document.create_table each row must be a string array");
        }
        const cells: string[] = [];
        for (const cell of row) {
          if (typeof cell !== "string") {
            invalidInput(
              "document.create_table cells must be strings (empty string allowed)",
            );
          }
          cells.push(cell);
        }
        rows.push(cells);
      }
      const placement = parseParagraphPlacement(
        obj.placement,
        DOCUMENT_TOOL_NAMES.createTable,
      );
      return { rows, placement };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.createTable,
        (document, mutations) =>
          mutations.createTable({
            document,
            rows: input.rows,
            placement: input.placement as DocumentParagraphPlacement,
            signal: ctx.signal,
            runId: ctx.runId,
          }),
        input,
      ),
  });
}

export function createDocumentDeleteTableTool(): AgentTool<
  DocumentDeleteTableInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.deleteTable,
    description:
      "Delete an entire DOCX table. Inspect tables first; prefer opaque table.handle. " +
      "Do not empty cells with replace_text. After success, re-inspect before reusing handles. " +
      "Success means an immutable new document version was persisted.",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.deleteTable,
    inputSchema: {
      type: "object",
      properties: {
        table: tableTargetSchema({
          description: "Table to delete (prefer handle from inspect)",
        }),
      },
      required: ["table"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.deleteTable);
      return {
        table: parseTableTarget(obj.table, DOCUMENT_TOOL_NAMES.deleteTable),
      };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.deleteTable,
        (document, mutations) =>
          mutations.deleteTable({
            document,
            table: input.table,
            signal: ctx.signal,
            runId: ctx.runId,
          }),
        input,
      ),
  });
}

export function createDocumentDeleteTableRowTool(): AgentTool<
  DocumentDeleteTableRowInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.deleteTableRow,
    description:
      "Delete one row from a DOCX table. Inspect tables first. " +
      "Target the row with row.handle (preferred) or row.firstCellText. " +
      "If reasonCode is LAST_TABLE_ROW, delete the whole table instead — do not retry blindly. " +
      "After success, re-inspect before reusing structural handles. " +
      "Success means an immutable new document version was persisted.",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.deleteTableRow,
    inputSchema: {
      type: "object",
      properties: {
        table: tableTargetSchema({
          description: "Containing table (prefer handle from inspect)",
        }),
        row: ROW_ANCHOR_SCHEMA,
      },
      required: ["table", "row"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.deleteTableRow);
      const table = parseTableTarget(
        obj.table,
        DOCUMENT_TOOL_NAMES.deleteTableRow,
      );
      if (!obj.row || typeof obj.row !== "object" || Array.isArray(obj.row)) {
        invalidInput("document.delete_table_row requires a row target");
      }
      const row = parseRowAnchor(
        obj.row as Record<string, unknown>,
        DOCUMENT_TOOL_NAMES.deleteTableRow,
      );
      return { table, row };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.deleteTableRow,
        (document, mutations) =>
          mutations.deleteTableRow({
            document,
            table: input.table,
            row: input.row,
            signal: ctx.signal,
            runId: ctx.runId,
          }),
        input,
      ),
  });
}

export function createDocumentDeleteTableColumnTool(): AgentTool<
  DocumentDeleteTableColumnInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.deleteTableColumn,
    description:
      "Delete one column from a DOCX table. Inspect tables first. " +
      "Provide columnHandle (preferred) or columnHeader. " +
      "If reasonCode is LAST_TABLE_COLUMN, delete the whole table instead — do not retry blindly. " +
      "After success, re-inspect before reusing structural handles. " +
      "Success means an immutable new document version was persisted.",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.deleteTableColumn,
    inputSchema: {
      type: "object",
      properties: {
        table: tableTargetSchema({
          description: "Containing table (prefer handle from inspect)",
        }),
        columnHeader: {
          type: "string",
          description: "Semantic column header text to delete",
        },
        columnHandle: {
          type: "string",
          description: "Opaque column handle from inspect(tables)",
        },
      },
      required: ["table"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.deleteTableColumn);
      const table = parseTableTarget(
        obj.table,
        DOCUMENT_TOOL_NAMES.deleteTableColumn,
      );
      const columnHeader =
        typeof obj.columnHeader === "string" && obj.columnHeader
          ? obj.columnHeader
          : undefined;
      const columnHandle =
        typeof obj.columnHandle === "string" && obj.columnHandle
          ? obj.columnHandle
          : undefined;
      if (!columnHeader && !columnHandle) {
        invalidInput(
          "document.delete_table_column requires columnHeader or columnHandle",
        );
      }
      return {
        table,
        ...(columnHeader !== undefined ? { columnHeader } : {}),
        ...(columnHandle !== undefined ? { columnHandle } : {}),
      };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.deleteTableColumn,
        (document, mutations) =>
          mutations.deleteTableColumn({
            document,
            table: input.table,
            ...(input.columnHeader !== undefined
              ? { columnHeader: input.columnHeader }
              : {}),
            ...(input.columnHandle !== undefined
              ? { columnHandle: input.columnHandle }
              : {}),
            signal: ctx.signal,
            runId: ctx.runId,
          }),
        input,
      ),
  });
}

export function createDocumentSetTableFormattingTool(): AgentTool<
  DocumentSetTableFormattingInput,
  PersistedDocumentMutationToolResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.setTableFormatting,
    description:
      "Apply basic table-level formatting on a supported DOCX table: alignment " +
      "(left|center|right|clear), simple borders (grid|none|clear), and optional " +
      "cell padding via all four cellMargin*Twips together. " +
      "Use only when the user asks for table presentation changes — not for every table. " +
      "Inspect tables first; prefer opaque table.handle. Check set_table_formatting affordance when present. " +
      "After success, re-inspect before reusing handles. " +
      "Success means an immutable new document version was persisted.",
    effect: "write",
    executionMode: "sequential",
    capability: DOCX_ENGINE_CAPS.setTableFormatting,
    inputSchema: {
      type: "object",
      properties: {
        table: tableTargetSchema({
          description: "Table to format (prefer handle from inspect)",
        }),
        alignment: {
          type: "string",
          enum: ["left", "center", "right", "clear"],
          description: "Table alignment; clear restores default",
        },
        borders: {
          type: "string",
          enum: ["grid", "none", "clear"],
          description: "Simple border mode; grid shows lines, none hides, clear restores default",
        },
        cellMarginTopTwips: {
          type: "number",
          description: "Top cell padding (provide all four margins together)",
        },
        cellMarginRightTwips: {
          type: "number",
          description: "Right cell padding (provide all four margins together)",
        },
        cellMarginBottomTwips: {
          type: "number",
          description: "Bottom cell padding (provide all four margins together)",
        },
        cellMarginLeftTwips: {
          type: "number",
          description: "Left cell padding (provide all four margins together)",
        },
      },
      required: ["table"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(
        raw,
        DOCUMENT_TOOL_NAMES.setTableFormatting,
      );
      const table = parseTableTarget(
        obj.table,
        DOCUMENT_TOOL_NAMES.setTableFormatting,
      );
      let alignment: DocumentTableAlignment | undefined;
      if (obj.alignment !== undefined) {
        if (
          obj.alignment !== "left" &&
          obj.alignment !== "center" &&
          obj.alignment !== "right" &&
          obj.alignment !== "clear"
        ) {
          invalidInput(
            "document.set_table_formatting alignment must be left|center|right|clear",
          );
        }
        alignment = obj.alignment;
      }
      let borders: DocumentTableBorders | undefined;
      if (obj.borders !== undefined) {
        if (
          obj.borders !== "grid" &&
          obj.borders !== "none" &&
          obj.borders !== "clear"
        ) {
          invalidInput(
            "document.set_table_formatting borders must be grid|none|clear",
          );
        }
        borders = obj.borders;
      }
      const cellMarginTopTwips = parseOptionalIntField(
        obj.cellMarginTopTwips,
        "document.set_table_formatting cellMarginTopTwips",
      );
      const cellMarginRightTwips = parseOptionalIntField(
        obj.cellMarginRightTwips,
        "document.set_table_formatting cellMarginRightTwips",
      );
      const cellMarginBottomTwips = parseOptionalIntField(
        obj.cellMarginBottomTwips,
        "document.set_table_formatting cellMarginBottomTwips",
      );
      const cellMarginLeftTwips = parseOptionalIntField(
        obj.cellMarginLeftTwips,
        "document.set_table_formatting cellMarginLeftTwips",
      );
      const marginParts = [
        cellMarginTopTwips,
        cellMarginRightTwips,
        cellMarginBottomTwips,
        cellMarginLeftTwips,
      ];
      const marginCount = marginParts.filter((v) => v !== undefined).length;
      if (marginCount > 0 && marginCount < 4) {
        invalidInput(
          "document.set_table_formatting requires all four cellMargin*Twips together",
        );
      }
      if (
        alignment === undefined &&
        borders === undefined &&
        marginCount === 0
      ) {
        invalidInput(
          "document.set_table_formatting requires alignment, borders, and/or all four cell margins",
        );
      }
      return {
        table,
        ...(alignment !== undefined ? { alignment } : {}),
        ...(borders !== undefined ? { borders } : {}),
        ...(cellMarginTopTwips !== undefined
          ? { cellMarginTopTwips }
          : {}),
        ...(cellMarginRightTwips !== undefined
          ? { cellMarginRightTwips }
          : {}),
        ...(cellMarginBottomTwips !== undefined
          ? { cellMarginBottomTwips }
          : {}),
        ...(cellMarginLeftTwips !== undefined
          ? { cellMarginLeftTwips }
          : {}),
      };
    },
    execute: (input, ctx) =>
      executePersistedMutation(
        ctx,
        DOCUMENT_TOOL_NAMES.setTableFormatting,
        (document, mutations) =>
          mutations.setTableFormatting({
            document,
            table: input.table,
            ...(input.alignment !== undefined
              ? { alignment: input.alignment }
              : {}),
            ...(input.borders !== undefined ? { borders: input.borders } : {}),
            ...(input.cellMarginTopTwips !== undefined
              ? { cellMarginTopTwips: input.cellMarginTopTwips }
              : {}),
            ...(input.cellMarginRightTwips !== undefined
              ? { cellMarginRightTwips: input.cellMarginRightTwips }
              : {}),
            ...(input.cellMarginBottomTwips !== undefined
              ? { cellMarginBottomTwips: input.cellMarginBottomTwips }
              : {}),
            ...(input.cellMarginLeftTwips !== undefined
              ? { cellMarginLeftTwips: input.cellMarginLeftTwips }
              : {}),
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
