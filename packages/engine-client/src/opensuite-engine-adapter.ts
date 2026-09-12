import { Buffer } from "node:buffer";
import {
  Capabilities,
  DEFAULT_INSPECT_PAGE_LIMIT,
  MAX_INSPECT_PAGE_LIMIT,
  createCapabilities,
  hasCapability,
  unsupportedCapabilityFind,
  unsupportedCapabilityOperation,
  unsupportedCapabilityResult,
  type DocumentInspectFocus,
  type DocumentOperation,
  type DocumentRuntime,
  type FindMatch,
  type FindResult,
  type InspectionPageInfo,
  type InspectionPayload,
  type InspectionResult,
  type OperationFailureCode,
  type OperationResult,
  type RuntimeCapabilities,
  type Diagnostic,
  type DiagnosticSeverity,
  type NonEmptyDiagnostics,
  type DocumentRef,
} from "@opensuite/agent-core";

import type { DocumentArtifactLoader } from "./document-artifact-loader.js";
import type {
  DocxCreateTableOperation,
  DocxDeleteParagraphOperation,
  DocxDeleteTableColumnOperation,
  DocxDeleteTableOperation,
  DocxDeleteTableRowOperation,
  DocxEngineBinding,
  DocxExtendedOperationName,
  DocxEngineDiagnostic,
  DocxInsertParagraphOperation,
  DocxInsertParagraphsOperation,
  DocxInsertTableColumnOperation,
  DocxInsertTableRowsOperation,
  DocxInspectAffordance,
  DocxInspectFocus,
  DocxInspectResult,
  DocxMutationBindingResult,
  DocxParagraphAlignment,
  DocxParagraphPlacement,
  DocxReplaceTextOperation,
  DocxRuntimeCapabilities,
  DocxSetParagraphFormattingOperation,
  DocxSetParagraphStyleOperation,
  DocxSetTableCellsTextOperation,
  DocxSetTableFormattingOperation,
  DocxSetTableCellShadingOperation,
  DocxSetTableColumnWidthsOperation,
  DocxSetTextFormattingOperation,
  DocxTableAlignment,
  DocxTableBorders,
  DocxTableCellTarget,
  DocxTableRowAnchor,
  DocxTableTarget,
  DocxTextTarget,
} from "./docx-engine-binding.js";

/**
 * Real DocumentRuntime backed by opensuite-engine's Node DOCX binding.
 *
 * Proven path:
 *   exact DocumentRef.versionId bytes
 *     → capabilities (Rust RuntimeCapabilities)
 *     → findDocxText / inspectDocx / mutate (replace_text | table ops)
 *
 * No mock semantic fallback for real DOCX execution. Unsupported inspect
 * focuses (slides/sheets/…) return structured UNSUPPORTED_OPERATION.
 */

const DOCX_MUTATION_TYPES = new Set([
  "document.replace_text",
  "document.insert_paragraph",
  "document.insert_paragraphs",
  "document.delete_paragraph",
  "document.set_paragraph_style",
  "document.set_paragraph_formatting",
  "document.set_text_formatting",
  "document.set_table_cells_text",
  "document.insert_table_rows",
  "document.insert_table_row",
  "document.insert_table_column",
  "document.create_table",
  "document.delete_table",
  "document.delete_table_row",
  "document.delete_table_column",
  "document.set_table_formatting",
  "document.set_table_column_widths",
  "document.set_table_cell_shading",
  "document.set_content_control_text",
  "document.set_paragraphs_list",
  "document.set_hyperlink",
  "document.insert_picture",
  "document.delete_picture",
  "document.set_picture_size",
  "document.replace_picture",
  "document.insert_page_break",
  "document.delete_page_break",
  "document.set_page_setup",
  "document.set_header_footer_text",
  "document.set_page_number",
]);
export interface OpenSuiteEngineAdapterOptions {
  readonly artifactLoader: DocumentArtifactLoader;
  readonly binding: DocxEngineBinding;
  /**
   * Optional override. When omitted, capabilities are derived from
   * `binding.getDocxCapabilities()` (Rust is source of truth).
   */
  readonly capabilities?: RuntimeCapabilities;
}

