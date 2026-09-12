import type {
  Diagnostic,
  DocumentChangeSummary,
  DocumentRuntime,
  NonEmptyDiagnostics,
  OperationFailureCode,
  OperationResult,
  DocumentOperation,
} from "@opensuite/agent-core";

import {
  DocumentAccessError,
  DocumentUploadError,
  type AppendedDocumentDto,
  type DocumentService,
  type DocumentVersionDto,
  type ListedDocumentDto,
} from "./service.js";

export type DocumentMutationFailureCode =
  | OperationFailureCode
  | "DOCUMENT_NOT_FOUND"
  | "VERSION_CONFLICT"
  | "STORAGE_OBJECT_MISSING"
  | "UNSUPPORTED_FORMAT"
  | "EMPTY_UPLOAD"
  | "UPLOAD_TOO_LARGE"
  | "MISSING_BASE_VERSION"
  | "RUNTIME_MISSING_ARTIFACT";

export type ApplyDocumentMutationResult =
  | {
      readonly status: "success";
      readonly document: ListedDocumentDto;
      readonly version: DocumentVersionDto;
      readonly change?: DocumentChangeSummary;
      readonly diagnostics: readonly Diagnostic[];
    }
  | {
      readonly status: "error";
      readonly code: DocumentMutationFailureCode;
      readonly diagnostics: NonEmptyDiagnostics;
      /** Present for application access/conflict failures. */
      readonly statusCode?: number;
    };

/** @deprecated Prefer ApplyDocumentMutationResult */
export type ApplyReplaceTextResult = ApplyDocumentMutationResult;

export interface ApplyReplaceTextInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly find: string;
  readonly replace: string;
  readonly expectedCurrentText?: string;
  readonly occurrence?: number;
  /**
   * DocumentRuntime that already resolves artifacts for this owner
   * (typically OpenSuiteEngineAdapter + createOwnedDocumentArtifactLoader).
   */
  readonly runtime: DocumentRuntime;
}

export interface DocumentTableTargetInput {
  readonly headerCells?: readonly string[];
  readonly occurrence?: number;
  readonly handle?: string;
}

export interface DocumentTableRowAnchorInput {
  readonly firstCellText?: string;
  readonly occurrence?: number;
  readonly handle?: string;
}

export interface DocumentTableCellUpdateInput {
  readonly target: {
    readonly handle?: string;
    readonly rowLabel?: string;
    readonly columnHeader?: string;
    readonly occurrence?: number;
  };
  readonly expectedCurrentText: string;
  readonly replacement: string;
}

export interface ApplySetTableCellsTextInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly table: DocumentTableTargetInput;
  readonly updates: readonly DocumentTableCellUpdateInput[];
  readonly runtime: DocumentRuntime;
}

export interface ApplyInsertTableRowsInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly table: DocumentTableTargetInput;
  readonly after: DocumentTableRowAnchorInput;
  readonly rows: readonly (readonly string[])[];
  readonly runtime: DocumentRuntime;
}

export interface ApplyInsertTableColumnInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly table: DocumentTableTargetInput;
  readonly afterColumnHeader?: string;
  readonly afterColumnHandle?: string;
  readonly header: string;
  readonly cells: readonly string[];
  readonly runtime: DocumentRuntime;
}

export type DocumentBodyPlacementInput =
  | { readonly kind: "start" }
  | { readonly kind: "end" }
  | { readonly kind: "before"; readonly handle: string }
  | { readonly kind: "after"; readonly handle: string };

export interface ApplyCreateTableInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly rows: readonly (readonly string[])[];
  readonly placement: DocumentBodyPlacementInput;
  readonly runtime: DocumentRuntime;
}

export interface ApplyDeleteTableInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly table: DocumentTableTargetInput;
  readonly runtime: DocumentRuntime;
}

export interface ApplyDeleteTableRowInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly table: DocumentTableTargetInput;
  readonly row: DocumentTableRowAnchorInput;
  readonly runtime: DocumentRuntime;
}

export interface ApplyDeleteTableColumnInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly table: DocumentTableTargetInput;
  readonly columnHeader?: string;
  readonly columnHandle?: string;
  readonly runtime: DocumentRuntime;
}

export interface ApplySetTableFormattingInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly table: DocumentTableTargetInput;
  readonly alignment?: "left" | "center" | "right" | "clear";
  readonly cellMarginTopTwips?: number;
  readonly cellMarginRightTwips?: number;
  readonly cellMarginBottomTwips?: number;
  readonly cellMarginLeftTwips?: number;
  readonly borders?: "grid" | "none" | "clear";
  readonly runtime: DocumentRuntime;
}

