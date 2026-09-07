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
 */

import type { AgentTool } from "../model.js";
import { ToolRegistry } from "../tools.js";
import {
  Capabilities,
  createCapabilities,
  hasCapability,
  type DocumentFormat,
  type RuntimeCapabilities,
} from "../types.js";
import { MOCK_DOCUMENT_CAPABILITIES } from "../mock-runtime.js";
import {
  createDocumentCapabilitiesTool,
  createDocumentFindTool,
  createDocumentInspectTool,
} from "./inspect.js";
import {
  createDocumentInsertTableColumnTool,
  createDocumentInsertTableRowsTool,
  createDocumentReplaceTextTool,
  createDocumentSetTableCellsTextTool,
  createSlidesUpdateTextTool,
  createWorkbookSetCellsTool,
} from "./mutations.js";
import { DOCX_ENGINE_CAPS } from "./names.js";

export { DOCX_ENGINE_CAPS, DOCUMENT_TOOL_NAMES } from "./names.js";
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
  createDocumentInsertTableColumnTool,
  createDocumentInsertTableRowsTool,
  createDocumentReplaceTextTool,
  createDocumentSetTableCellsTextTool,
  createSlidesUpdateTextTool,
  createWorkbookSetCellsTool,
} from "./mutations.js";
export type {
  DocumentInsertTableColumnInput,
  DocumentInsertTableRowsInput,
  DocumentReplaceTextInput,
  DocumentSetTableCellsTextInput,
  SlidesUpdateTextInput,
  WorkbookSetCellsInput,
} from "./mutations.js";
export { defineDocumentTool } from "./define-tool.js";
export type { DocumentToolDefinition } from "./define-tool.js";
export type { StructuralHandle } from "./selectors.js";

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