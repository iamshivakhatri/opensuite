import type {
  DocumentMutationExecutor,
  DocumentMutationExecutionResult,
  DocumentMutationResult,
  DocumentRuntime,
} from "@opensuite/agent-core";

import {
  createDocumentMutationService,
  type DocumentMutationService,
  type ApplyDocumentMutationResult,
  type FormattingMutationSession,
} from "../documents/mutation.js";
import type { DocumentService } from "../documents/service.js";

/**
 * Adapts DocumentMutationService apply* methods to agent-core's
 * DocumentMutationExecutor. One tool call → one engine execute → one append.
 */
export function createAgentDocumentMutationExecutor(input: {
  readonly documents: Pick<
    DocumentService,
    "getOwnedDocument" | "appendDocumentVersion"
  >;
  readonly ownerUserId: string;
  readonly runtime: DocumentRuntime;
  readonly mutations?: DocumentMutationService;
}): DocumentMutationExecutor {
  const mutations =
    input.mutations ?? createDocumentMutationService(input.documents);
  let formattingSession: FormattingMutationSession | undefined;
  let formattingDocumentId: string | undefined;

  async function applyFormatting(
    document: { documentId: string; versionId: string },
    type: string,
    payload: Record<string, unknown>,
  ): Promise<DocumentMutationExecutionResult> {
    if (!formattingSession) {
      const created = await mutations.createFormattingSession({
        documentId: document.documentId, ownerUserId: input.ownerUserId,
        baseVersionId: document.versionId, runtime: input.runtime,
      });
      if (!("apply" in created)) return toExecutorResult(created, document.versionId);
      formattingSession = created;
      formattingDocumentId = document.documentId;
    }
    if (formattingDocumentId !== document.documentId) {
      return { status: "error", code: "VERSION_CONFLICT", diagnostics: [{ code: "VERSION_CONFLICT", severity: "error", message: "Formatting session belongs to another document" }] };
    }
    const result = await formattingSession.apply({ type, payload });
    if (result.status === "error") {
      return { status: "error", code: result.code, diagnostics: result.diagnostics };
    }
    return { status: "pending", operation: result.operation, diagnostics: result.diagnostics, ...(result.change ? { change: result.change } : {}) };
  }

  function toExecutorResult(
    applied: ApplyDocumentMutationResult,
    baseVersionId: string,
  ): DocumentMutationResult {
    if (applied.status === "error") {
      return {
        status: "error",
        code: applied.code,
        diagnostics: applied.diagnostics,
      };
    }

    return {
      status: "success",
      document: {
        documentId: applied.document.id,
        versionId: applied.version.id,
        format: "docx",
      },
      versionNumber: applied.version.versionNumber,
      baseVersionId,
      ...(applied.change !== undefined ? { change: applied.change } : {}),
      diagnostics: applied.diagnostics,
    };
  }

  return {
    async mutate(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applyOperation({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        type: request.type,
        payload: request.payload,
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },
    async replaceText(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applyReplaceText({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        find: request.find,
        replace: request.replace,
        ...(request.expectedCurrentText !== undefined
          ? { expectedCurrentText: request.expectedCurrentText }
          : {}),
        ...(request.occurrence !== undefined
          ? { occurrence: request.occurrence }
          : {}),
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },

    async insertParagraph(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applyInsertParagraph({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        text: request.text,
        placement: request.placement,
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },

    async insertParagraphs(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applyInsertParagraphs({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        texts: request.texts,
        placement: request.placement,
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },

    async deleteParagraph(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applyDeleteParagraph({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        target: request.target,
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },

    async setParagraphStyle(request): Promise<DocumentMutationExecutionResult> {
      return applyFormatting(request.document, "document.set_paragraph_style", {
        target: request.target, ...(request.style !== undefined ? { style: request.style } : {}),
      });
    },

    async setParagraphFormatting(request): Promise<DocumentMutationExecutionResult> {
      return applyFormatting(request.document, "document.set_paragraph_formatting", {
        target: request.target,
        ...(request.alignment !== undefined
          ? { alignment: request.alignment }
          : {}),
        ...(request.spacingBeforeTwips !== undefined
          ? { spacingBeforeTwips: request.spacingBeforeTwips }
          : {}),
        ...(request.spacingAfterTwips !== undefined
          ? { spacingAfterTwips: request.spacingAfterTwips }
          : {}),
      });
    },

    async setTextFormatting(request): Promise<DocumentMutationExecutionResult> {
      return applyFormatting(request.document, "document.set_text_formatting", {
        target: request.target,
        ...(request.bold !== undefined ? { bold: request.bold } : {}),
        ...(request.italic !== undefined ? { italic: request.italic } : {}),
        ...(request.fontSizeHalfPoints !== undefined
          ? { fontSizeHalfPoints: request.fontSizeHalfPoints }
          : {}),
        ...(request.fontFamily !== undefined
          ? { fontFamily: request.fontFamily }
          : {}),
        ...(request.color !== undefined ? { color: request.color } : {}),
        ...(request.underline !== undefined ? { underline: request.underline } : {}),
        ...(request.highlight !== undefined ? { highlight: request.highlight } : {}),
        ...(request.strikethrough !== undefined ? { strikethrough: request.strikethrough } : {}),
        ...(request.verticalAlignment !== undefined ? { verticalAlignment: request.verticalAlignment } : {}),
      });
    },

    async setTableCellsText(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applySetTableCellsText({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        table: request.table,
        updates: request.updates,
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },

    async insertTableRows(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applyInsertTableRows({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        table: request.table,
        after: request.after,
        rows: request.rows,
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },

    async insertTableColumn(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applyInsertTableColumn({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        table: request.table,
        ...(request.afterColumnHeader !== undefined
          ? { afterColumnHeader: request.afterColumnHeader }
          : {}),
        ...(request.afterColumnHandle !== undefined
          ? { afterColumnHandle: request.afterColumnHandle }
          : {}),
        header: request.header,
        cells: request.cells,
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },

    async createTable(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applyCreateTable({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        rows: request.rows,
        placement: request.placement,
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },

    async deleteTable(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applyDeleteTable({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        table: request.table,
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },

    async deleteTableRow(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applyDeleteTableRow({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        table: request.table,
        row: request.row,
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },

    async deleteTableColumn(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applyDeleteTableColumn({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        table: request.table,
        ...(request.columnHeader !== undefined
          ? { columnHeader: request.columnHeader }
          : {}),
        ...(request.columnHandle !== undefined
          ? { columnHandle: request.columnHandle }
          : {}),
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },

    async setTableFormatting(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applySetTableFormatting({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        table: request.table,
        ...(request.alignment !== undefined
          ? { alignment: request.alignment }
          : {}),
        ...(request.borders !== undefined ? { borders: request.borders } : {}),
        ...(request.cellMarginTopTwips !== undefined
          ? { cellMarginTopTwips: request.cellMarginTopTwips }
          : {}),
        ...(request.cellMarginRightTwips !== undefined
          ? { cellMarginRightTwips: request.cellMarginRightTwips }
          : {}),
        ...(request.cellMarginBottomTwips !== undefined
          ? { cellMarginBottomTwips: request.cellMarginBottomTwips }
          : {}),
        ...(request.cellMarginLeftTwips !== undefined
          ? { cellMarginLeftTwips: request.cellMarginLeftTwips }
          : {}),
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },
  };
}