export interface ApplyInsertParagraphInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly text: string;
  readonly placement:
    | { readonly kind: "start" }
    | { readonly kind: "end" }
    | { readonly kind: "before"; readonly handle: string }
    | { readonly kind: "after"; readonly handle: string };
  readonly runtime: DocumentRuntime;
}

export interface ApplyInsertParagraphsInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly texts: readonly string[];
  readonly placement:
    | { readonly kind: "start" }
    | { readonly kind: "end" }
    | { readonly kind: "before"; readonly handle: string }
    | { readonly kind: "after"; readonly handle: string };
  readonly runtime: DocumentRuntime;
}

export interface DocumentTextTargetInput {
  readonly text: string;
  readonly occurrence?: number;
}

export interface ApplyDeleteParagraphInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly target: DocumentTextTargetInput;
  readonly runtime: DocumentRuntime;
}

export interface ApplySetParagraphStyleInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly target: DocumentTextTargetInput;
  readonly style?: string;
  readonly runtime: DocumentRuntime;
}

export interface ApplySetParagraphFormattingInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly target: DocumentTextTargetInput;
  readonly alignment?: "left" | "center" | "right";
  readonly spacingBeforeTwips?: number;
  readonly spacingAfterTwips?: number;
  readonly runtime: DocumentRuntime;
}

export interface ApplySetTextFormattingInput {
  readonly documentId: string;
  readonly ownerUserId: string;
  readonly baseVersionId: string;
  readonly target: DocumentTextTargetInput;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly fontSizeHalfPoints?: number;
  readonly fontFamily?: string;
  readonly color?: string;
  readonly underline?: boolean;
  readonly highlight?: string;
  readonly strikethrough?: boolean;
  readonly verticalAlignment?: "baseline" | "superscript" | "subscript";
  readonly runtime: DocumentRuntime;
}

export interface DocumentMutationServiceOptions {
  /**
   * Optional hook between successful runtime execute and version append.
   * Used by tests to simulate concurrent writers; not for production.
   */
  readonly beforePersist?: (context: {
    readonly documentId: string;
    readonly baseVersionId: string;
    readonly artifactBytes: Uint8Array;
  }) => Promise<void>;
}

const FORMATTING_OPERATION_TYPES = new Set([
  "document.set_paragraph_style",
  "document.set_paragraph_formatting",
  "document.set_text_formatting",
]);

export type FormattingMutationPendingResult =
  | { readonly status: "pending"; readonly operation: string; readonly change?: DocumentChangeSummary; readonly diagnostics: readonly Diagnostic[] }
  | { readonly status: "error"; readonly operation: string; readonly code: string; readonly diagnostics: NonEmptyDiagnostics };

export interface FormattingMutationSession {
  apply(operation: Omit<DocumentOperation, "baseVersionId">): Promise<FormattingMutationPendingResult>;
  flush(): Promise<
    | { readonly status: "success"; readonly document: ListedDocumentDto; readonly version: DocumentVersionDto; readonly pending: readonly FormattingMutationPendingResult[] }
    | { readonly status: "noop"; readonly pending: readonly FormattingMutationPendingResult[] }
    | { readonly status: "error"; readonly code: string; readonly diagnostics: NonEmptyDiagnostics; readonly pending: readonly FormattingMutationPendingResult[] }
  >;
  abandon(): void;
}

/**
 * Application-owned mutation lifecycle:
 *   exact version N → DocumentRuntime → verified bytes → immutable version N+1
 *
 * Persistence uses DocumentService.appendDocumentVersion (row lock + base
 * version compare). The engine adapter never writes DB/storage.
 */
