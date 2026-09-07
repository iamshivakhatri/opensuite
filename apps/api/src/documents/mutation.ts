import type {
  Diagnostic,
  DocumentChangeSummary,
  DocumentRuntime,
  NonEmptyDiagnostics,
  OperationFailureCode,
  OperationResult,
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
