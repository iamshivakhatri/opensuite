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
  DocxEngineBinding,
  DocxEngineDiagnostic,
  DocxInsertTableColumnOperation,
  DocxInsertTableRowsOperation,
  DocxInspectAffordance,
  DocxInspectFocus,
  DocxInspectResult,
  DocxMutationBindingResult,
  DocxReplaceTextOperation,
  DocxRuntimeCapabilities,
  DocxSetTableCellsTextOperation,
  DocxTableCellTarget,
  DocxTableRowAnchor,
  DocxTableTarget,
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
  "document.set_table_cells_text",
  "document.insert_table_rows",
  "document.insert_table_column",
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

      const mapped = mapInsertTableColumnOperation(operation);
      if (!mapped.ok) {
        return mapped.error;
      }
      const engineResponse = await binding.executeDocxInsertTableColumn(
        inputBytes,
        mapped.operation,
      );
      return mapEngineMutationResult(engineResponse, operation.type);
    },
  };
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
    rustIds.includes("set_table_cells_text") ||
    rustIds.includes("insert_table_rows") ||
    rustIds.includes("insert_table_column") ||
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
