import { AgentCoreError } from "./errors.js";
import type {
  DocumentTableCellUpdate,
  DocumentTableRowAnchor,
  DocumentTableTarget,
  PersistedDocumentMutationToolResult,
} from "./document-mutation.js";
import type { AgentTool, ToolExecutionContext } from "./model.js";
import type {
  DocumentFindQuery,
  DocumentInspectFocus,
  DocumentRuntime,
  FindResult,
  InspectionResult,
  OperationResult,
} from "./runtime.js";
import { unsupportedCapabilityFind, unsupportedCapabilityResult } from "./runtime.js";
import { ToolRegistry } from "./tools.js";
import {
  Capabilities,
  createCapabilities,
  hasCapability,
  listCapabilities,
  type DocumentFormat,
  type DocumentRef,
  type RuntimeCapabilities,
} from "./types.js";
import { MOCK_DOCUMENT_CAPABILITIES } from "./mock-runtime.js";

/**
 * Office document tools (read + narrow safe writes).
 * Always derive DocumentRef from ToolExecutionContext — never from model input.
 */

/** Rust-advertised DOCX mutation capability ids (also mirrored in RuntimeCapabilities). */
export const DOCX_ENGINE_CAPS = {
  replaceText: "replace_text",
  setTableCellsText: "set_table_cells_text",
  insertTableRows: "insert_table_rows",
  insertTableColumn: "insert_table_column",
} as const;

export const DOCUMENT_TOOL_NAMES = {
  capabilities: "document.capabilities",
  inspect: "document.inspect",
  find: "document.find",
  replaceText: "document.replace_text",
  setTableCellsText: "document.set_table_cells_text",
  insertTableRows: "document.insert_table_rows",
  insertTableColumn: "document.insert_table_column",
  updateSlideText: "slides.update_text",
  setCells: "workbook.set_cells",
} as const;

export function createDocumentCapabilitiesTool(): AgentTool<
  Record<string, never>,
  {
    readonly format: DocumentRef["format"];
    readonly capabilities: readonly string[];
    readonly canInspect: boolean;
    readonly canFind: boolean;
    readonly canMutate: boolean;
  }
> {
  return {
    name: DOCUMENT_TOOL_NAMES.capabilities,
    description:
      "List document capabilities supported by the current DocumentRuntime for the active document (inspect, find, mutate, …).",
    risk: "safe",
    executionMode: "parallel-safe",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    parseInput(raw) {
      assertEmptyOrObject(raw, DOCUMENT_TOOL_NAMES.capabilities);
      return {};
    },
    async execute(_input, ctx) {
      const { document, runtime } = requireDocumentRuntime(ctx);
      const caps = await runtime.capabilities(document);
      return {
        format: document.format,
        capabilities: listCapabilities(caps),
        canInspect: hasCapability(caps, Capabilities.DocumentInspect),
        canFind: hasCapability(caps, Capabilities.DocumentFind),
        canMutate: hasCapability(caps, Capabilities.DocumentMutate),
      };
    },
  };
}

export interface DocumentInspectToolInput {
  readonly focus?: DocumentInspectFocus;
}

export function createDocumentInspectTool(): AgentTool<
  DocumentInspectToolInput,
  InspectionResult