export function createDocumentMutationService(
  documents: Pick<
    DocumentService,
    "getOwnedDocument" | "appendDocumentVersion"
  >,
  options: DocumentMutationServiceOptions = {},
) {
  async function authorizeAndPersist(input: {
    readonly documentId: string;
    readonly ownerUserId: string;
    readonly baseVersionId: string;
    readonly runtime: DocumentRuntime;
    readonly operationType: string;
    readonly payload: Record<string, unknown>;
    readonly formatErrorLabel: string;
  }): Promise<ApplyDocumentMutationResult> {
    let owned: ListedDocumentDto;
    try {
      owned = await documents.getOwnedDocument({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
      });
    } catch (error) {
      return mapAccessError(error);
    }

    if (owned.format !== "docx") {
      return {
        status: "error",
        code: "UNSUPPORTED_FORMAT",
        statusCode: 400,
        diagnostics: [
          {
            code: "UNSUPPORTED_FORMAT",
            severity: "error",
            message: `${input.formatErrorLabel} only supports DOCX (got ${owned.format})`,
            details: { format: owned.format },
          },
        ],
      };
    }

    if (owned.latestVersion.id !== input.baseVersionId) {
      return {
        status: "error",
        code: "VERSION_CONFLICT",
        statusCode: 409,
        diagnostics: [
          {
            code: "VERSION_CONFLICT",
            severity: "error",
            message:
              "Document was updated; reload the latest version before mutating",
            details: {
              baseVersionId: input.baseVersionId,
              latestVersionId: owned.latestVersion.id,
            },
          },
        ],
      };
    }

    if (!input.runtime.execute) {
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

    const documentRef = {
      documentId: input.documentId,
      versionId: input.baseVersionId,
      format: "docx" as const,
    };

    let runtimeResult: OperationResult;
    try {
      runtimeResult = await input.runtime.execute(documentRef, {
        type: input.operationType,
        baseVersionId: input.baseVersionId,
        payload: input.payload,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "DocumentRuntime execute failed";
      return {
        status: "error",
        code: "VALIDATION_FAILED",
        diagnostics: [
          {
            code: "VALIDATION_FAILED",
            severity: "error",
            message,
          },
        ],
      };
    }

    if (runtimeResult.status === "error") {
      return {
        status: "error",
        code: runtimeResult.code,
        diagnostics: runtimeResult.diagnostics,
      };
    }

    if (
      !runtimeResult.artifactBytes ||
      runtimeResult.artifactBytes.byteLength === 0
    ) {
      return {
        status: "error",
        code: "RUNTIME_MISSING_ARTIFACT",
        diagnostics: [
          {
            code: "RUNTIME_MISSING_ARTIFACT",
            severity: "error",
            message:
              "Runtime reported success without verified artifact bytes; nothing was persisted",
          },
        ],
      };
    }

    if (options.beforePersist) {
      await options.beforePersist({
        documentId: input.documentId,
        baseVersionId: input.baseVersionId,
        artifactBytes: runtimeResult.artifactBytes,
      });
    }

    let appended: AppendedDocumentDto;
    try {
      appended = await documents.appendDocumentVersion({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        source: "agent",
        bytes: Buffer.from(runtimeResult.artifactBytes),
      });
    } catch (error) {
      return mapAccessError(error);
    }

    return {
      status: "success",
      document: appended.document,
      version: appended.version,
      change: runtimeResult.change,
      diagnostics: runtimeResult.diagnostics,
    };
  }

  return {
    async createFormattingSession(input: {
      readonly documentId: string;
      readonly ownerUserId: string;
      readonly baseVersionId: string;
      readonly runtime: DocumentRuntime;
    }): Promise<FormattingMutationSession | ApplyDocumentMutationResult> {
      let owned: ListedDocumentDto;
      try {
        owned = await documents.getOwnedDocument({
          documentId: input.documentId,
          ownerUserId: input.ownerUserId,
        });
      } catch (error) {
        return mapAccessError(error);
      }
      if (owned.format !== "docx" || owned.latestVersion.id !== input.baseVersionId) {
        return {
          status: "error",
          code: owned.format !== "docx" ? "UNSUPPORTED_FORMAT" : "VERSION_CONFLICT",
          diagnostics: [{ code: owned.format !== "docx" ? "UNSUPPORTED_FORMAT" : "VERSION_CONFLICT", severity: "error", message: "Document is not the requested current DOCX version" }],
        };
      }
      if (!input.runtime.loadBytes || !input.runtime.executeWithBytes) {
        return { status: "error", code: "UNSUPPORTED_CAPABILITY", diagnostics: [{ code: "UNSUPPORTED_CAPABILITY", severity: "error", message: "Document runtime does not support formatting sessions" }] };
      }
      let workingBytes: Uint8Array;
      try {
        workingBytes = await input.runtime.loadBytes({ documentId: input.documentId, versionId: input.baseVersionId, format: "docx" });
      } catch (error) {
        return { status: "error", code: "STORAGE_OBJECT_MISSING", diagnostics: [{ code: "STORAGE_OBJECT_MISSING", severity: "error", message: error instanceof Error ? error.message : "Could not load document bytes" }] };
      }
      const pending: FormattingMutationPendingResult[] = [];
      let state: "active" | "flushed" | "abandoned" = "active";
      const document = { documentId: input.documentId, versionId: input.baseVersionId, format: "docx" as const };
      return {
        async apply(operation) {
          if (state !== "active") {
            throw new Error(`Formatting session is ${state}`);
          }
          if (!FORMATTING_OPERATION_TYPES.has(operation.type)) {
            throw new Error(`Formatting session does not support ${operation.type}`);
          }
          const result = await input.runtime.executeWithBytes!(
            document,
            { ...operation, baseVersionId: input.baseVersionId },
            workingBytes,
          );
          if (result.status === "error") {
            const failed: FormattingMutationPendingResult = { status: "error", operation: operation.type, code: result.code, diagnostics: result.diagnostics };
            pending.push(failed);
            return failed;
          }
          if (!result.artifactBytes || result.artifactBytes.byteLength === 0) {
            const failed: FormattingMutationPendingResult = { status: "error", operation: operation.type, code: "RUNTIME_MISSING_ARTIFACT", diagnostics: [{ code: "RUNTIME_MISSING_ARTIFACT", severity: "error", message: "Formatting mutation returned no verified bytes" }] };
            pending.push(failed);
            return failed;
          }
          workingBytes = result.artifactBytes;
          const succeeded: FormattingMutationPendingResult = { status: "pending", operation: operation.type, ...(result.change ? { change: result.change } : {}), diagnostics: result.diagnostics };
          pending.push(succeeded);
          return succeeded;
        },
        async flush() {
          if (state === "abandoned") throw new Error("Formatting session is abandoned");
          if (state === "flushed") throw new Error("Formatting session is already flushed");
          const successful = pending.some((result) => result.status === "pending");
          if (!successful) { state = "flushed"; return { status: "noop" as const, pending }; }
          try {
            const appended = await documents.appendDocumentVersion({ documentId: input.documentId, ownerUserId: input.ownerUserId, baseVersionId: input.baseVersionId, source: "agent", bytes: Buffer.from(workingBytes) });
            state = "flushed";
            return { status: "success" as const, document: appended.document, version: appended.version, pending };
          } catch (error) {
            state = "flushed";
            const failure = mapAccessError(error);
            if (failure.status === "error") {
              return { status: "error" as const, code: failure.code, diagnostics: failure.diagnostics, pending };
            }
            return { status: "error" as const, code: "VALIDATION_FAILED", diagnostics: [{ code: "VALIDATION_FAILED", severity: "error", message: "Could not persist formatting session" }] as NonEmptyDiagnostics, pending };
          }
        },
        abandon() { if (state === "active") state = "abandoned"; },
      };
    },
    async applyOperation(input: {
      readonly documentId: string;
      readonly ownerUserId: string;
      readonly baseVersionId: string;
      readonly runtime: DocumentRuntime;
      readonly type: string;
      readonly payload: Record<string, unknown>;
    }): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: input.type,
        payload: input.payload,
        formatErrorLabel: input.type,
      });
    },
    async applyReplaceText(
      input: ApplyReplaceTextInput,
    ): Promise<ApplyDocumentMutationResult> {
      const payload: Record<string, unknown> = {
        find: input.find,
        replace: input.replace,
      };
      if (input.expectedCurrentText !== undefined) {
        payload.expectedCurrentText = input.expectedCurrentText;
      }
      if (input.occurrence !== undefined) {
        payload.occurrence = input.occurrence;
      }

      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.replace_text",
        payload,
        formatErrorLabel: "applyReplaceText",
      });
    },

    async applyInsertParagraph(
      input: ApplyInsertParagraphInput,
    ): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.insert_paragraph",
        payload: {
          text: input.text,
          placement: input.placement,
        },
        formatErrorLabel: "applyInsertParagraph",
      });
    },

    async applyInsertParagraphs(
      input: ApplyInsertParagraphsInput,
    ): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.insert_paragraphs",
        payload: {
          texts: input.texts,
          placement: input.placement,
        },
        formatErrorLabel: "applyInsertParagraphs",
      });
    },

    async applyDeleteParagraph(
      input: ApplyDeleteParagraphInput,
    ): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.delete_paragraph",
        payload: { target: input.target },
        formatErrorLabel: "applyDeleteParagraph",
      });
    },

    async applySetParagraphStyle(
      input: ApplySetParagraphStyleInput,
    ): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.set_paragraph_style",
        payload: {
          target: input.target,
          ...(input.style !== undefined ? { style: input.style } : {}),
        },
        formatErrorLabel: "applySetParagraphStyle",
      });
    },

    async applySetParagraphFormatting(
      input: ApplySetParagraphFormattingInput,
    ): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.set_paragraph_formatting",
        payload: {
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
        formatErrorLabel: "applySetParagraphFormatting",
      });
    },

    async applySetTextFormatting(
      input: ApplySetTextFormattingInput,
    ): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.set_text_formatting",
        payload: {
          target: input.target,
          ...(input.bold !== undefined ? { bold: input.bold } : {}),
          ...(input.italic !== undefined ? { italic: input.italic } : {}),
          ...(input.fontSizeHalfPoints !== undefined
            ? { fontSizeHalfPoints: input.fontSizeHalfPoints }
            : {}),
          ...(input.fontFamily !== undefined
            ? { fontFamily: input.fontFamily }
            : {}),
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.underline !== undefined ? { underline: input.underline } : {}),
          ...(input.highlight !== undefined ? { highlight: input.highlight } : {}),
          ...(input.strikethrough !== undefined ? { strikethrough: input.strikethrough } : {}),
          ...(input.verticalAlignment !== undefined ? { verticalAlignment: input.verticalAlignment } : {}),
        },
        formatErrorLabel: "applySetTextFormatting",
      });
    },

    async applySetTableCellsText(
      input: ApplySetTableCellsTextInput,
    ): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.set_table_cells_text",
        payload: {
          table: input.table,
          updates: input.updates,
        },
        formatErrorLabel: "applySetTableCellsText",
      });
    },

    async applyInsertTableRows(
      input: ApplyInsertTableRowsInput,
    ): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.insert_table_rows",
        payload: {
          table: input.table,
          after: input.after,
          rows: input.rows,
        },
        formatErrorLabel: "applyInsertTableRows",
      });
    },

    async applyInsertTableColumn(
      input: ApplyInsertTableColumnInput,
    ): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.insert_table_column",
        payload: {
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
        formatErrorLabel: "applyInsertTableColumn",
      });
    },

    async applyCreateTable(
      input: ApplyCreateTableInput,
    ): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.create_table",
        payload: {
          rows: input.rows,
          placement: input.placement,
        },
        formatErrorLabel: "applyCreateTable",
      });
    },

    async applyDeleteTable(
      input: ApplyDeleteTableInput,
    ): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.delete_table",
        payload: { table: input.table },
        formatErrorLabel: "applyDeleteTable",
      });
    },

    async applyDeleteTableRow(
      input: ApplyDeleteTableRowInput,
    ): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.delete_table_row",
        payload: {
          table: input.table,
          row: input.row,
        },
        formatErrorLabel: "applyDeleteTableRow",
      });
    },

    async applyDeleteTableColumn(
      input: ApplyDeleteTableColumnInput,
    ): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.delete_table_column",
        payload: {
          table: input.table,
          ...(input.columnHeader !== undefined
            ? { columnHeader: input.columnHeader }
            : {}),
          ...(input.columnHandle !== undefined
            ? { columnHandle: input.columnHandle }
            : {}),
        },
        formatErrorLabel: "applyDeleteTableColumn",
      });
    },

    async applySetTableFormatting(
      input: ApplySetTableFormattingInput,
    ): Promise<ApplyDocumentMutationResult> {
      return authorizeAndPersist({
        documentId: input.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: input.baseVersionId,
        runtime: input.runtime,
        operationType: "document.set_table_formatting",
        payload: {
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
        },
        formatErrorLabel: "applySetTableFormatting",
      });
    },
  };
}

export type DocumentMutationService = ReturnType<
  typeof createDocumentMutationService
>;

function mapAccessError(error: unknown): ApplyDocumentMutationResult {
  if (error instanceof DocumentAccessError) {
    return {
      status: "error",
      code: error.code,
      statusCode: error.statusCode,
      diagnostics: [
        {
          code: error.code,
          severity: "error",
          message: error.message,
        },
      ],
    };
  }

  if (error instanceof DocumentUploadError) {
    return {
      status: "error",
      code: error.code,
      statusCode: error.statusCode,
      diagnostics: [
        {
          code: error.code,
          severity: "error",
          message: error.message,
        },
      ],
    };
  }

  throw error;
}
