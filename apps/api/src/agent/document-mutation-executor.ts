import type {
  DocumentMutationExecutor,
  DocumentMutationResult,
  DocumentRuntime,
} from "@opensuite/agent-core";

import {
  createDocumentMutationService,
  type DocumentMutationService,
  type ApplyDocumentMutationResult,
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

    async setParagraphStyle(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applySetParagraphStyle({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        target: request.target,
        ...(request.style !== undefined ? { style: request.style } : {}),
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },

    async setParagraphFormatting(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applySetParagraphFormatting({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
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
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },

    async setTextFormatting(request): Promise<DocumentMutationResult> {
      const applied = await mutations.applySetTextFormatting({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        target: request.target,
        ...(request.bold !== undefined ? { bold: request.bold } : {}),
        ...(request.italic !== undefined ? { italic: request.italic } : {}),
        ...(request.fontSizeHalfPoints !== undefined
          ? { fontSizeHalfPoints: request.fontSizeHalfPoints }
          : {}),
        ...(request.fontFamily !== undefined
          ? { fontFamily: request.fontFamily }
          : {}),
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
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