> {
  return {
    name: DOCUMENT_TOOL_NAMES.inspect,
    description:
      "Inspect the active Office document with a targeted focus. " +
      "DOCX: overview (compact structure/counts), headings (outline), paragraphs (body prose page), " +
      "tables (rows/cells), context (nearby content around exact text). " +
      "Prefer overview first when structure is unknown; headings to navigate sections; " +
      "tables for tabular work; paragraphs for body prose; context after locating exact text. " +
      "Use offset/limit paging (default limit 20, max 100) — do not request huge dumps. " +
      "PPTX/XLSX mock runtimes also support slides/sheets/range.",
    risk: "safe",
    executionMode: "parallel-safe",
    inputSchema: {
      type: "object",
      properties: {
        focus: {
          type: "object",
          description:
            "Targeted inspect focus. Omit for overview. " +
            "overview=counts; headings/paragraphs/tables=paged collections; context=text neighborhood.",
          properties: {
            kind: {
              type: "string",
              enum: [
                "overview",
                "structure",
                "headings",
                "paragraphs",
                "tables",
                "slides",
                "slide",
                "sheets",
                "range",
                "context",
              ],
              description:
                "overview=structure counts; headings=outline; paragraphs=body prose; " +
                "tables=table rows/cells; context=near exact text; slides/sheets/range=PPTX/XLSX",
            },
            offset: {
              type: "number",
              description:
                "0-based page offset for headings/paragraphs/tables (default 0)",
            },
            limit: {
              type: "number",
              description:
                "Page size for headings/paragraphs/tables (default 20, max 100)",
            },
            index: { type: "number", description: "0-based slide index when kind=slide" },
            sheet: { type: "string", description: "Sheet name when kind=range" },
            address: {
              type: "string",
              description: "Cell address like A1 when kind=range",
            },
            text: {
              type: "string",
              description: "Target text when kind=context",
            },
            occurrence: {
              type: "number",
              description: "1-based occurrence when kind=context",
            },
            before: {
              type: "number",
              description: "Nearby containers before target when kind=context",
            },
            after: {
              type: "number",
              description: "Nearby containers after target when kind=context",
            },
          },
          required: ["kind"],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.inspect);
      if (obj.focus === undefined) {
        return {};
      }
      return { focus: parseFocus(obj.focus) };
    },
    async execute(input, ctx) {
      const { document, runtime } = requireDocumentRuntime(ctx);
      const caps = await runtime.capabilities(document);
      if (!hasCapability(caps, Capabilities.DocumentInspect)) {
        throw diagnosticError(
          unsupportedCapabilityResult(Capabilities.DocumentInspect)
            .diagnostics[0]!,
        );
      }
      const result = await runtime.inspect(document, {
        focus: input.focus,
        signal: ctx.signal,
        runId: ctx.runId,
      });
      if (result.status === "error") {
        throw diagnosticError(result.diagnostics[0]!);
      }
      return result;
    },
  };
}

export interface DocumentFindToolInput {
  readonly query: string;
  readonly mode?: "text" | "semantic";
  readonly maxResults?: number;
}

export function createDocumentFindTool(): AgentTool<
  DocumentFindToolInput,
  FindResult
> {
  return {
    name: DOCUMENT_TOOL_NAMES.find,
    description:
      "Find text or semantic matches in the active Office document. " +
      "Use when the user asks to locate mentions, keywords, or related content.",
    risk: "safe",
    executionMode: "parallel-safe",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        mode: {
          type: "string",
          enum: ["text", "semantic"],
          description: "text=literal substring; semantic=case-insensitive keywords",
        },
        maxResults: { type: "number", description: "Max matches (1-50)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.find);
      if (typeof obj.query !== "string" || !obj.query.trim()) {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "document.find requires a non-empty query string",
        );
      }
      let mode: "text" | "semantic" | undefined;
      if (obj.mode !== undefined) {
        if (obj.mode !== "text" && obj.mode !== "semantic") {
          throw new AgentCoreError(
            "INVALID_TOOL_INPUT",
            "document.find mode must be text or semantic",
          );
        }
        mode = obj.mode;
      }
      let maxResults: number | undefined;
      if (obj.maxResults !== undefined) {
        if (typeof obj.maxResults !== "number" || !Number.isFinite(obj.maxResults)) {
          throw new AgentCoreError(
            "INVALID_TOOL_INPUT",
            "document.find maxResults must be a number",
          );
        }
        maxResults = obj.maxResults;
      }
      return {
        query: obj.query.trim(),
        ...(mode !== undefined ? { mode } : {}),
        ...(maxResults !== undefined ? { maxResults } : {}),
      };
    },
    async execute(input, ctx) {
      const { document, runtime } = requireDocumentRuntime(ctx);
      const caps = await runtime.capabilities(document);
      if (!hasCapability(caps, Capabilities.DocumentFind) || !runtime.find) {
        throw diagnosticError(
          unsupportedCapabilityFind(Capabilities.DocumentFind).diagnostics[0]!,
        );
      }
      const query: DocumentFindQuery = {
        query: input.query,
        mode: input.mode,
        maxResults: input.maxResults,
      };
      const result = await runtime.find(document, query, {
        signal: ctx.signal,
        runId: ctx.runId,
      });
      if (result.status === "error") {
        throw diagnosticError(result.diagnostics[0]!);
      }
      return result;
    },
  };
}