export function createOpenSuiteEngineAdapter(
  options: OpenSuiteEngineAdapterOptions,
): DocumentRuntime {
  const { artifactLoader, binding } = options;
  const cachedCapabilities =
    options.capabilities ??
    mapRustCapabilitiesToRuntime(binding.getDocxCapabilities());

  return {
    async loadBytes(document) {
      return artifactLoader.loadExactVersionBytes(document);
    },
    capabilities() {
      return cachedCapabilities;
    },

    async inspect(document, inspectOptions): Promise<InspectionResult> {
      throwIfAborted(inspectOptions?.signal);
      if (!hasCapability(cachedCapabilities, Capabilities.DocumentInspect)) {
        return unsupportedCapabilityResult(Capabilities.DocumentInspect);
      }

      if (document.format !== "docx") {
        return inspectionError(
          "VALIDATION_FAILED",
          `OpenSuiteEngineAdapter only supports DOCX inspect (got ${document.format})`,
          { format: document.format },
        );
      }

      const focus = inspectOptions?.focus ?? { kind: "overview" };
      const mappedFocus = mapApplicationInspectFocus(focus);
      if (!mappedFocus.ok) {
        return mappedFocus.error;
      }

      const inputBytes = await artifactLoader.loadExactVersionBytes(document);
      const response = await binding.inspectDocx(inputBytes, {
        focus: mappedFocus.focus,
      });

      return mapInspectBindingResult(
        response,
        mappedFocus.focus,
        cachedCapabilities,
      );
    },

    async find(document, query, findOptions): Promise<FindResult> {
      throwIfAborted(findOptions?.signal);
      if (!hasCapability(cachedCapabilities, Capabilities.DocumentFind)) {
        return unsupportedCapabilityFind(Capabilities.DocumentFind);
      }

      if (document.format !== "docx") {
        return findError(
          "VALIDATION_FAILED",
          `OpenSuiteEngineAdapter only supports DOCX find (got ${document.format})`,
          { format: document.format },
        );
      }

      const mode = query.mode ?? "text";
      if (mode === "semantic") {
        return findError(
          "UNSUPPORTED_OPERATION",
          'OpenSuiteEngineAdapter find mode "semantic" is not supported by the engine binding; use mode "text"',
          { mode },
        );
      }

      const trimmed = query.query.trim();
      if (!trimmed) {
        return findError(
          "INVALID_FIND_QUERY",
          "Find query must be a non-empty string",
        );
      }

      const inputBytes = await artifactLoader.loadExactVersionBytes(document);
      const response = await binding.findDocxText(inputBytes, {
        text: trimmed,
      });

      const diagnostics = response.diagnostics.map(mapDiagnostic);
      if (!response.ok) {
        return {
          status: "error",
          diagnostics: ensureNonEmpty(
            diagnostics.map(normalizeDiagnosticCode),
            "VALIDATION_FAILED",
            "Engine find failed",
          ),
        };
      }

      const maxResults = clampMaxResults(query.maxResults);
      const matches: FindMatch[] = response.matches
        .slice(0, maxResults)
        .map((match) => ({
          handle: `docx:find:${match.occurrence}`,
          excerpt: buildExcerpt(match.before, match.text, match.after),
          location: `${match.container} #${match.occurrence}`,
          score: 1,
        }));

      return {
        status: "success",
        query: trimmed,
        mode: "text",
        matches,
        diagnostics,
      };
    },

    async execute(
      document,
      operation,
      executeOptions,
    ): Promise<OperationResult> {
      throwIfAborted(executeOptions?.signal);
      if (!hasCapability(cachedCapabilities, Capabilities.DocumentMutate)) {
        return unsupportedCapabilityOperation(Capabilities.DocumentMutate);
      }

      if (document.format !== "docx") {
        return operationError(
          "VALIDATION_FAILED",
          `OpenSuiteEngineAdapter only supports DOCX mutations (got ${document.format})`,
          { format: document.format },
        );
      }

      if (operation.baseVersionId !== document.versionId) {
        return operationError(
          "CONFLICT",
          "baseDocumentVersionId does not match DocumentRef.versionId",
          {
            baseVersionId: operation.baseVersionId,
            versionId: document.versionId,
          },
        );
      }

      if (!DOCX_MUTATION_TYPES.has(operation.type)) {
        return operationError(
          "UNSUPPORTED_OPERATION",
          `Unsupported mutation type for OpenSuiteEngineAdapter: ${operation.type}`,
          { type: operation.type },
        );
      }

      const inputBytes = await artifactLoader.loadExactVersionBytes(document);

      if (operation.type === "document.replace_text") {
        const mapped = mapReplaceTextOperation(operation);
        if (!mapped.ok) {
          return mapped.error;
        }
        const engineResponse = await binding.executeDocxReplaceText(
          inputBytes,
          mapped.operation,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.insert_paragraph") {
        const mapped = mapInsertParagraphOperation(operation);
        if (!mapped.ok) {
          return mapped.error;
        }
        const engineResponse = await binding.executeDocxInsertParagraph(
          inputBytes,
          mapped.operation,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.insert_paragraphs") {
        const mapped = mapInsertParagraphsOperation(operation);
        if (!mapped.ok) {
          return mapped.error;
        }
        const engineResponse = await binding.executeDocxInsertParagraphs(
          inputBytes,
          mapped.operation,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.delete_paragraph") {
        const mapped = mapDeleteParagraphOperation(operation);
        if (!mapped.ok) {
          return mapped.error;
        }
        const engineResponse = await binding.executeDocxDeleteParagraph(
          inputBytes,
          mapped.operation,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.set_paragraph_style") {
        const mapped = mapSetParagraphStyleOperation(operation);
        if (!mapped.ok) {
          return mapped.error;
        }
        const engineResponse = await binding.executeDocxSetParagraphStyle(
          inputBytes,
          mapped.operation,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.set_paragraph_formatting") {
        const mapped = mapSetParagraphFormattingOperation(operation);
        if (!mapped.ok) {
          return mapped.error;
        }
        const engineResponse = await binding.executeDocxSetParagraphFormatting(
          inputBytes,
          mapped.operation,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.set_text_formatting") {
        if (Object.keys(operation.payload).some((key) => ["color", "underline", "highlight", "strikethrough", "verticalAlignment"].includes(key))) {
          if (!binding.executeDocxExtended) return operationError("UNSUPPORTED_OPERATION", "The installed DOCX binding does not support this operation");
          const payload = mapExtendedPayload(operation);
          if (!payload.ok) return payload.error;
          const engineResponse = await binding.executeDocxExtended(inputBytes, "executeDocxSetTextFormatting", payload.payload);
          return mapEngineMutationResult(engineResponse, operation.type);
        }
        const mapped = mapSetTextFormattingOperation(operation);
        if (!mapped.ok) {
          return mapped.error;
        }
        const engineResponse = await binding.executeDocxSetTextFormatting(
          inputBytes,
          mapped.operation,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.set_table_cells_text") {
        const mapped = mapSetTableCellsTextOperation(operation);
        if (!mapped.ok) {
          return mapped.error;
        }
        const engineResponse = await binding.executeDocxSetTableCellsText(
          inputBytes,
          mapped.operation,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.insert_table_rows") {
        const mapped = mapInsertTableRowsOperation(operation);
        if (!mapped.ok) {
          return mapped.error;
        }
        const engineResponse = await binding.executeDocxInsertTableRows(
          inputBytes,
          mapped.operation,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.insert_table_column") {
        const mapped = mapInsertTableColumnOperation(operation);
        if (!mapped.ok) {
          return mapped.error;
        }
        const engineResponse = await binding.executeDocxInsertTableColumn(
          inputBytes,
          mapped.operation,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.create_table") {
        const mapped = mapCreateTableOperation(operation);
        if (!mapped.ok) {
          return mapped.error;
        }
        const engineResponse = await binding.executeDocxCreateTable(
          inputBytes,
          mapped.operation,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.delete_table") {
        const mapped = mapDeleteTableOperation(operation);
        if (!mapped.ok) {
          return mapped.error;
        }
        const engineResponse = await binding.executeDocxDeleteTable(
          inputBytes,
          mapped.operation,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.delete_table_row") {
        const mapped = mapDeleteTableRowOperation(operation);
        if (!mapped.ok) {
          return mapped.error;
        }
        const engineResponse = await binding.executeDocxDeleteTableRow(
          inputBytes,
          mapped.operation,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.delete_table_column") {
        const mapped = mapDeleteTableColumnOperation(operation);
        if (!mapped.ok) {
          return mapped.error;
        }
        const engineResponse = await binding.executeDocxDeleteTableColumn(
          inputBytes,
          mapped.operation,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.set_table_column_widths") {
        if (!binding.executeDocxSetTableColumnWidths) return operationError("UNSUPPORTED_OPERATION", "The installed DOCX binding does not support table column widths");
        const mapped = mapSetTableColumnWidthsOperation(operation);
        if (!mapped.ok) return mapped.error;
        const engineResponse = await binding.executeDocxSetTableColumnWidths(inputBytes, mapped.operation);
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      if (operation.type === "document.set_table_cell_shading") {
        if (!binding.executeDocxSetTableCellShading) return operationError("UNSUPPORTED_OPERATION", "The installed DOCX binding does not support table cell shading");
        const mapped = mapSetTableCellShadingOperation(operation);
        if (!mapped.ok) return mapped.error;
        const engineResponse = await binding.executeDocxSetTableCellShading(inputBytes, mapped.operation);
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      const extendedName = EXTENDED_OPERATION_NAMES[operation.type];
      if (extendedName) {
        if (!binding.executeDocxExtended) {
          return operationError("UNSUPPORTED_OPERATION", "The installed DOCX binding does not support this operation");
        }
        const payload = mapExtendedPayload(operation);
        if (!payload.ok) return payload.error;
        const engineResponse = await binding.executeDocxExtended(
          inputBytes,
          extendedName,
          payload.payload,
        );
        return mapEngineMutationResult(engineResponse, operation.type);
      }

      const mapped = mapSetTableFormattingOperation(operation);
      if (!mapped.ok) {
        return mapped.error;
      }
      const engineResponse = await binding.executeDocxSetTableFormatting(
        inputBytes,
        mapped.operation,
      );
      return mapEngineMutationResult(engineResponse, operation.type);
    },

    // Reuse the identical adapter validation, mapping, and native dispatch
    // with a caller-owned source. This layer has no persistence side effects.
    async executeWithBytes(document, operation, bytes, executeOptions) {
      const workingRuntime = createOpenSuiteEngineAdapter({
        binding,
        capabilities: cachedCapabilities,
        artifactLoader: {
          async loadExactVersionBytes() {
            return bytes;
          },
        },
      });
      return workingRuntime.execute!(document, operation, executeOptions);
    },
  };
}

const EXTENDED_OPERATION_NAMES: Readonly<Record<string, DocxExtendedOperationName>> = {
  "document.set_content_control_text": "executeDocxSetContentControlText",
  "document.set_paragraphs_list": "executeDocxSetParagraphsList",
  "document.set_hyperlink": "executeDocxSetHyperlink",
  "document.insert_picture": "executeDocxInsertPicture",
  "document.delete_picture": "executeDocxDeletePicture",
  "document.set_picture_size": "executeDocxSetPictureSize",
  "document.replace_picture": "executeDocxReplacePicture",
  "document.insert_page_break": "executeDocxInsertPageBreak",
  "document.delete_page_break": "executeDocxDeletePageBreak",
  "document.set_page_setup": "executeDocxSetPageSetup",
  "document.set_header_footer_text": "executeDocxSetHeaderFooterText",
  "document.set_page_number": "executeDocxSetPageNumber",
  "document.insert_table_row": "executeDocxInsertTableRow",
};

function mapExtendedPayload(operation: DocumentOperation):
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | { readonly ok: false; readonly error: OperationResult } {
  // Tool schemas validate model input. This adapter only adds the version-local
  // engine revision and turns JSON byte arrays into Node buffers at the boundary.
  const payload: Record<string, unknown> = {
    ...operation.payload,
    baseRevision: operation.baseVersionId,
  };
  for (const key of ["imageBytes", "replacementBytes"] as const) {
    if (payload[key] !== undefined) {
      if (!Array.isArray(payload[key]) || !payload[key].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
        return { ok: false, error: operationError("VALIDATION_FAILED", `${operation.type} ${key} must be byte values`) };
      }
      payload[key] = Buffer.from(payload[key] as number[]);
    }
  }
  return { ok: true, payload };
}

/**
 * Map Rust RuntimeCapabilities into agent-core RuntimeCapabilities.
 * Rust remains the source of truth — we only bridge well-known tool gates.
 */
export function mapRustCapabilitiesToRuntime(
  engine: DocxRuntimeCapabilities,
): RuntimeCapabilities {
  const docx = engine.formats.find((format) => format.format === "docx");
  const rustIds = docx?.capabilities ?? [];
  const ids: string[] = [...rustIds];

  if (rustIds.includes("find_text")) {
    ids.push(Capabilities.DocumentFind);
  }
  if (
    rustIds.includes("inspect_context") ||
    rustIds.includes("inspect")
  ) {
    ids.push(Capabilities.DocumentInspect);
  }
  if (
    rustIds.includes("replace_text") ||
    rustIds.includes("insert_paragraph") ||
    rustIds.includes("insert_paragraphs") ||
    rustIds.includes("delete_paragraph") ||
    rustIds.includes("set_paragraph_style") ||
    rustIds.includes("set_paragraph_formatting") ||
    rustIds.includes("set_text_formatting") ||
    rustIds.includes("set_table_cells_text") ||
    rustIds.includes("insert_table_rows") ||
    rustIds.includes("insert_table_column") ||
    rustIds.includes("create_table") ||
    rustIds.includes("delete_table") ||
    rustIds.includes("delete_table_row") ||
    rustIds.includes("delete_table_column") ||
    rustIds.includes("set_table_formatting") ||
    rustIds.includes("set_table_column_widths") ||
    rustIds.includes("set_table_cell_shading") ||
    rustIds.includes("set_table_cell_text") ||
    rustIds.includes("insert_table_row")
  ) {
    ids.push(Capabilities.DocumentMutate);
  }

  return createCapabilities(...ids);
}

/** Exported for unit tests — application focus → binding focus. */
export function mapApplicationInspectFocus(
  focus: DocumentInspectFocus,
):
  | { readonly ok: true; readonly focus: DocxInspectFocus }
  | { readonly ok: false; readonly error: InspectionResult } {
  switch (focus.kind) {
    case "overview":
      return { ok: true, focus: { kind: "overview" } };
    case "structure":
    case "headings": {
      const bounds = normalizeInspectBounds(
        focus.kind === "headings" ? focus.offset : undefined,
        focus.kind === "headings" ? focus.limit : undefined,
      );
      if (!bounds.ok) return { ok: false, error: bounds.error };
      return {
        ok: true,
        focus: {
          kind: "headings",
          offset: bounds.offset,
          limit: bounds.limit,
        },
      };
    }
    case "paragraphs": {
      const bounds = normalizeInspectBounds(focus.offset, focus.limit);
      if (!bounds.ok) return { ok: false, error: bounds.error };
      return {
        ok: true,
        focus: {
          kind: "paragraphs",
          offset: bounds.offset,
          limit: bounds.limit,
        },
      };
    }
    case "tables": {
      const bounds = normalizeInspectBounds(focus.offset, focus.limit);
      if (!bounds.ok) return { ok: false, error: bounds.error };
      return {
        ok: true,
        focus: {
          kind: "tables",
          offset: bounds.offset,
          limit: bounds.limit,
        },
      };
    }
    case "body_blocks": {
      const bounds = normalizeInspectBounds(focus.offset, focus.limit);
      if (!bounds.ok) return { ok: false, error: bounds.error };
      return {
        ok: true,
        focus: {
          kind: "body_blocks",
          offset: bounds.offset,
          limit: bounds.limit,
        },
      };
    }
    case "context": {
      if (!focus.text) {
        return {
          ok: false,
          error: inspectionError(
            "VALIDATION_FAILED",
            "inspect focus.kind=context requires non-empty text",
          ),
        };
      }
      return {
        ok: true,
        focus: {
          kind: "context",
          text: focus.text,
          ...(focus.occurrence !== undefined
            ? { occurrence: focus.occurrence }
            : {}),
          ...(focus.before !== undefined ? { before: focus.before } : {}),
          ...(focus.after !== undefined ? { after: focus.after } : {}),
        },
      };
    }
    case "slides":
    case "slide":
    case "sheets":
    case "range":
      return {
        ok: false,
        error: inspectionError(
          "UNSUPPORTED_OPERATION",
          `OpenSuiteEngineAdapter does not support inspect focus "${focus.kind}" on DOCX`,
          { focus },
        ),
      };
    default: {
      const _exhaustive: never = focus;
      void _exhaustive;
      return {
        ok: false,
        error: inspectionError(
          "UNSUPPORTED_OPERATION",
          "OpenSuiteEngineAdapter received an unsupported inspect focus",
        ),
      };
    }
  }
}

function normalizeInspectBounds(
  offset: number | undefined,
  limit: number | undefined,
):
  | { readonly ok: true; readonly offset: number; readonly limit: number }
  | { readonly ok: false; readonly error: InspectionResult } {
  const resolvedOffset = offset ?? 0;
  const resolvedLimit = limit ?? DEFAULT_INSPECT_PAGE_LIMIT;
  if (
    !Number.isInteger(resolvedOffset) ||
    resolvedOffset < 0 ||
    !Number.isInteger(resolvedLimit) ||
    resolvedLimit < 1
  ) {
    return {
      ok: false,
      error: inspectionError(
        "INVALID_INSPECTION_BOUNDS",
        "inspect offset must be >= 0 and limit must be a positive integer",
        { offset: resolvedOffset, limit: resolvedLimit },
      ),
    };
  }
  return {
    ok: true,
    offset: resolvedOffset,
    limit: Math.min(resolvedLimit, MAX_INSPECT_PAGE_LIMIT),
  };
}

/** Exported for unit tests — binding inspect result → DocumentRuntime result. */
export function mapInspectBindingResult(
  response: DocxInspectResult,
  focus: DocxInspectFocus,
  capabilities: RuntimeCapabilities,
): InspectionResult {
  const diagnostics = response.diagnostics.map(mapDiagnostic);
  if (!response.ok) {
    return {
      status: "error",
      diagnostics: ensureNonEmpty(
        diagnostics.map(normalizeDiagnosticCode),
        "VALIDATION_FAILED",
        "Engine inspect failed",
      ),
    };
  }

  const applicationFocus = toApplicationFocus(focus);
  const payload = mapInspectPayload(response, focus);
  if (!payload) {
    return inspectionError(
      "VALIDATION_FAILED",
      `Engine inspect succeeded but returned no payload for focus "${focus.kind}"`,
      { focus: focus.kind },
    );
  }

  return {
    status: "success",
    format: "docx",
    capabilities,
    diagnostics,
    focus: applicationFocus,
    payload,
  };
}

function toApplicationFocus(focus: DocxInspectFocus): DocumentInspectFocus {
  switch (focus.kind) {
    case "overview":
      return { kind: "overview" };
    case "headings":
      return {
        kind: "headings",
        offset: focus.offset,
        limit: focus.limit,
      };
    case "paragraphs":
      return {
        kind: "paragraphs",
        offset: focus.offset,
        limit: focus.limit,
      };
    case "tables":
      return {
        kind: "tables",
        offset: focus.offset,
        limit: focus.limit,
      };
    case "body_blocks":
      return {
        kind: "body_blocks",
        offset: focus.offset,
        limit: focus.limit,
      };
    case "context":
      return {
        kind: "context",
        text: focus.text,
        ...(focus.occurrence !== undefined
          ? { occurrence: focus.occurrence }
          : {}),
        ...(focus.before !== undefined ? { before: focus.before } : {}),
        ...(focus.after !== undefined ? { after: focus.after } : {}),
      };
  }
}

function mapInspectPayload(
  response: DocxInspectResult,
  focus: DocxInspectFocus,
): InspectionPayload | null {
  switch (focus.kind) {
    case "overview": {
      if (!response.overview) return null;
      return {
        format: "docx",
        summary: {
          title: null,
          unitKind: "page",
          unitCount: response.overview.sectionCount,
        },
        overview: {
          bodyBlockCount: response.overview.bodyBlockCount,
          paragraphCount: response.overview.paragraphCount,
          tableCount: response.overview.tableCount,
          sectionCount: response.overview.sectionCount,
        },
      };
    }
    case "headings": {
      if (!response.headings) return null;
      return {
        format: "docx",
        summary: {
          title: null,
          unitKind: "page",
          unitCount: response.headings.page.total,
        },
        page: mapPage(response.headings.page),
        headings: response.headings.items.map((item) => ({
          handle: `docx:heading:${item.occurrence}`,
          text: item.text,
          occurrence: item.occurrence,
          styleName: item.styleName,
          ...(item.level !== undefined ? { level: item.level } : {}),
        })),
      };
    }
    case "paragraphs": {
      if (!response.paragraphs) return null;
      return {
        format: "docx",
        summary: {
          title: null,
          unitKind: "page",
          unitCount: response.paragraphs.page.total,
        },
        page: mapPage(response.paragraphs.page),
        paragraphs: response.paragraphs.items.map((item) => ({
          handle: `docx:paragraph:${item.occurrence}`,
          text: item.text,
          occurrence: item.occurrence,
          ...(item.styleName !== undefined
            ? { styleName: item.styleName }
            : {}),
        })),
      };
    }
    case "tables": {
      if (!response.tables) return null;
      return {
        format: "docx",
        summary: {
          title: null,
          unitKind: "page",
          unitCount: response.tables.page.total,
        },
        page: mapPage(response.tables.page),
        tables: response.tables.items.map((item) => {
          const textGrid = item.rows.map((row) => row.cells);
          const cols = textGrid.reduce(
            (max, row) => Math.max(max, row.length),
            0,
          );
          const rows = item.rows.map((row) => ({
            handle: row.handle,
            cells: row.cells.map((text, index) => {
              const handle = row.cellHandles[index];
              if (typeof handle !== "string" || !handle) {
                throw new Error(
                  "Engine table inspection returned cells without matching cellHandles",
                );
              }
              const cellAffordances = row.cellAffordances?.[index];
              return {
                handle,
                text,
                ...optionalAffordances(cellAffordances),
              };
            }),
          }));
          return {
            handle: item.handle,
            occurrence: item.occurrence,
            rowCount: item.rowCount,
            cols,
            isRectangular: item.isRectangular,
            ...optionalAffordances(item.affordances),
            columns: item.columns.map((column) => ({
              handle: column.handle,
              text: column.text,
              occurrence: column.occurrence,
            })),
            rows,
            cells: textGrid,
          };
        }),
      };
    }
    case "body_blocks": {
      if (!response.bodyBlocks) return null;
      return {
        format: "docx",
        summary: {
          title: null,
          unitKind: "page",
          unitCount: response.bodyBlocks.page.total,
        },
        page: mapPage(response.bodyBlocks.page),
        bodyBlocks: response.bodyBlocks.items.map((item) => ({
          handle: item.handle,
          kind: item.kind,
          ...(item.text != null && item.text !== undefined
            ? { text: item.text }
            : {}),
          ...(item.tableHandle != null && item.tableHandle !== undefined
            ? { tableHandle: item.tableHandle }
            : {}),
          ...(item.picture !== undefined
            ? { picture: {
              handle: item.picture.handle,
              format: item.picture.format,
              widthEmu: item.picture.widthEmu,
              heightEmu: item.picture.heightEmu,
              ...(item.picture.altText !== undefined ? { altText: item.picture.altText } : {}),
              ...optionalAffordances(item.picture.affordances),
            } }
            : {}),
        })),
      };
    }
    case "context": {
      if (!response.context) return null;
      const unitCount =
        (response.context.container ? 1 : 0) + response.context.nearby.length;
      return {
        format: "docx",
        summary: {
          title: null,
          unitKind: "page",
          unitCount,
        },
        context: {
          target: {
            text: response.context.target.text,
            ...(response.context.target.occurrence !== undefined
              ? { occurrence: response.context.target.occurrence }
              : {}),
          },
          ...(response.context.container
            ? {
                container: {
                  text: response.context.container.text,
                  container: response.context.container.container,
                  relativePosition:
                    response.context.container.relativePosition,
                },
              }
            : {}),
          nearby: response.context.nearby.map((item) => ({
            text: item.text,
            container: item.container,
            relativePosition: item.relativePosition,
          })),
        },
      };
    }
  }
}

function mapPage(page: {
  readonly total: number;
  readonly offset: number;
  readonly returned: number;
  readonly hasMore: boolean;
}): InspectionPageInfo {
  return {
    total: page.total,
    offset: page.offset,
    returned: page.returned,
    hasMore: page.hasMore,
  };
}

/**
 * Transport-only: pass engine affordances through unchanged.
 * Absence (undefined) is preserved — do not invent supported/unsupported.
 */
function optionalAffordances(
  values: readonly DocxInspectAffordance[] | undefined,
): { readonly affordances: ReturnType<typeof mapAffordances> } | Record<string, never> {
  if (values === undefined) {
    return {};
  }
  return { affordances: mapAffordances(values) };
}

function mapAffordances(
  values: readonly DocxInspectAffordance[],
): readonly {
  readonly capability: string;
  readonly supported: boolean;
  readonly reason?: string;
}[] {
  return values.map((item) => ({
    capability: item.capability,
    supported: item.supported,
    ...(typeof item.reason === "string" && item.reason
      ? { reason: item.reason }
      : {}),
  }));
}

/** Exported for unit tests — application DTO → binding DTO only. */
export function mapInsertParagraphOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxInsertParagraphOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const text = readString(operation.payload.text);
  if (text === null) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.insert_paragraph requires payload.text (string)",
      ),
    };
  }

  const placementMapped = mapParagraphPlacementPayload(
    operation.payload.placement,
    "document.insert_paragraph",
  );
  if (!placementMapped.ok) {
    return placementMapped;
  }

  return {
    ok: true,
    operation: {
      text,
      placement: placementMapped.placement,
      baseRevision: operation.baseVersionId,
    },
  };
}

/** Exported for unit tests — application DTO → binding DTO only. */
export function mapInsertParagraphsOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxInsertParagraphsOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const textsRaw = operation.payload.texts;
  if (!Array.isArray(textsRaw)) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.insert_paragraphs requires payload.texts (string array)",
      ),
    };
  }
  const texts: string[] = [];
  for (const item of textsRaw) {
    if (typeof item !== "string") {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          "document.insert_paragraphs payload.texts must be strings",
        ),
      };
    }
    texts.push(item);
  }

  const placementMapped = mapParagraphPlacementPayload(
    operation.payload.placement,
    "document.insert_paragraphs",
  );
  if (!placementMapped.ok) {
    return placementMapped;
  }

  return {
    ok: true,
    operation: {
      texts,
      placement: placementMapped.placement,
      baseRevision: operation.baseVersionId,
    },
  };
}

export function mapDeleteParagraphOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxDeleteParagraphOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const target = mapTextTargetPayload(
    operation.payload.target,
    "document.delete_paragraph",
  );
  if (!target.ok) {
    return target;
  }
  return {
    ok: true,
    operation: {
      target: target.target,
      baseRevision: operation.baseVersionId,
    },
  };
}

export function mapSetParagraphStyleOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxSetParagraphStyleOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const target = mapTextTargetPayload(
    operation.payload.target,
    "document.set_paragraph_style",
  );
  if (!target.ok) {
    return target;
  }

  let style: string | undefined;
  if (operation.payload.style !== undefined && operation.payload.style !== null) {
    const parsed = readString(operation.payload.style);
    if (parsed === null) {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          "document.set_paragraph_style style must be a string when provided",
        ),
      };
    }
    style = parsed;
  }

  return {
    ok: true,
    operation: {
      target: target.target,
      ...(style !== undefined ? { style } : {}),
      baseRevision: operation.baseVersionId,
    },
  };
}

export function mapSetParagraphFormattingOperation(
  operation: DocumentOperation,
):
  | {
      readonly ok: true;
      readonly operation: DocxSetParagraphFormattingOperation;
    }
  | { readonly ok: false; readonly error: OperationResult } {
  const target = mapTextTargetPayload(
    operation.payload.target,
    "document.set_paragraph_formatting",
  );
  if (!target.ok) {
    return target;
  }

  let alignment: DocxParagraphAlignment | undefined;
  if (operation.payload.alignment !== undefined) {
    const value = readString(operation.payload.alignment);
    if (value !== "left" && value !== "center" && value !== "right") {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          "document.set_paragraph_formatting alignment must be left|center|right",
        ),
      };
    }
    alignment = value;
  }

  const spacingBefore = readOptionalInt(
    operation.payload.spacingBeforeTwips,
    "document.set_paragraph_formatting spacingBeforeTwips",
  );
  if (spacingBefore === "invalid") {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.set_paragraph_formatting spacingBeforeTwips must be an integer",
      ),
    };
  }

  const spacingAfter = readOptionalInt(
    operation.payload.spacingAfterTwips,
    "document.set_paragraph_formatting spacingAfterTwips",
  );
  if (spacingAfter === "invalid") {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.set_paragraph_formatting spacingAfterTwips must be an integer",
      ),
    };
  }

  return {
    ok: true,
    operation: {
      target: target.target,
      ...(alignment !== undefined ? { alignment } : {}),
      ...(spacingBefore !== undefined
        ? { spacingBeforeTwips: spacingBefore }
        : {}),
      ...(spacingAfter !== undefined
        ? { spacingAfterTwips: spacingAfter }
        : {}),
      baseRevision: operation.baseVersionId,
    },
  };
}

