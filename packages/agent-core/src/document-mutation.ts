import type { DocumentChangeSummary, DocumentRuntime } from "./runtime.js";
import type {
  Diagnostic,
  DocumentRef,
  NonEmptyDiagnostics,
} from "./types.js";

/**
 * Application-injected mutation boundary.
 *
 * Agent-core never persists versions itself. apps/api implements this by
 * calling createDocumentMutationService apply* methods (engine once +
 * appendDocumentVersion). Success means an immutable version was written.
 */

/**
 * Table selector: semantic header cells and/or opaque table handle from inspect.
 * Prefer handle when targeting one of several identical tables.
 */
export interface DocumentTableTarget {
  readonly headerCells?: readonly string[];
  readonly occurrence?: number;
  /** Opaque artifact-local table handle from document.inspect(tables). */
  readonly handle?: string;
}

/**
 * Row insertion anchor: semantic first-cell text and/or opaque row handle.
 */
export interface DocumentTableRowAnchor {
  readonly firstCellText?: string;
  readonly occurrence?: number;
  /** Opaque artifact-local row handle from document.inspect(tables). */
  readonly handle?: string;
}

/** Semantic cell selector (row label × column header). */
export interface DocumentTableCellSemanticTarget {
  readonly rowLabel: string;
  readonly columnHeader: string;
  readonly occurrence?: number;
}

/** Opaque cell handle from document.inspect(tables). */
export interface DocumentTableCellHandleTarget {
  readonly handle: string;
}

export type DocumentTableCellTarget =
  | DocumentTableCellHandleTarget
  | DocumentTableCellSemanticTarget;

export interface DocumentTableCellUpdate {
  readonly target: DocumentTableCellTarget;
  readonly expectedCurrentText: string;
  readonly replacement: string;
}

export interface DocumentReplaceTextMutationRequest {
  readonly document: DocumentRef;
  readonly find: string;
  readonly replace: string;
  readonly expectedCurrentText?: string;
  readonly occurrence?: number;
  readonly signal?: AbortSignal;
  readonly runId?: string;
}

export interface DocumentSetTableCellsTextMutationRequest {
  readonly document: DocumentRef;
  readonly table: DocumentTableTarget;
  readonly updates: readonly DocumentTableCellUpdate[];
  readonly signal?: AbortSignal;
  readonly runId?: string;
}

export interface DocumentInsertTableRowsMutationRequest {
  readonly document: DocumentRef;
  readonly table: DocumentTableTarget;
  readonly after: DocumentTableRowAnchor;
  readonly rows: readonly (readonly string[])[];
  readonly signal?: AbortSignal;
  readonly runId?: string;
}

export interface DocumentInsertTableColumnMutationRequest {
  readonly document: DocumentRef;
  readonly table: DocumentTableTarget;
  /** Semantic column header to insert after (when not using afterColumnHandle). */
  readonly afterColumnHeader?: string;
  /** Opaque column handle from inspect(tables) — preferred for blank/duplicate headers. */
  readonly afterColumnHandle?: string;
  readonly header: string;
  readonly cells: readonly string[];
  readonly signal?: AbortSignal;
  readonly runId?: string;
}

/** Placement for document.insert_paragraph (engine protocol). */
export type DocumentParagraphPlacement =
  | { readonly kind: "start" }
  | { readonly kind: "end" }
  | { readonly kind: "before"; readonly handle: string }
  | { readonly kind: "after"; readonly handle: string };

export interface DocumentInsertParagraphMutationRequest {
  readonly document: DocumentRef;
  readonly text: string;
  readonly placement: DocumentParagraphPlacement;
  readonly signal?: AbortSignal;
  readonly runId?: string;
}

export interface DocumentInsertParagraphsMutationRequest {
  readonly document: DocumentRef;
  readonly texts: readonly string[];
  readonly placement: DocumentParagraphPlacement;
  readonly signal?: AbortSignal;
  readonly runId?: string;
}

/** Semantic text target for delete / style / formatting mutations. */
export interface DocumentTextTarget {
  readonly text: string;
  readonly occurrence?: number;
}

export interface DocumentDeleteParagraphMutationRequest {
  readonly document: DocumentRef;
  readonly target: DocumentTextTarget;
  readonly signal?: AbortSignal;
  readonly runId?: string;
}