/**
 * Build a ToolRegistry of document tools filtered by advertised caps and
 * optional document format (DOCX never gets workbook tools, etc.).
 */
export function createDocumentToolRegistry(
  capabilities: RuntimeCapabilities = MOCK_DOCUMENT_CAPABILITIES,
  options: { readonly format?: DocumentFormat } = {},
): ToolRegistry {
  const tools: AgentTool[] = [createDocumentCapabilitiesTool()];
  if (hasCapability(capabilities, Capabilities.DocumentInspect)) {
    tools.push(createDocumentInspectTool());
  }
  if (hasCapability(capabilities, Capabilities.DocumentFind)) {
    tools.push(createDocumentFindTool());
  }
  if (hasCapability(capabilities, Capabilities.DocumentMutate)) {
    const format = options.format;
    if (!format || format === "docx") {
      if (
        hasCapability(capabilities, DOCX_ENGINE_CAPS.replaceText) ||
        !hasAnyDocxEngineMutationCap(capabilities)
      ) {
        tools.push(createDocumentReplaceTextTool());
      }
      if (hasCapability(capabilities, DOCX_ENGINE_CAPS.setTableCellsText)) {
        tools.push(createDocumentSetTableCellsTextTool());
      }
      if (hasCapability(capabilities, DOCX_ENGINE_CAPS.insertTableRows)) {
        tools.push(createDocumentInsertTableRowsTool());
      }
      if (hasCapability(capabilities, DOCX_ENGINE_CAPS.insertTableColumn)) {
        tools.push(createDocumentInsertTableColumnTool());
      }
    }
    if (!format || format === "pptx") {
      tools.push(createSlidesUpdateTextTool());
    }
    if (!format || format === "xlsx") {
      tools.push(createWorkbookSetCellsTool());
    }
  }
  return ToolRegistry.create(tools);
}

function hasAnyDocxEngineMutationCap(
  capabilities: RuntimeCapabilities,
): boolean {
  return (
    hasCapability(capabilities, DOCX_ENGINE_CAPS.replaceText) ||
    hasCapability(capabilities, DOCX_ENGINE_CAPS.setTableCellsText) ||
    hasCapability(capabilities, DOCX_ENGINE_CAPS.insertTableRows) ||
    hasCapability(capabilities, DOCX_ENGINE_CAPS.insertTableColumn)
  );
}

export function readOnlyDocumentCapabilities(): RuntimeCapabilities {
  return createCapabilities(
    Capabilities.DocumentInspect,
    Capabilities.DocumentFind,
  );
}

/** Inspect + find + safe mock mutations (includes Rust DOCX mutation ids). */
export function mutableDocumentCapabilities(): RuntimeCapabilities {
  return createCapabilities(
    Capabilities.DocumentInspect,
    Capabilities.DocumentFind,
    Capabilities.DocumentMutate,
    DOCX_ENGINE_CAPS.replaceText,
    DOCX_ENGINE_CAPS.setTableCellsText,
    DOCX_ENGINE_CAPS.insertTableRows,
    DOCX_ENGINE_CAPS.insertTableColumn,
  );
}

export interface DocumentReplaceTextInput {
  readonly find: string;
  readonly replace: string;
  readonly scope?: "all" | "headings" | "paragraphs";
}