export function mapSetTextFormattingOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxSetTextFormattingOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const target = mapTextTargetPayload(
    operation.payload.target,
    "document.set_text_formatting",
  );
  if (!target.ok) {
    return target;
  }

  let bold: boolean | undefined;
  if (operation.payload.bold !== undefined) {
    if (typeof operation.payload.bold !== "boolean") {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          "document.set_text_formatting bold must be a boolean",
        ),
      };
    }
    bold = operation.payload.bold;
  }

  let italic: boolean | undefined;
  if (operation.payload.italic !== undefined) {
    if (typeof operation.payload.italic !== "boolean") {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          "document.set_text_formatting italic must be a boolean",
        ),
      };
    }
    italic = operation.payload.italic;
  }

  const fontSize = readOptionalPositiveInt(
    operation.payload.fontSizeHalfPoints,
    "document.set_text_formatting fontSizeHalfPoints",
  );
  if (fontSize === "invalid") {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.set_text_formatting fontSizeHalfPoints must be a positive integer",
      ),
    };
  }

  let fontFamily: string | undefined;
  if (operation.payload.fontFamily !== undefined) {
    const parsed = readString(operation.payload.fontFamily);
    if (parsed === null) {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          "document.set_text_formatting fontFamily must be a string",
        ),
      };
    }
    fontFamily = parsed;
  }

  return {
    ok: true,
    operation: {
      target: target.target,
      ...(bold !== undefined ? { bold } : {}),
      ...(italic !== undefined ? { italic } : {}),
      ...(fontSize !== undefined ? { fontSizeHalfPoints: fontSize } : {}),
      ...(fontFamily !== undefined ? { fontFamily } : {}),
      baseRevision: operation.baseVersionId,
    },
  };
}

