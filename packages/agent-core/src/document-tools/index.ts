/**
 * Office document tools (read + narrow safe writes).
 * Always derive DocumentRef from ToolExecutionContext — never from model input.
 *
 * Layout:
 *   define-tool     — AgentTool helper + capability / mutation plumbing
 *   shared-schema   — reusable request-shape fragments
 *   selectors       — table/cell/row/inspect focus parsers
 *   inspect         — capabilities / inspect / find
 *   mutations       — DOCX persisted writes + PPTX/XLSX mock writes
 *
 * Discovery path (run bootstrap):
 *   DocumentRuntime.capabilities(DocumentRef)
 *     → filterDocumentToolsByCapabilities(catalog, caps)
 *     → model-facing tool list
 */

import type { AgentTool } from "../model.js";
import type { DocumentRuntime } from "../runtime.js";
import { ToolRegistry } from "../tools.js";
import {
  Capabilities,
  createCapabilities,
  hasCapability,
  type DocumentFormat,
  type DocumentRef,
  type RuntimeCapabilities,
} from "../types.js";
import { AgentCoreError } from "../errors.js";
import { MOCK_DOCUMENT_CAPABILITIES } from "../mock-runtime.js";
import {
  createDocumentCapabilitiesTool,
  createDocumentFindTool,
  createDocumentInspectTool,
} from "./inspect.js";
import {
  createDocumentCreateTableTool,
  createDocumentDeleteParagraphTool,
  createDocumentDeleteTableColumnTool,
  createDocumentDeleteTableRowTool,
  createDocumentDeleteTableTool,
  createDocumentInsertParagraphTool,
  createDocumentInsertParagraphsTool,
  createDocumentInsertTableColumnTool,
  createDocumentInsertTableRowsTool,
  createDocumentReplaceTextTool,
  createDocumentSetParagraphFormattingTool,
  createDocumentSetParagraphStyleTool,
  createDocumentSetTableCellsTextTool,
  createDocumentSetTableFormattingTool,
  createDocumentSetTextFormattingTool,
  createSlidesUpdateTextTool,
  createWorkbookSetCellsTool,
} from "./mutations.js";
import { DOCX_ENGINE_CAPS, MOCK_FORMAT_CAPS } from "./names.js";

export { DOCX_ENGINE_CAPS, DOCUMENT_TOOL_NAMES, MOCK_FORMAT_CAPS } from "./names.js";
export {
  createDocumentCapabilitiesTool,
  createDocumentFindTool,
  createDocumentInspectTool,
} from "./inspect.js";
export type {
  DocumentFindToolInput,
  DocumentInspectToolInput,
} from "./inspect.js";
export {
  createDocumentCreateTableTool,
  createDocumentDeleteParagraphTool,
  createDocumentDeleteTableColumnTool,
  createDocumentDeleteTableRowTool,
  createDocumentDeleteTableTool,
  createDocumentInsertParagraphTool,
  createDocumentInsertParagraphsTool,
  createDocumentInsertTableColumnTool,
  createDocumentInsertTableRowsTool,
  createDocumentReplaceTextTool,
  createDocumentSetParagraphFormattingTool,
  createDocumentSetParagraphStyleTool,
  createDocumentSetTableCellsTextTool,
  createDocumentSetTableFormattingTool,
  createDocumentSetTextFormattingTool,
  createSlidesUpdateTextTool,
  createWorkbookSetCellsTool,
} from "./mutations.js";
export type {
  DocumentCreateTableInput,
  DocumentDeleteParagraphInput,
  DocumentDeleteTableColumnInput,
  DocumentDeleteTableInput,
  DocumentDeleteTableRowInput,
  DocumentInsertParagraphInput,
  DocumentInsertParagraphsInput,
  DocumentInsertTableColumnInput,
  DocumentInsertTableRowsInput,
  DocumentReplaceTextInput,
  DocumentSetParagraphFormattingInput,
  DocumentSetParagraphStyleInput,
  DocumentSetTableCellsTextInput,
  DocumentSetTableFormattingInput,
  DocumentSetTextFormattingInput,
  SlidesUpdateTextInput,
  WorkbookSetCellsInput,
} from "./mutations.js";
export { defineDocumentTool } from "./define-tool.js";
export type { DocumentToolDefinition } from "./define-tool.js";
export type { StructuralHandle } from "./selectors.js";

/**
 * Full model-facing document tool catalog (unfiltered).
 * Bootstrap filters this against runtime-advertised capability ids.
 */
export function listDocumentToolDescriptors(): readonly AgentTool[] {
  return [
    createDocumentCapabilitiesTool(),
    createDocumentInspectTool(),
    createDocumentFindTool(),
    createDocumentReplaceTextTool(),
    createDocumentInsertParagraphTool(),
    createDocumentInsertParagraphsTool(),
    createDocumentDeleteParagraphTool(),
    createDocumentSetParagraphStyleTool(),
    createDocumentSetParagraphFormattingTool(),
    createDocumentSetTextFormattingTool(),
    createDocumentCreateTableTool(),
    createDocumentSetTableCellsTextTool(),
    createDocumentInsertTableRowsTool(),
    createDocumentInsertTableColumnTool(),
    createDocumentDeleteTableTool(),
    createDocumentDeleteTableRowTool(),
    createDocumentDeleteTableColumnTool(),
    createDocumentSetTableFormattingTool(),
    createSlidesUpdateTextTool(),
    createWorkbookSetCellsTool(),
  ];
}