export function createDocumentReplaceTextTool(): AgentTool<
  DocumentReplaceTextInput,
  PersistedDocumentMutationToolResult
> {
  return {
    name: DOCUMENT_TOOL_NAMES.replaceText,
    description:
      "Replace prose/heading text in the active DOCX document (not for semantic table cells). " +
      "Success means an immutable new document version was persisted. " +
      "For table cell updates prefer document.set_table_cells_text after inspect(tables).",
    risk: "safe",
    effect: "write",
    executionMode: "sequential",
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
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "document.replace_text requires a non-empty find string",
        );
      }
      if (typeof obj.replace !== "string") {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "document.replace_text requires a replace string",
        );
      }
      let scope: "all" | "headings" | "paragraphs" | undefined;
      if (obj.scope !== undefined) {
        if (
          obj.scope !== "all" &&
          obj.scope !== "headings" &&
          obj.scope !== "paragraphs"
        ) {
          throw new AgentCoreError(
            "INVALID_TOOL_INPUT",
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
    async execute(input, ctx) {
      requireMutations(ctx, DOCUMENT_TOOL_NAMES.replaceText);
      const { document } = requireDocumentRuntime(ctx);
      await requireMutateCapability(ctx);

      const result = await ctx.mutations!.replaceText({
        document,
        find: input.find,
        replace: input.replace,
        signal: ctx.signal,
        runId: ctx.runId,
      });

      return toPersistedMutationToolResult(result, ctx);
    },
  };
}

export interface DocumentSetTableCellsTextInput {
  readonly table: DocumentTableTarget;
  readonly updates: readonly DocumentTableCellUpdate[];
}

export function createDocumentSetTableCellsTextTool(): AgentTool<
  DocumentSetTableCellsTextInput,
  PersistedDocumentMutationToolResult
> {
  return {
    name: DOCUMENT_TOOL_NAMES.setTableCellsText,
    description:
      "Atomically update multiple existing cells in one supported DOCX table. " +
      "Inspect tables first; supply expectedCurrentText from actual cell values. " +
      "Prefer one multi-cell call over several replace_text calls for table cells. " +
      "All updates validate before mutation — one invalid target fails the whole operation. " +
      "Success = immutable version persisted. Capability does not guarantee every table shape is mutable.",
    risk: "safe",
    effect: "write",
    executionMode: "sequential",
    inputSchema: {
      type: "object",
      properties: {
        table: {
          type: "object",
          description:
            "Semantic table target from inspect(tables): headerCells (+ optional occurrence)",
          properties: {
            headerCells: {
              type: "array",
              items: { type: "string" },
              description: "Exact header cell texts in order",
            },
            occurrence: {
              type: "number",
              description: "Version-local occurrence when headers collide (1-based)",
            },
          },
          required: ["headerCells"],
          additionalProperties: false,
        },
        updates: {
          type: "array",
          description: "Cell updates in one atomic engine operation",
          items: {
            type: "object",
            properties: {
              rowLabel: {
                type: "string",
                description: "First-column / row-label text from inspection",
              },
              columnHeader: {
                type: "string",
                description: "Column header text from inspection",
              },
              expectedCurrentText: {
                type: "string",
                description: "Current cell text (precondition from inspection)",
              },
              replacement: { type: "string", description: "New cell text" },
              occurrence: {
                type: "number",
                description: "Version-local occurrence when row/column collide",
              },
            },
            required: [
              "rowLabel",
              "columnHeader",
              "expectedCurrentText",
              "replacement",
            ],
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
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "document.set_table_cells_text requires a non-empty updates array",
        );
      }
      const updates: DocumentTableCellUpdate[] = [];
      for (const item of obj.updates) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new AgentCoreError(
            "INVALID_TOOL_INPUT",
            "document.set_table_cells_text updates entries must be objects",
          );
        }
        const entry = item as Record<string, unknown>;
        if (
          typeof entry.rowLabel !== "string" ||
          !entry.rowLabel ||
          typeof entry.columnHeader !== "string" ||
          !entry.columnHeader ||
          typeof entry.expectedCurrentText !== "string" ||
          typeof entry.replacement !== "string"
        ) {
          throw new AgentCoreError(
            "INVALID_TOOL_INPUT",
            "document.set_table_cells_text updates require rowLabel, columnHeader, expectedCurrentText, replacement",
          );
        }
        const occurrence = parseOptionalPositiveInt(
          entry.occurrence,
          "document.set_table_cells_text update occurrence",
        );
        updates.push({
          rowLabel: entry.rowLabel,
          columnHeader: entry.columnHeader,
          expectedCurrentText: entry.expectedCurrentText,
          replacement: entry.replacement,
          ...(occurrence !== undefined ? { occurrence } : {}),
        });
      }
      return { table, updates };
    },
    async execute(input, ctx) {
      requireMutations(ctx, DOCUMENT_TOOL_NAMES.setTableCellsText);
      const { document } = requireDocumentRuntime(ctx);
      await requireMutateCapability(ctx);

      const result = await ctx.mutations!.setTableCellsText({
        document,
        table: input.table,
        updates: input.updates,
        signal: ctx.signal,
        runId: ctx.runId,
      });

      return toPersistedMutationToolResult(result, ctx);
    },
  };
}