function mapParagraphPlacementPayload(
  placementRaw: unknown,
  label: string,
):
  | { readonly ok: true; readonly placement: DocxParagraphPlacement }
  | { readonly ok: false; readonly error: OperationResult } {
  if (!isRecord(placementRaw) || typeof placementRaw.kind !== "string") {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        `${label} requires payload.placement.kind`,
      ),
    };
  }

  const kind = placementRaw.kind;
  if (kind === "start" || kind === "end") {
    return { ok: true, placement: { kind } };
  }
  if (kind === "before" || kind === "after") {
    const handle = readNonEmptyString(placementRaw.handle);
    if (handle === null) {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          `${label} placement.${kind} requires non-empty handle`,
        ),
      };
    }
    return { ok: true, placement: { kind, handle } };
  }
  return {
    ok: false,
    error: operationError(
      "VALIDATION_FAILED",
      `${label} placement.kind must be start|end|before|after`,
    ),
  };
}

function mapTextTargetPayload(
  raw: unknown,
  label: string,
):
  | { readonly ok: true; readonly target: DocxTextTarget }
  | { readonly ok: false; readonly error: OperationResult } {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        `${label} requires a target object with text`,
      ),
    };
  }
  const text = readNonEmptyString(raw.text);
  if (text === null) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        `${label} requires non-empty target.text`,
      ),
    };
  }
  const occurrence = readOptionalPositiveInt(
    raw.occurrence,
    `${label} target.occurrence`,
  );
  if (occurrence === "invalid") {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        `${label} target.occurrence must be a positive integer when provided`,
      ),
    };
  }
  return {
    ok: true,
    target: {
      text,
      ...(occurrence !== undefined ? { occurrence } : {}),
    },
  };
}

