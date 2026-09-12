import type { AgentTool } from "../model.js";
import type {
  DocumentFindQuery,
  DocumentInspectFocus,
  FindResult,
  InspectionResult,
} from "../runtime.js";
import { unsupportedCapabilityFind } from "../runtime.js";
import {
  Capabilities,
  hasCapability,
  listCapabilities,
  type DocumentRef,
} from "../types.js";
import {
  assertEmptyOrObject,
  assertObject,
  defineDocumentTool,
  diagnosticError,
  invalidInput,
  requireDocumentRuntime,
  unwrapResult,
} from "./define-tool.js";
import { collectOpaqueHandles } from "../artifact-handles.js";
import { projectInspectionForWorkingState } from "../model-context.js";
import { DOCUMENT_TOOL_NAMES } from "./names.js";
import { PAGING_PROPERTIES } from "./shared-schema.js";
import { parseInspectFocus } from "./selectors.js";

export interface DocumentInspectToolInput {
  readonly focus?: DocumentInspectFocus;
}

export interface DocumentFindToolInput {
  readonly query: string;
  readonly mode?: "text" | "semantic";
  readonly maxResults?: number;
}

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
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.capabilities,
    description:
      "Internal/runtime capability listing for the active document. " +
      "Not part of the model-facing catalog — bootstrap already filters tools by DocumentRuntime.capabilities().",
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
  });
}

export function createDocumentInspectTool(): AgentTool<
  DocumentInspectToolInput,
  InspectionResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.inspect,
    description:
      "Inspect the active document with a targeted focus. " +
      "Use only when you need structure or mutation targets — not for blank append/end authoring. " +
      "DOCX focus kinds: overview | headings | paragraphs | tables | body_blocks | context. " +
      "Prefer the narrowest kind; page with offset/limit (default 20, max 100). " +
      "tables/body_blocks return opaque handles for same-version mutations; " +
      "when affordances present, supported:false means do not call that op on that target.",
    executionMode: "parallel-safe",
    capability: Capabilities.DocumentInspect,
    inputSchema: {
      type: "object",
      properties: {
        focus: {
          type: "object",
          description: "Omit for overview. Prefer headings|paragraphs|tables|body_blocks|context.",
          properties: {
            kind: {
              type: "string",
              enum: [
                "overview",
                "structure",
                "headings",
                "paragraphs",
                "tables",
                "body_blocks",
                "slides",
                "slide",
                "sheets",
                "range",
                "context",
              ],
            },
            ...PAGING_PROPERTIES,
            index: { type: "number", description: "0-based slide index (kind=slide)" },
            sheet: { type: "string", description: "Sheet name (kind=range)" },
            address: {
              type: "string",
              description: "A1 cell (kind=range)",
            },
            text: {
              type: "string",
              description: "Target text (kind=context)",
            },
            occurrence: {
              type: "number",
              description: "1-based occurrence (kind=context); omit when unique",
            },
            before: {
              type: "number",
              description: "Units before target (kind=context)",
            },
            after: {
              type: "number",
              description: "Units after target (kind=context)",
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
      return { focus: parseInspectFocus(obj.focus) };
    },
    async execute(input, ctx) {
      const { document, runtime } = requireDocumentRuntime(ctx);
      const result = await runtime.inspect(document, {
        focus: input.focus,
        signal: ctx.signal,
        runId: ctx.runId,
      });
      const success = unwrapResult(result);
      ctx.handles?.registerAll(
        document.versionId,
        collectOpaqueHandles(success.payload),
      );
      ctx.recordInspection?.(document, input.focus, projectInspectionForWorkingState(success));
      return success;
    },
  });
}

export function createDocumentFindTool(): AgentTool<
  DocumentFindToolInput,
  FindResult
> {
  return defineDocumentTool({
    name: DOCUMENT_TOOL_NAMES.find,
    description:
      "Find literal or keyword matches in the active document. Prefer inspect for structure.",
    executionMode: "parallel-safe",
    capability: Capabilities.DocumentFind,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        mode: {
          type: "string",
          enum: ["text", "semantic"],
          description: "text=substring; semantic=keywords",
        },
        maxResults: { type: "number", description: "Max matches (1-50)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    parseInput(raw) {
      const obj = assertObject(raw, DOCUMENT_TOOL_NAMES.find);
      if (typeof obj.query !== "string" || !obj.query.trim()) {
        invalidInput("document.find requires a non-empty query string");
      }
      let mode: "text" | "semantic" | undefined;
      if (obj.mode !== undefined) {
        if (obj.mode !== "text" && obj.mode !== "semantic") {
          invalidInput("document.find mode must be text or semantic");
        }
        mode = obj.mode;
      }
      let maxResults: number | undefined;
      if (obj.maxResults !== undefined) {
        if (typeof obj.maxResults !== "number" || !Number.isFinite(obj.maxResults)) {
          invalidInput("document.find maxResults must be a number");
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
      if (!runtime.find) {
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
      return unwrapResult(result);
    },
  });
}