/**
 * Keep tools whose requireCapability is present (or that declare none).
 * Runtime capability response is the sole availability source — no format switch.
 */
export function filterDocumentToolsByCapabilities(
  tools: readonly AgentTool[],
  capabilities: RuntimeCapabilities,
): AgentTool[] {
  return tools.filter((tool) => {
    if (tool.requireCapability === undefined) {
      return true;
    }
    return hasCapability(capabilities, tool.requireCapability);
  });
}

/**
 * Build a ToolRegistry of document tools filtered by advertised capabilities.
 * Prefer discoverDocumentToolsFromRuntime at run bootstrap so the runtime
 * (not a static app list) decides availability.
 */
export function createDocumentToolRegistry(
  capabilities: RuntimeCapabilities = MOCK_DOCUMENT_CAPABILITIES,
): ToolRegistry {
  return ToolRegistry.create(
    filterDocumentToolsByCapabilities(
      listDocumentToolDescriptors(),
      capabilities,
    ),
  );
}

/**
 * One-shot discovery: DocumentRef → runtime.capabilities → filtered tools.
 * Throws AgentCoreError on failure — callers must not fall back to "all tools"
 * or mock DOCX caps.
 */
export async function discoverDocumentToolsFromRuntime(
  runtime: DocumentRuntime,
  document: DocumentRef,
): Promise<{
  readonly capabilities: RuntimeCapabilities;
  readonly tools: readonly AgentTool[];
  readonly registry: ToolRegistry;
}> {
  let capabilities: RuntimeCapabilities;
  try {
    capabilities = await runtime.capabilities(document);
  } catch (cause) {
    throw new AgentCoreError(
      "RUNTIME_FAILURE",
      "Failed to discover document runtime capabilities",
      {
        diagnostic: {
          code: "CAPABILITY_DISCOVERY_FAILED",
          severity: "error",
          message: "Failed to discover document runtime capabilities",
          details: {
            documentId: document.documentId,
            versionId: document.versionId,
            format: document.format,
          },
        },
        cause,
      },
    );
  }

  const tools = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    capabilities,
  );
  return {
    capabilities,
    tools,
    registry: ToolRegistry.create(tools),
  };
}

/**
 * Mock PPTX/XLSX capability sets for format-aware mock runtimes.
 * Product DOCX must use the engine adapter — never these mock sets.
 */
export function mockCapabilitiesForFormat(
  format: DocumentFormat | undefined,
): RuntimeCapabilities {
  if (format === "pptx") {
    return createCapabilities(
      Capabilities.DocumentInspect,
      Capabilities.DocumentFind,
      Capabilities.DocumentMutate,
      MOCK_FORMAT_CAPS.updateSlideText,
    );
  }
  if (format === "xlsx") {
    return createCapabilities(
      Capabilities.DocumentInspect,
      Capabilities.DocumentFind,
      Capabilities.DocumentMutate,
      MOCK_FORMAT_CAPS.setCells,
    );
  }
  // Unknown / unset: read-only mock surface (no DOCX mutation fallback).
  return readOnlyDocumentCapabilities();
}

export function readOnlyDocumentCapabilities(): RuntimeCapabilities {
  return createCapabilities(
    Capabilities.DocumentInspect,
    Capabilities.DocumentFind,
  );
}

/** Inspect + find + DOCX mutation ids (engine-shaped; for tests / DOCX mock). */
export function mutableDocumentCapabilities(): RuntimeCapabilities {
  return createCapabilities(
    Capabilities.DocumentInspect,
    Capabilities.DocumentFind,
    Capabilities.DocumentMutate,
    DOCX_ENGINE_CAPS.replaceText,
    DOCX_ENGINE_CAPS.insertParagraph,
    DOCX_ENGINE_CAPS.insertParagraphs,
    DOCX_ENGINE_CAPS.deleteParagraph,
    DOCX_ENGINE_CAPS.setParagraphStyle,
    DOCX_ENGINE_CAPS.setParagraphFormatting,
    DOCX_ENGINE_CAPS.setTextFormatting,
    DOCX_ENGINE_CAPS.setTableCellsText,
    DOCX_ENGINE_CAPS.insertTableRows,
    DOCX_ENGINE_CAPS.insertTableColumn,
    DOCX_ENGINE_CAPS.createTable,
    DOCX_ENGINE_CAPS.deleteTable,
    DOCX_ENGINE_CAPS.deleteTableRow,
    DOCX_ENGINE_CAPS.deleteTableColumn,
    DOCX_ENGINE_CAPS.setTableFormatting,
  );
}