export function mapReplaceTextOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxReplaceTextOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const payload = operation.payload;
  const targetText = readNonEmptyString(
    payload.targetText ??
      (isRecord(payload.target) ? payload.target.text : undefined) ??
      payload.find,
  );
  if (targetText === null) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.replace_text requires non-empty target text (payload.find or payload.targetText)",
      ),
    };
  }

  const replacement = readString(payload.replacement ?? payload.replace);
  if (replacement === null) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.replace_text requires payload.replacement or payload.replace",
      ),
    };
  }

  const expectedCurrentText =
    readString(payload.expectedCurrentText) ?? targetText;

  const occurrence = readOptionalPositiveInt(
    payload.occurrence,
    "document.replace_text payload.occurrence",
  );
  if (occurrence === "invalid") {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.replace_text payload.occurrence must be a positive integer when provided",
      ),
    };
  }

  return {
    ok: true,
    operation: {
      target: {
        text: targetText,
        ...(occurrence !== undefined ? { occurrence } : {}),
      },
      expectedCurrentText,
      replacement,
      // Opaque metadata only — does not enforce application concurrency.
      baseRevision: operation.baseVersionId,
    },
  };
}

/** Exported for unit tests. */
export function mapSetTableCellsTextOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxSetTableCellsTextOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const table = mapTableTarget(
    operation.payload.table,
    "document.set_table_cells_text",
  );
  if (!table.ok) return table;

  const updatesRaw = operation.payload.updates;
  if (!Array.isArray(updatesRaw) || updatesRaw.length === 0) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.set_table_cells_text requires a non-empty updates array",
      ),
    };
  }

  const updates: Array<DocxSetTableCellsTextOperation["updates"][number]> = [];
  for (const item of updatesRaw) {
    if (!isRecord(item)) {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          "document.set_table_cells_text updates entries must be objects",
        ),
      };
    }
    const expectedCurrentText = readString(item.expectedCurrentText);
    const replacement = readString(item.replacement);
    if (expectedCurrentText === null || replacement === null) {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          "document.set_table_cells_text updates require expectedCurrentText and replacement",
        ),
      };
    }
    const mappedTarget = mapCellTarget(
      item,
      "document.set_table_cells_text",
    );
    if (!mappedTarget.ok) return mappedTarget;
    updates.push({
      target: mappedTarget.value,
      expectedCurrentText,
      replacement,
    });
  }

  return {
    ok: true,
    operation: {
      table: table.value,
      updates,
      baseRevision: operation.baseVersionId,
    },
  };
}