export interface DocumentInsertTableRowsInput {
  readonly table: DocumentTableTarget;
  readonly after: DocumentTableRowAnchor;
  readonly rows: readonly (readonly string[])[];
}

export function createDocumentInsertTableRowsTool(): AgentTool<
  DocumentInsertTableRowsInput,
  PersistedDocumentMutationToolResult
> {
  return {
    name: DOCUMENT_TOOL_NAMES.insertTableRows,
    description:
      "Insert one contiguous block of rows into a supported DOCX table after a semantic row anchor. " +
      "Inspect tables first; preserve column order; every row must supply exactly one string per column. " +
      "Use for adding records/guests/items. Do not invent column counts. " +
      "Capability does not guarantee complex/merged tables are writable. Success = immutable version persisted.",
    risk: "safe",
    effect: "write",
    executionMode: "sequential",
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
            occurrence: { type: "number" },
          },
          required: ["headerCells"],
          additionalProperties: false,
        },
        after: {
          type: "object",
          description: "Insert after this row (firstCellText from inspection)",
          properties: {
            firstCellText: { type: "string" },
            occurrence: { type: "number" },
          },
          required: ["firstCellText"],
          additionalProperties: false,
        },
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
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "document.insert_table_rows requires after row anchor",
        );
      }
      const afterObj = obj.after as Record<string, unknown>;
      if (
        typeof afterObj.firstCellText !== "string" ||
        !afterObj.firstCellText
      ) {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "document.insert_table_rows after.firstCellText must be a non-empty string",
        );
      }
      const afterOccurrence = parseOptionalPositiveInt(
        afterObj.occurrence,
        "document.insert_table_rows after.occurrence",
      );
      if (!Array.isArray(obj.rows) || obj.rows.length === 0) {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "document.insert_table_rows requires a non-empty rows array",
        );
      }
      const rows: string[][] = [];
      for (const row of obj.rows) {
        if (!Array.isArray(row) || row.length === 0) {
          throw new AgentCoreError(
            "INVALID_TOOL_INPUT",
            "document.insert_table_rows each row must be a non-empty string array",
          );
        }
        const cells: string[] = [];
        for (const cell of row) {
          if (typeof cell !== "string") {
            throw new AgentCoreError(
              "INVALID_TOOL_INPUT",
              "document.insert_table_rows row cells must be strings",
            );
          }
          cells.push(cell);
        }
        rows.push(cells);
      }
      return {
        table,
        after: {
          firstCellText: afterObj.firstCellText,
          ...(afterOccurrence !== undefined
            ? { occurrence: afterOccurrence }
            : {}),
        },
        rows,
      };
    },
    async execute(input, ctx) {
      requireMutations(ctx, DOCUMENT_TOOL_NAMES.insertTableRows);
      const { document } = requireDocumentRuntime(ctx);
      await requireMutateCapability(ctx);

      const result = await ctx.mutations!.insertTableRows({
        document,
        table: input.table,
        after: input.after,
        rows: input.rows,
        signal: ctx.signal,
        runId: ctx.runId,
      });

      return toPersistedMutationToolResult(result, ctx);
    },
  };
}