export interface DocumentSetParagraphStyleMutationRequest {
  readonly document: DocumentRef;
  readonly target: DocumentTextTarget;
  /** Omit to clear the paragraph style (engine Clear). */
  readonly style?: string;
  readonly signal?: AbortSignal;
  readonly runId?: string;
}

export type DocumentParagraphAlignment = "left" | "center" | "right";

export interface DocumentSetParagraphFormattingMutationRequest {
  readonly document: DocumentRef;
  readonly target: DocumentTextTarget;
  readonly alignment?: DocumentParagraphAlignment;
  readonly spacingBeforeTwips?: number;
  readonly spacingAfterTwips?: number;
  readonly signal?: AbortSignal;
  readonly runId?: string;
}

export interface DocumentSetTextFormattingMutationRequest {
  readonly document: DocumentRef;
  readonly target: DocumentTextTarget;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly fontSizeHalfPoints?: number;
  readonly fontFamily?: string;
  readonly signal?: AbortSignal;
  readonly runId?: string;
}

export type DocumentMutationResult =
  | {
      readonly status: "success";
      /** Active document identity after persistence (version N+1). */
      readonly document: DocumentRef;
      readonly versionNumber?: number;
      readonly baseVersionId: string;
      readonly change?: DocumentChangeSummary;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly status: "error";
      readonly code: string;
      readonly diagnostics: NonEmptyDiagnostics;
    };

export interface DocumentMutationExecutor {
  replaceText(
    input: DocumentReplaceTextMutationRequest,
  ): Promise<DocumentMutationResult>;
  insertParagraph(
    input: DocumentInsertParagraphMutationRequest,
  ): Promise<DocumentMutationResult>;
  insertParagraphs(
    input: DocumentInsertParagraphsMutationRequest,
  ): Promise<DocumentMutationResult>;
  deleteParagraph(
    input: DocumentDeleteParagraphMutationRequest,
  ): Promise<DocumentMutationResult>;
  setParagraphStyle(
    input: DocumentSetParagraphStyleMutationRequest,
  ): Promise<DocumentMutationResult>;
  setParagraphFormatting(
    input: DocumentSetParagraphFormattingMutationRequest,
  ): Promise<DocumentMutationResult>;
  setTextFormatting(
    input: DocumentSetTextFormattingMutationRequest,
  ): Promise<DocumentMutationResult>;
  setTableCellsText(
    input: DocumentSetTableCellsTextMutationRequest,
  ): Promise<DocumentMutationResult>;
  insertTableRows(
    input: DocumentInsertTableRowsMutationRequest,
  ): Promise<DocumentMutationResult>;
  insertTableColumn(
    input: DocumentInsertTableColumnMutationRequest,
  ): Promise<DocumentMutationResult>;
}

/**
 * Tool output for a successfully persisted document mutation.
 * Does not include artifactBytes — those belong to storage after persist.
 */
export interface PersistedDocumentMutationToolResult {
  readonly status: "success";
  readonly diagnostics: readonly Diagnostic[];
  readonly change?: DocumentChangeSummary;
  readonly document: DocumentRef;
  readonly versionNumber?: number;
  readonly baseVersionId: string;
}

/** @deprecated Prefer PersistedDocumentMutationToolResult */
export type PersistedReplaceTextToolResult = PersistedDocumentMutationToolResult;

export function isPersistedDocumentMutationToolResult(
  value: unknown,
): value is PersistedDocumentMutationToolResult {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.status !== "success") return false;
  if (!record.document || typeof record.document !== "object") return false;
  const doc = record.document as Record<string, unknown>;
  return (
    typeof doc.documentId === "string" &&
    typeof doc.versionId === "string" &&
    typeof doc.format === "string" &&
    typeof record.baseVersionId === "string"
  );
}

/** @deprecated Prefer isPersistedDocumentMutationToolResult */
export const isPersistedReplaceTextToolResult =
  isPersistedDocumentMutationToolResult;

function unsupportedExecute(): DocumentMutationResult {
  return {
    status: "error",
    code: "UNSUPPORTED_CAPABILITY",
    diagnostics: [
      {
        code: "UNSUPPORTED_CAPABILITY",
        severity: "error",
        message: "DocumentRuntime does not support execute/mutate",
      },
    ],
  };
}