/** Exported for unit tests. */
export function mapInsertTableRowsOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxInsertTableRowsOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const table = mapTableTarget(
    operation.payload.table,
    "document.insert_table_rows",
  );
  if (!table.ok) return table;

  if (!isRecord(operation.payload.after)) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.insert_table_rows requires after row anchor",
      ),
    };
  }
  const after = mapRowAnchor(
    operation.payload.after,
    "document.insert_table_rows",
  );
  if (!after.ok) return after;

  const rowsRaw = operation.payload.rows;
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.insert_table_rows requires a non-empty rows array",
      ),
    };
  }
  const rows: string[][] = [];
  for (const row of rowsRaw) {
    if (!Array.isArray(row) || row.length === 0) {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          "document.insert_table_rows each row must be a non-empty string array",
        ),
      };
    }
    const cells: string[] = [];
    for (const cell of row) {
      if (typeof cell !== "string") {
        return {
          ok: false,
          error: operationError(
            "VALIDATION_FAILED",
            "document.insert_table_rows row cells must be strings",
          ),
        };
      }
      cells.push(cell);
    }
    rows.push(cells);
  }

  return {
    ok: true,
    operation: {
      table: table.value,
      after: after.value,
      rows,
      baseRevision: operation.baseVersionId,
    },
  };
}

/** Exported for unit tests. */
export function mapInsertTableColumnOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxInsertTableColumnOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const table = mapTableTarget(
    operation.payload.table,
    "document.insert_table_column",
  );
  if (!table.ok) return table;
  // Engine column-insert verify currently panics when headerCells is empty
  // (even with a table handle). Reject in-process before calling N-API.
  if (!table.value.headerCells || table.value.headerCells.length === 0) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.insert_table_column requires non-empty table.headerCells (from inspect); handle alone is not enough for column insert",
      ),
    };
  }

  const afterColumnHeader = readNonEmptyString(
    operation.payload.afterColumnHeader,
  );
  const afterColumnHandle = readNonEmptyString(
    operation.payload.afterColumnHandle,
  );
  const header = readNonEmptyString(operation.payload.header);
  if (header === null) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.insert_table_column requires a header string",
      ),
    };
  }
  if (afterColumnHeader === null && afterColumnHandle === null) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.insert_table_column requires afterColumnHeader or afterColumnHandle",
      ),
    };
  }

  const cellsRaw = operation.payload.cells;
  if (!Array.isArray(cellsRaw)) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.insert_table_column requires a cells array (one value per data row)",
      ),
    };
  }
  const cells: string[] = [];
  for (const cell of cellsRaw) {
    if (typeof cell !== "string") {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          "document.insert_table_column cells must be strings",
        ),
      };
    }
    cells.push(cell);
  }

  return {
    ok: true,
    operation: {
      table: table.value,
      ...(afterColumnHeader !== null
        ? { afterColumnHeader }
        : {}),
      ...(afterColumnHandle !== null
        ? { afterColumnHandle }
        : {}),
      header,
      cells,
      baseRevision: operation.baseVersionId,
    },
  };
}

/** Exported for unit tests. */
export function mapCreateTableOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxCreateTableOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const rowsRaw = operation.payload.rows;
  if (!Array.isArray(rowsRaw) || rowsRaw.length === 0) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.create_table requires a non-empty rows matrix",
      ),
    };
  }
  const rows: string[][] = [];
  for (const row of rowsRaw) {
    if (!Array.isArray(row)) {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          "document.create_table each row must be a string array",
        ),
      };
    }
    const cells: string[] = [];
    for (const cell of row) {
      if (typeof cell !== "string") {
        return {
          ok: false,
          error: operationError(
            "VALIDATION_FAILED",
            "document.create_table cells must be strings (empty string allowed)",
          ),
        };
      }
      cells.push(cell);
    }
    rows.push(cells);
  }

  const placementMapped = mapParagraphPlacementPayload(
    operation.payload.placement,
    "document.create_table",
  );
  if (!placementMapped.ok) {
    return placementMapped;
  }

  return {
    ok: true,
    operation: {
      rows,
      placement: placementMapped.placement,
      baseRevision: operation.baseVersionId,
    },
  };
}

export function mapDeleteTableOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxDeleteTableOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const table = mapTableTarget(
    operation.payload.table,
    "document.delete_table",
  );
  if (!table.ok) return table;
  return {
    ok: true,
    operation: {
      table: table.value,
      baseRevision: operation.baseVersionId,
    },
  };
}

export function mapDeleteTableRowOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxDeleteTableRowOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const table = mapTableTarget(
    operation.payload.table,
    "document.delete_table_row",
  );
  if (!table.ok) return table;
  if (!isRecord(operation.payload.row)) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.delete_table_row requires a row target object",
      ),
    };
  }
  const row = mapRowAnchor(operation.payload.row, "document.delete_table_row");
  if (!row.ok) return row;
  return {
    ok: true,
    operation: {
      table: table.value,
      row: row.value,
      baseRevision: operation.baseVersionId,
    },
  };
}

