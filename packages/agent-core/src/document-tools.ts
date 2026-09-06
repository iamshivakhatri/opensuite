import { AgentCoreError } from "./errors.js";
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

export const DOCUMENT_TOOL_NAMES = {
  capabilities: "document.capabilities",
  inspect: "document.inspect",
  find: "document.find",
  replaceText: "document.replace_text",
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
      "Inspect the active Office document. Prefer a targeted focus. " +
      "DOCX engine runtime supports kind=context (bounded text around a target). " +
      "Broad focuses (overview, headings, paragraphs, tables, …) depend on the runtime.",
    risk: "safe",
    executionMode: "parallel-safe",
    inputSchema: {
      type: "object",
      properties: {
        focus: {
          type: "object",
          description: "Targeted inspect focus. Omit for overview.",
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
      tools.push(createDocumentReplaceTextTool());
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

export function readOnlyDocumentCapabilities(): RuntimeCapabilities {
  return createCapabilities(
    Capabilities.DocumentInspect,
    Capabilities.DocumentFind,
  );
}

/** Inspect + find + safe mock mutations. */
export function mutableDocumentCapabilities(): RuntimeCapabilities {
  return createCapabilities(
    Capabilities.DocumentInspect,
    Capabilities.DocumentFind,
    Capabilities.DocumentMutate,
  );
}

export interface DocumentReplaceTextInput {
  readonly find: string;
  readonly replace: string;
  readonly scope?: "all" | "headings" | "paragraphs";
}

export function createDocumentReplaceTextTool(): AgentTool<
  DocumentReplaceTextInput,
  OperationResult
> {
  return {
    name: DOCUMENT_TOOL_NAMES.replaceText,
    description:
      "Replace text in the active DOCX document (headings and/or paragraphs). " +
      "Safe write — does not delete structure. Verify with document.inspect afterward.",
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
          description: "Where to search (default all)",
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
      return executeMutation(ctx, "document.replace_text", {
        find: input.find,
        replace: input.replace,
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
      });
    },
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
    case "headings":
    case "paragraphs":
    case "tables":
    case "slides":
    case "sheets":
      return { kind };
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