export interface DocumentInsertTableColumnInput {
  readonly table: DocumentTableTarget;
  readonly afterColumnHeader: string;
  readonly header: string;
  readonly cells: readonly string[];
}

export function createDocumentInsertTableColumnTool(): AgentTool<
  DocumentInsertTableColumnInput,
  PersistedDocumentMutationToolResult
> {
  return {
    name: DOCUMENT_TOOL_NAMES.insertTableColumn,
    description:
      "Insert exactly one column into a simple rectangular DOCX table after an existing header. " +
      "Inspect tables first; cells[] must supply one value per existing data row (inspection order). " +
      "Not a general layout editor — merged/nested/complex tables may return UNSUPPORTED_OPERATION. " +
      "Success = immutable version persisted.",
    risk: "safe",
    effect: "write",
    executionMode: "sequential",
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
            occurrence: { type: "number" },
          },
          required: ["headerCells"],
          additionalProperties: false,
        },
        afterColumnHeader: {
          type: "string",
          description: "Existing column header to insert after",
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
      required: ["table", "afterColumnHeader", "header", "cells"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.insertTableColumn);
      const table = parseTableTarget(
        obj.table,
        DOCUMENT_TOOL_NAMES.insertTableColumn,
      );
      if (
        typeof obj.afterColumnHeader !== "string" ||
        !obj.afterColumnHeader ||
        typeof obj.header !== "string" ||
        !obj.header
      ) {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "document.insert_table_column requires afterColumnHeader and header strings",
        );
      }
      if (!Array.isArray(obj.cells)) {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "document.insert_table_column requires a cells array",
        );
      }
      const cells: string[] = [];
      for (const cell of obj.cells) {
        if (typeof cell !== "string") {
          throw new AgentCoreError(
            "INVALID_TOOL_INPUT",
            "document.insert_table_column cells must be strings",
          );
        }
        cells.push(cell);
      }
      return {
        table,
        afterColumnHeader: obj.afterColumnHeader,
        header: obj.header,
        cells,
      };
    },
    async execute(input, ctx) {
      requireMutations(ctx, DOCUMENT_TOOL_NAMES.insertTableColumn);
      const { document } = requireDocumentRuntime(ctx);
      await requireMutateCapability(ctx);

      const result = await ctx.mutations!.insertTableColumn({
        document,
        table: input.table,
        afterColumnHeader: input.afterColumnHeader,
        header: input.header,
        cells: input.cells,
        signal: ctx.signal,
        runId: ctx.runId,
      });

      return toPersistedMutationToolResult(result, ctx);
    },
  };
}