export function mapDeleteTableColumnOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxDeleteTableColumnOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const table = mapTableTarget(
    operation.payload.table,
    "document.delete_table_column",
  );
  if (!table.ok) return table;

  const columnHeader = readNonEmptyString(operation.payload.columnHeader);
  const columnHandle = readNonEmptyString(operation.payload.columnHandle);
  if (columnHeader === null && columnHandle === null) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.delete_table_column requires columnHeader or columnHandle",
      ),
    };
  }

  return {
    ok: true,
    operation: {
      table: table.value,
      ...(columnHeader !== null ? { columnHeader } : {}),
      ...(columnHandle !== null ? { columnHandle } : {}),
      baseRevision: operation.baseVersionId,
    },
  };
}

export function mapSetTableFormattingOperation(
  operation: DocumentOperation,
):
  | { readonly ok: true; readonly operation: DocxSetTableFormattingOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const table = mapTableTarget(
    operation.payload.table,
    "document.set_table_formatting",
  );
  if (!table.ok) return table;

  let alignment: DocxTableAlignment | undefined;
  if (operation.payload.alignment !== undefined) {
    const value = readString(operation.payload.alignment);
    if (
      value !== "left" &&
      value !== "center" &&
      value !== "right" &&
      value !== "clear"
    ) {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          "document.set_table_formatting alignment must be left|center|right|clear",
        ),
      };
    }
    alignment = value;
  }

  let borders: DocxTableBorders | undefined;
  if (operation.payload.borders !== undefined) {
    const value = readString(operation.payload.borders);
    if (value !== "grid" && value !== "none" && value !== "clear") {
      return {
        ok: false,
        error: operationError(
          "VALIDATION_FAILED",
          "document.set_table_formatting borders must be grid|none|clear",
        ),
      };
    }
    borders = value;
  }

  const top = readOptionalInt(
    operation.payload.cellMarginTopTwips,
    "document.set_table_formatting cellMarginTopTwips",
  );
  if (top === "invalid") {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.set_table_formatting cellMarginTopTwips must be an integer",
      ),
    };
  }
  const right = readOptionalInt(
    operation.payload.cellMarginRightTwips,
    "document.set_table_formatting cellMarginRightTwips",
  );
  if (right === "invalid") {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.set_table_formatting cellMarginRightTwips must be an integer",
      ),
    };
  }
  const bottom = readOptionalInt(
    operation.payload.cellMarginBottomTwips,
    "document.set_table_formatting cellMarginBottomTwips",
  );
  if (bottom === "invalid") {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.set_table_formatting cellMarginBottomTwips must be an integer",
      ),
    };
  }
  const left = readOptionalInt(
    operation.payload.cellMarginLeftTwips,
    "document.set_table_formatting cellMarginLeftTwips",
  );
  if (left === "invalid") {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.set_table_formatting cellMarginLeftTwips must be an integer",
      ),
    };
  }

  const marginParts = [top, right, bottom, left];
  const marginCount = marginParts.filter((v) => v !== undefined).length;
  if (marginCount > 0 && marginCount < 4) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.set_table_formatting requires all four cellMargin*Twips together",
      ),
    };
  }

  if (alignment === undefined && borders === undefined && marginCount === 0) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        "document.set_table_formatting requires alignment, borders, and/or all four cell margins",
      ),
    };
  }

  return {
    ok: true,
    operation: {
      table: table.value,
      ...(alignment !== undefined ? { alignment } : {}),
      ...(borders !== undefined ? { borders } : {}),
      ...(top !== undefined ? { cellMarginTopTwips: top } : {}),
      ...(right !== undefined ? { cellMarginRightTwips: right } : {}),
      ...(bottom !== undefined ? { cellMarginBottomTwips: bottom } : {}),
      ...(left !== undefined ? { cellMarginLeftTwips: left } : {}),
      baseRevision: operation.baseVersionId,
    },
  };
}

export function mapSetTableColumnWidthsOperation(operation: DocumentOperation):
  | { readonly ok: true; readonly operation: DocxSetTableColumnWidthsOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const table = mapTableTarget(operation.payload.table, "document.set_table_column_widths");
  if (!table.ok) return table;
  if (!Array.isArray(operation.payload.widthsTwips) || operation.payload.widthsTwips.length === 0 || !operation.payload.widthsTwips.every((width) => Number.isInteger(width) && width > 0)) {
    return { ok: false, error: operationError("VALIDATION_FAILED", "document.set_table_column_widths requires positive integer widthsTwips") };
  }
  return { ok: true, operation: { table: table.value, widthsTwips: operation.payload.widthsTwips as number[], baseRevision: operation.baseVersionId } };
}

export function mapSetTableCellShadingOperation(operation: DocumentOperation):
  | { readonly ok: true; readonly operation: DocxSetTableCellShadingOperation }
  | { readonly ok: false; readonly error: OperationResult } {
  const table = mapTableTarget(operation.payload.table, "document.set_table_cell_shading");
  if (!table.ok) return table;
  if (!Array.isArray(operation.payload.updates) || operation.payload.updates.length === 0) {
    return { ok: false, error: operationError("VALIDATION_FAILED", "document.set_table_cell_shading requires updates") };
  }
  const updates: DocxSetTableCellShadingOperation["updates"][number][] = [];
  for (const raw of operation.payload.updates) {
    if (!isRecord(raw)) return { ok: false, error: operationError("VALIDATION_FAILED", "document.set_table_cell_shading updates must be objects") };
    const target = mapCellTarget(raw, "document.set_table_cell_shading");
    if (!target.ok) return target;
    if (raw.fill !== undefined && (typeof raw.fill !== "string" || !/^[0-9A-Fa-f]{6}$/.test(raw.fill))) {
      return { ok: false, error: operationError("VALIDATION_FAILED", "document.set_table_cell_shading fill must be a six-digit hex color") };
    }
    updates.push({ target: target.value, ...(typeof raw.fill === "string" ? { fill: raw.fill.toUpperCase() } : {}) });
  }
  return { ok: true, operation: { table: table.value, updates, baseRevision: operation.baseVersionId } };
}

function mapTableTarget(
  raw: unknown,
  operationLabel: string,
):
  | { readonly ok: true; readonly value: DocxTableTarget }
  | { readonly ok: false; readonly error: OperationResult } {
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        `${operationLabel} requires a table target object`,
      ),
    };
  }
  const handle = readNonEmptyString(raw.handle);
  const headerCellsRaw = Array.isArray(raw.headerCells)
    ? raw.headerCells
    : null;
  if (handle === null && (!headerCellsRaw || headerCellsRaw.length === 0)) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        `${operationLabel} table requires handle or non-empty headerCells`,
      ),
    };
  }
  const headerCells: string[] = [];
  if (headerCellsRaw) {
    for (const cell of headerCellsRaw) {
      if (typeof cell !== "string") {
        return {
          ok: false,
          error: operationError(
            "VALIDATION_FAILED",
            `${operationLabel} table.headerCells must be strings`,
          ),
        };
      }
      headerCells.push(cell);
    }
  }
  const occurrence = readOptionalPositiveInt(
    raw.occurrence,
    `${operationLabel} table.occurrence`,
  );
  if (occurrence === "invalid") {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        `${operationLabel} table.occurrence must be a positive integer when provided`,
      ),
    };
  }
  return {
    ok: true,
    value: {
      ...(headerCells.length > 0 ? { headerCells } : {}),
      ...(occurrence !== undefined ? { occurrence } : {}),
      ...(handle !== null ? { handle } : {}),
    },
  };
}