/**
 * Test helper: run DocumentRuntime.execute once and synthesize a new version id.
 * Does not touch DB/storage — for agent-core unit tests only.
 */
export function createInMemoryDocumentMutationExecutor(
  runtime: DocumentRuntime,
): DocumentMutationExecutor {
  let sequence = 0;

  async function executeOnce(
    document: DocumentRef,
    type: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    runId?: string,
  ): Promise<DocumentMutationResult> {
    if (!runtime.execute) {
      return unsupportedExecute();
    }
    const result = await runtime.execute(
      document,
      {
        type,
        baseVersionId: document.versionId,
        payload,
      },
      { signal, runId },
    );
    if (result.status === "error") {
      return {
        status: "error",
        code: result.code,
        diagnostics: result.diagnostics,
      };
    }
    sequence += 1;
    const next: DocumentRef = {
      documentId: document.documentId,
      versionId: `${document.versionId}+${sequence}`,
      format: document.format,
    };
    return {
      status: "success",
      document: next,
      versionNumber: sequence + 1,
      baseVersionId: document.versionId,
      ...(result.change !== undefined ? { change: result.change } : {}),
      diagnostics: result.diagnostics,
    };
  }

  return {
    async replaceText(input) {
      return executeOnce(
        input.document,
        "document.replace_text",
        {
          find: input.find,
          replace: input.replace,
          ...(input.expectedCurrentText !== undefined
            ? { expectedCurrentText: input.expectedCurrentText }
            : {}),
          ...(input.occurrence !== undefined
            ? { occurrence: input.occurrence }
            : {}),
        },
        input.signal,
        input.runId,
      );
    },

    async insertParagraph(input) {
      return executeOnce(
        input.document,
        "document.insert_paragraph",
        {
          text: input.text,
          placement: input.placement,
        },
        input.signal,
        input.runId,
      );
    },

    async insertParagraphs(input) {
      return executeOnce(
        input.document,
        "document.insert_paragraphs",
        {
          texts: input.texts,
          placement: input.placement,
        },
        input.signal,
        input.runId,
      );
    },

    async deleteParagraph(input) {
      return executeOnce(
        input.document,
        "document.delete_paragraph",
        { target: input.target },
        input.signal,
        input.runId,
      );
    },

    async setParagraphStyle(input) {
      return executeOnce(
        input.document,
        "document.set_paragraph_style",
        {
          target: input.target,
          ...(input.style !== undefined ? { style: input.style } : {}),
        },
        input.signal,
        input.runId,
      );
    },

    async setParagraphFormatting(input) {
      return executeOnce(
        input.document,
        "document.set_paragraph_formatting",
        {
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
        },
        input.signal,
        input.runId,
      );
    },

    async setTextFormatting(input) {
      return executeOnce(
        input.document,
        "document.set_text_formatting",
        {
          target: input.target,
          ...(input.bold !== undefined ? { bold: input.bold } : {}),
          ...(input.italic !== undefined ? { italic: input.italic } : {}),
          ...(input.fontSizeHalfPoints !== undefined
            ? { fontSizeHalfPoints: input.fontSizeHalfPoints }
            : {}),
          ...(input.fontFamily !== undefined
            ? { fontFamily: input.fontFamily }
            : {}),
        },
        input.signal,
        input.runId,
      );
    },

    async setTableCellsText(input) {
      return executeOnce(
        input.document,
        "document.set_table_cells_text",
        {
          table: input.table,
          updates: input.updates,
        },
        input.signal,
        input.runId,
      );
    },

    async insertTableRows(input) {
      return executeOnce(
        input.document,
        "document.insert_table_rows",
        {
          table: input.table,
          after: input.after,
          rows: input.rows,
        },
        input.signal,
        input.runId,
      );
    },

    async insertTableColumn(input) {
      return executeOnce(
        input.document,
        "document.insert_table_column",
        {
          table: input.table,
          ...(input.afterColumnHeader !== undefined
            ? { afterColumnHeader: input.afterColumnHeader }
            : {}),
          ...(input.afterColumnHandle !== undefined
            ? { afterColumnHandle: input.afterColumnHandle }
            : {}),
          header: input.header,
          cells: input.cells,
        },
        input.signal,
        input.runId,
      );
    },
  };
}