function parseTableTarget(
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
  if (!Array.isArray(table.headerCells) || table.headerCells.length === 0) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${toolName} table.headerCells must be a non-empty string array`,
    );
  }
  const headerCells: string[] = [];
  for (const cell of table.headerCells) {
    if (typeof cell !== "string") {
      throw new AgentCoreError(
        "INVALID_TOOL_INPUT",
        `${toolName} table.headerCells must be strings`,
      );
    }
    headerCells.push(cell);
  }
  const occurrence = parseOptionalPositiveInt(
    table.occurrence,
    `${toolName} table.occurrence`,
  );
  return {
    headerCells,
    ...(occurrence !== undefined ? { occurrence } : {}),
  };
}

function requireMutations(ctx: ToolExecutionContext, toolName: string): void {
  if (!ctx.mutations) {
    throw new AgentCoreError(
      "RUNTIME_FAILURE",
      `DocumentMutationExecutor is not configured; cannot persist ${toolName}`,
      {
        diagnostic: {
          code: "DOCUMENT_MUTATIONS_MISSING",
          severity: "error",
          message: `DocumentMutationExecutor is not configured; cannot persist ${toolName}`,
        },
      },
    );
  }
}

async function requireMutateCapability(ctx: ToolExecutionContext): Promise<void> {
  const { document, runtime } = requireDocumentRuntime(ctx);
  const caps = await runtime.capabilities(document);
  if (!hasCapability(caps, Capabilities.DocumentMutate)) {
    throw diagnosticError({
      code: "UNSUPPORTED_CAPABILITY",
      severity: "error",
      message: `Runtime does not support capability: ${Capabilities.DocumentMutate}`,
      details: { capability: Capabilities.DocumentMutate },
    });
  }
}

function toPersistedMutationToolResult(
  result: Awaited<
    ReturnType<NonNullable<ToolExecutionContext["mutations"]>["replaceText"]>
  >,
  ctx: ToolExecutionContext,
): PersistedDocumentMutationToolResult {
  if (result.status === "error") {
    throw diagnosticError(result.diagnostics[0]!);
  }
  ctx.advancePrimaryDocument?.(result.document);
  return {
    status: "success",
    diagnostics: result.diagnostics,
    ...(result.change !== undefined ? { change: result.change } : {}),
    document: result.document,
    ...(result.versionNumber !== undefined
      ? { versionNumber: result.versionNumber }
      : {}),
    baseVersionId: result.baseVersionId,
  };
}

export interface SlidesUpdateTextInput {
  readonly slideIndex: number;
  readonly existingText?: string;
  readonly newText?: string;
  readonly title?: string;
}

export function createSlidesUpdateTextTool(): AgentTool<
  SlidesUpdateTextInput,
  OperationResult
> {
  return {
    name: DOCUMENT_TOOL_NAMES.updateSlideText,
    description:
      "Update text on a PPTX slide. Provide slideIndex (0-based) plus either " +
      "title, or existingText+newText to replace matching title/body text. " +
      "Verify with document.inspect afterward.",
    risk: "safe",
    effect: "write",
    executionMode: "sequential",
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
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "slides.update_text requires numeric slideIndex",
        );
      }
      const title =
        obj.title === undefined
          ? undefined
          : typeof obj.title === "string"
            ? obj.title
            : null;
      if (title === null) {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "slides.update_text title must be a string when provided",
        );
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
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "slides.update_text existingText/newText must be strings when provided",
        );
      }
      if (title === undefined && (existingText === undefined || newText === undefined)) {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
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
    async execute(input, ctx) {
      return executeMutation(ctx, "slides.update_text", {
        slideIndex: input.slideIndex,
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.existingText !== undefined
          ? { existingText: input.existingText }
          : {}),
        ...(input.newText !== undefined ? { newText: input.newText } : {}),
      });
    },
  };
}

export interface WorkbookSetCellsInput {
  readonly sheet: string;
  readonly cells: readonly {
    readonly address: string;
    readonly value: string | number | null;
  }[];
}

export function createWorkbookSetCellsTool(): AgentTool<
  WorkbookSetCellsInput,
  OperationResult
> {
  return {
    name: DOCUMENT_TOOL_NAMES.setCells,
    description:
      "Set one or more cell values on an XLSX sheet (small range write). " +
      "Provide sheet name and cells[{address,value}]. Verify with document.inspect afterward.",
    risk: "safe",
    effect: "write",
    executionMode: "sequential",
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
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "workbook.set_cells requires a non-empty sheet name",
        );
      }
      if (!Array.isArray(obj.cells) || obj.cells.length === 0) {
        throw new AgentCoreError(
          "INVALID_TOOL_INPUT",
          "workbook.set_cells requires a non-empty cells array",
        );
      }
      const cells: { address: string; value: string | number | null }[] = [];
      for (const entry of obj.cells) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new AgentCoreError(
            "INVALID_TOOL_INPUT",
            "workbook.set_cells cells entries must be objects",
          );
        }
        const row = entry as Record<string, unknown>;
        if (typeof row.address !== "string" || !row.address.trim()) {
          throw new AgentCoreError(
            "INVALID_TOOL_INPUT",
            "workbook.set_cells cells[].address must be a non-empty string",
          );
        }
        const value = row.value;
        if (
          value !== null &&
          typeof value !== "string" &&
          typeof value !== "number"
        ) {
          throw new AgentCoreError(
            "INVALID_TOOL_INPUT",
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
    async execute(input, ctx) {
      return executeMutation(ctx, "workbook.set_cells", {
        sheet: input.sheet,
        cells: input.cells.map((cell) => ({
          address: cell.address,
          value: cell.value,
        })),
      });
    },
  };
}

async function executeMutation(
  ctx: ToolExecutionContext,
  type: string,
  payload: Record<string, unknown>,
): Promise<OperationResult> {
  const { document, runtime } = requireDocumentRuntime(ctx);
  const caps = await runtime.capabilities(document);
  if (!hasCapability(caps, Capabilities.DocumentMutate) || !runtime.execute) {
    throw diagnosticError({
      code: "UNSUPPORTED_CAPABILITY",
      severity: "error",
      message: `Runtime does not support capability: ${Capabilities.DocumentMutate}`,
      details: { capability: Capabilities.DocumentMutate },
    });
  }
  const result = await runtime.execute(
    document,
    {
      type,
      baseVersionId: document.versionId,
      payload,
    },
    { signal: ctx.signal, runId: ctx.runId },
  );
  if (result.status === "error") {
    throw diagnosticError(result.diagnostics[0]!);
  }
  return result;
}

function requireDocumentRuntime(ctx: ToolExecutionContext): {
  document: DocumentRef;
  runtime: DocumentRuntime;
} {
  if (!ctx.primaryDocument) {
    throw new AgentCoreError(
      "TOOL_FAILURE",
      "No primary document is attached to this agent run",
      {
        diagnostic: {
          code: "PRIMARY_DOCUMENT_MISSING",
          severity: "error",
          message: "No primary document is attached to this agent run",
        },
      },
    );
  }
  if (!ctx.runtime) {
    throw new AgentCoreError(
      "RUNTIME_FAILURE",
      "DocumentRuntime is not configured for this agent",
      {
        diagnostic: {
          code: "DOCUMENT_RUNTIME_MISSING",
          severity: "error",
          message: "DocumentRuntime is not configured for this agent",
        },
      },
    );
  }
  return { document: ctx.primaryDocument, runtime: ctx.runtime };
}

function diagnosticError(diagnostic: {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
}): AgentCoreError {
  const code =
    diagnostic.code === "UNSUPPORTED_CAPABILITY"
      ? "UNSUPPORTED_CAPABILITY"
      : "TOOL_FAILURE";
  return new AgentCoreError(code, diagnostic.message, { diagnostic });
}

function assertEmptyOrObject(raw: unknown, toolName: string): void {
  if (raw === undefined || raw === null) {
    return;
  }
  assertObject(raw, toolName);
}

function assertObject(raw: unknown, toolName: string): Record<string, unknown> {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${toolName} input must be an object`,
    );
  }
  return raw as Record<string, unknown>;
}

function parseFocus(raw: unknown): DocumentInspectFocus {
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
    case "tables": {
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
        if (
          typeof focus.occurrence !== "number" ||
          !Number.isInteger(focus.occurrence) ||
          focus.occurrence < 1
        ) {
          throw new AgentCoreError(
            "INVALID_TOOL_INPUT",
            "document.inspect focus.occurrence must be a positive integer",
          );
        }
        occurrence = focus.occurrence;
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

function parseOptionalNonNegativeInt(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${label} must be a non-negative integer`,
    );
  }
  return value;
}

function parseOptionalPositiveInt(
  value: unknown,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new AgentCoreError(
      "INVALID_TOOL_INPUT",
      `${label} must be a positive integer`,
    );
  }
  return value;
}