function mapRowAnchor(
  raw: Record<string, unknown>,
  operationLabel: string,
):
  | { readonly ok: true; readonly value: DocxTableRowAnchor }
  | { readonly ok: false; readonly error: OperationResult } {
  const handle = readNonEmptyString(raw.handle);
  const firstCellText = readNonEmptyString(raw.firstCellText);
  if (handle === null && firstCellText === null) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        `${operationLabel} after requires handle or non-empty firstCellText`,
      ),
    };
  }
  const occurrence = readOptionalPositiveInt(
    raw.occurrence,
    `${operationLabel} after.occurrence`,
  );
  if (occurrence === "invalid") {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        `${operationLabel} after.occurrence must be a positive integer when provided`,
      ),
    };
  }
  return {
    ok: true,
    value: {
      ...(firstCellText !== null ? { firstCellText } : {}),
      ...(occurrence !== undefined ? { occurrence } : {}),
      ...(handle !== null ? { handle } : {}),
    },
  };
}

function mapCellTarget(
  item: Record<string, unknown>,
  operationLabel: string,
):
  | { readonly ok: true; readonly value: DocxTableCellTarget }
  | { readonly ok: false; readonly error: OperationResult } {
  const targetSource = isRecord(item.target) ? item.target : item;
  const handle = readNonEmptyString(targetSource.handle);
  if (handle !== null) {
    return { ok: true, value: { handle } };
  }
  const rowLabel = readNonEmptyString(targetSource.rowLabel);
  const columnHeader = readNonEmptyString(targetSource.columnHeader);
  if (rowLabel === null || columnHeader === null) {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        `${operationLabel} updates require target.handle or rowLabel+columnHeader`,
      ),
    };
  }
  const occurrence = readOptionalPositiveInt(
    targetSource.occurrence,
    `${operationLabel} update occurrence`,
  );
  if (occurrence === "invalid") {
    return {
      ok: false,
      error: operationError(
        "VALIDATION_FAILED",
        `${operationLabel} update occurrence must be a positive integer when provided`,
      ),
    };
  }
  return {
    ok: true,
    value: {
      rowLabel,
      columnHeader,
      ...(occurrence !== undefined ? { occurrence } : {}),
    },
  };
}

function readOptionalInt(
  value: unknown,
  _label: string,
): number | undefined | "invalid" {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return "invalid";
  }
  return value;
}

function readOptionalPositiveInt(
  value: unknown,
  _label: string,
): number | undefined | "invalid" {
  // Match agent-core occurrence semantics: 0 / null / "" mean omit.
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && value === 0) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return "invalid";
  }
  return value;
}

function mapEngineMutationResult(
  response: DocxMutationBindingResult,
  operationType: string,
): OperationResult {
  const diagnostics = response.result.diagnostics.map(mapDiagnostic);
  const firstError = diagnostics.find((d) => d.severity === "error");

  if (!response.result.ok) {
    const rawCode = firstError?.code ?? "VALIDATION_FAILED";
    const code = normalizeFailureCode(rawCode);
    return {
      status: "error",
      code,
      diagnostics: ensureNonEmpty(
        diagnostics.map((d) =>
          d.code === rawCode && code !== rawCode ? { ...d, code } : d,
        ),
        code,
        `Engine mutation failed with status ${response.result.status}`,
      ),
    };
  }

  if (!response.output || response.output.byteLength === 0) {
    return operationError(
      "DOCUMENT_INVALID",
      "Engine reported success but returned no verified output artifact",
    );
  }

  const change = response.result.changes[0];
  const areaDefault =
    operationType === "document.replace_text" ? "text" : "table";
  return {
    status: "success",
    diagnostics,
    change: change
      ? {
          operation: operationType,
          area: change.kind || areaDefault,
          before: change.before,
          after: change.after,
        }
      : {
          operation: operationType,
          area: areaDefault,
          before: "",
          after: "",
        },
    artifactBytes: response.output,
  };
}

function normalizeFailureCode(code: string): OperationFailureCode {
  if (code === "INVALID_ZIP") {
    return "DOCUMENT_INVALID";
  }
  return code as OperationFailureCode;
}

function normalizeDiagnosticCode(diagnostic: Diagnostic): Diagnostic {
  if (diagnostic.code === "INVALID_ZIP") {
    return { ...diagnostic, code: "DOCUMENT_INVALID" };
  }
  return diagnostic;
}

/**
 * Transport-only: copy engine diagnostic fields unchanged.
 * Never derive reasonCode/operation/targetHandle from message.
 */
function mapDiagnostic(diagnostic: DocxEngineDiagnostic): Diagnostic {
  return {
    code: diagnostic.code,
    severity: normalizeSeverity(diagnostic.severity),
    message: diagnostic.message,
    ...(diagnostic.reasonCode !== undefined
      ? { reasonCode: diagnostic.reasonCode }
      : {}),
    ...(diagnostic.operation !== undefined
      ? { operation: diagnostic.operation }
      : {}),
    ...(diagnostic.targetHandle !== undefined
      ? { targetHandle: diagnostic.targetHandle }
      : {}),
  };
}

function normalizeSeverity(value: string): DiagnosticSeverity {
  if (value === "warning" || value === "info" || value === "error") {
    return value;
  }
  return "error";
}

function ensureNonEmpty(
  diagnostics: readonly Diagnostic[],
  code: string,
  message: string,
): NonEmptyDiagnostics {
  if (diagnostics.length > 0) {
    return diagnostics as NonEmptyDiagnostics;
  }
  return [{ code, severity: "error", message }];
}

function operationError(
  code: OperationFailureCode,
  message: string,
  details?: Record<string, unknown>,
): OperationResult {
  return {
    status: "error",
    code,
    diagnostics: [
      {
        code,
        severity: "error",
        message,
        ...(details ? { details } : {}),
      },
    ],
  };
}

function inspectionError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): InspectionResult {
  return {
    status: "error",
    diagnostics: [
      {
        code,
        severity: "error",
        message,
        ...(details ? { details } : {}),
      },
    ],
  };
}

function findError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): FindResult {
  return {
    status: "error",
    diagnostics: [
      {
        code,
        severity: "error",
        message,
        ...(details ? { details } : {}),
      },
    ],
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const error = new Error("DocumentRuntime operation aborted");
    error.name = "AbortError";
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readNonEmptyString(value: unknown): string | null {
  const text = readString(value);
  if (text === null || text.length === 0) return null;
  return text;
}

function clampMaxResults(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 20;
  }
  return Math.max(1, Math.min(50, Math.floor(value)));
}

function buildExcerpt(before: string, text: string, after: string): string {
  const combined = `${before}${text}${after}`.trim();
  return combined.length > 160 ? `${combined.slice(0, 157)}...` : combined;
}

/** Test helper: assert no engine/source identity keys on a result. */
export function assertNoEngineSourceIdentities(value: unknown): void {
  const forbidden = [
    "nodeId",
    "NodeId",
    "sourceSpan",
    "SourceSpan",
    "partName",
    "relationshipId",
    "xmlPath",
    "byteOffset",
  ];
  const seen = JSON.stringify(value);
  for (const key of forbidden) {
    if (seen.includes(`"${key}"`)) {
      throw new Error(`Engine/source identity leaked via key ${key}`);
    }
  }
}

/** Exported for tests that need to assert focus typing stays narrow. */
export type { DocumentInspectFocus, DocumentRef };
