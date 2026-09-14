import type {
  DocumentMutationExecutor,
  DocumentMutationExecutionResult,
  DocumentMutationResult,
  DocumentRuntime,
} from "@opensuite/agent-core";
import { FORMATTING_MUTATION_TYPES, WORKING_BYTE_MUTATION_TYPES } from "@opensuite/agent-core";

import {
  createDocumentMutationService,
  type DocumentMutationService,
  type ApplyDocumentMutationResult,
  type WorkingByteMutationSession,
} from "../documents/mutation.js";
import type { DocumentService } from "../documents/service.js";

/**
 * Adapts DocumentMutationService apply* methods to agent-core's
 * DocumentMutationExecutor. Compatible same-turn calls share verified bytes
 * and append once at the lifecycle boundary.
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
  let workingSession: WorkingByteMutationSession | undefined;
  let workingDocumentId: string | undefined;

  async function applyWorkingBytes(
    document: { documentId: string; versionId: string },
    type: string,
    payload: Record<string, unknown>,
  ): Promise<DocumentMutationExecutionResult> {
    if (!workingSession) {
      const created = await mutations.createWorkingByteSession({
        documentId: document.documentId, ownerUserId: input.ownerUserId,
        baseVersionId: document.versionId, runtime: input.runtime,
      });
      if (!("apply" in created)) return toExecutorResult(created, document.versionId);
      workingSession = created;
      workingDocumentId = document.documentId;
    }
    if (workingDocumentId !== document.documentId) {
      return { status: "error", code: "VERSION_CONFLICT", diagnostics: [{ code: "VERSION_CONFLICT", severity: "error", message: "Working-byte session belongs to another document" }] };
    }
    const result = await workingSession.apply({ type, payload });
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
    async flushPendingMutations() {
      if (!workingSession) return { status: "noop" as const };
      const session = workingSession;
      workingSession = undefined;
      workingDocumentId = undefined;
      const flushed = await session.flush();
      if (flushed.status === "noop") return { status: "noop" as const };
      if (flushed.status === "error") {
        return { status: "error" as const, code: flushed.code, diagnostics: flushed.diagnostics };
      }
      return {
        status: "success" as const,
        document: { documentId: flushed.document.id, versionId: flushed.version.id, format: "docx" as const },
        versionNumber: flushed.version.versionNumber,
        baseVersionId: flushed.version.parentVersionId ?? "",
        diagnostics: [],
      };
    },
    abandonPendingMutations() {
      workingSession?.abandon();
      workingSession = undefined;
      workingDocumentId = undefined;
    },
    async preflightMutate(request) {
      if (FORMATTING_MUTATION_TYPES.has(request.type)) {
        return {
          status: "preflight_rejected" as const,
          code: "UNSUPPORTED_OPERATION",
          diagnostics: [
            {
              code: "UNSUPPORTED_OPERATION" as const,
              severity: "error" as const,
              message:
                "Formatting mutations are excluded from Recovery Preflight v1",
            },
          ],
        };
      }
      const applied = await mutations.applyPreflightAndPromote({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        runtime: input.runtime,
        type: request.type,
        payload: request.payload,
      });
      if (applied.status === "preflight_rejected") {
        return {
          status: "preflight_rejected" as const,
          code: applied.code,
          diagnostics: applied.diagnostics,
        };
      }
      return toExecutorResult(applied, request.document.versionId);
    },
    async mutate(request): Promise<DocumentMutationExecutionResult> {
      if (WORKING_BYTE_MUTATION_TYPES.has(request.type)) {
        return applyWorkingBytes(request.document, request.type, request.payload);
      }
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
    async replaceText(request): Promise<DocumentMutationExecutionResult> {
      if (WORKING_BYTE_MUTATION_TYPES.has("document.replace_text")) return applyWorkingBytes(request.document, "document.replace_text", { find: request.find, replace: request.replace, ...(request.expectedCurrentText !== undefined ? { expectedCurrentText: request.expectedCurrentText } : {}), ...(request.occurrence !== undefined ? { occurrence: request.occurrence } : {}), });
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

    async insertParagraph(request): Promise<DocumentMutationExecutionResult> {
      if (WORKING_BYTE_MUTATION_TYPES.has("document.insert_paragraph")) return applyWorkingBytes(request.document, "document.insert_paragraph", { text: request.text, placement: request.placement });
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

    async insertParagraphs(request): Promise<DocumentMutationExecutionResult> {
      if (WORKING_BYTE_MUTATION_TYPES.has("document.insert_paragraphs")) return applyWorkingBytes(request.document, "document.insert_paragraphs", { texts: request.texts, placement: request.placement });
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

    async deleteParagraph(request): Promise<DocumentMutationExecutionResult> {
      if (WORKING_BYTE_MUTATION_TYPES.has("document.delete_paragraph")) return applyWorkingBytes(request.document, "document.delete_paragraph", { target: request.target });
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
      return applyWorkingBytes(request.document, "document.set_paragraph_style", {
        target: request.target, ...(request.style !== undefined ? { style: request.style } : {}),
      });
    },

    async setParagraphFormatting(request): Promise<DocumentMutationExecutionResult> {
      return applyWorkingBytes(request.document, "document.set_paragraph_formatting", {
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
      return applyWorkingBytes(request.document, "document.set_text_formatting", {
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

    async setTableCellsText(request): Promise<DocumentMutationExecutionResult> {
      if (WORKING_BYTE_MUTATION_TYPES.has("document.set_table_cells_text")) return applyWorkingBytes(request.document, "document.set_table_cells_text", { table: request.table, updates: request.updates });
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

    async insertTableRows(request): Promise<DocumentMutationExecutionResult> {
      if (WORKING_BYTE_MUTATION_TYPES.has("document.insert_table_rows")) return applyWorkingBytes(request.document, "document.insert_table_rows", { table: request.table, after: request.after, rows: request.rows });
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

    async insertTableColumn(request): Promise<DocumentMutationExecutionResult> {
      if (WORKING_BYTE_MUTATION_TYPES.has("document.insert_table_column")) return applyWorkingBytes(request.document, "document.insert_table_column", { table: request.table, header: request.header, cells: request.cells, ...(request.afterColumnHeader !== undefined ? { afterColumnHeader: request.afterColumnHeader } : {}), ...(request.afterColumnHandle !== undefined ? { afterColumnHandle: request.afterColumnHandle } : {}), });
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

    async createTable(request): Promise<DocumentMutationExecutionResult> {
      if (WORKING_BYTE_MUTATION_TYPES.has("document.create_table")) return applyWorkingBytes(request.document, "document.create_table", { rows: request.rows, placement: request.placement });
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

    async deleteTable(request): Promise<DocumentMutationExecutionResult> {
      if (WORKING_BYTE_MUTATION_TYPES.has("document.delete_table")) return applyWorkingBytes(request.document, "document.delete_table", { table: request.table });
      const applied = await mutations.applyDeleteTable({
        documentId: request.document.documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId: request.document.versionId,
        table: request.table,
        runtime: input.runtime,
      });
      return toExecutorResult(applied, request.document.versionId);
    },

    async deleteTableRow(request): Promise<DocumentMutationExecutionResult> {
      if (WORKING_BYTE_MUTATION_TYPES.has("document.delete_table_row")) return applyWorkingBytes(request.document, "document.delete_table_row", { table: request.table, row: request.row });
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

    async deleteTableColumn(request): Promise<DocumentMutationExecutionResult> {
      if (WORKING_BYTE_MUTATION_TYPES.has("document.delete_table_column")) return applyWorkingBytes(request.document, "document.delete_table_column", { table: request.table, ...(request.columnHeader !== undefined ? { columnHeader: request.columnHeader } : {}), ...(request.columnHandle !== undefined ? { columnHandle: request.columnHandle } : {}), });
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

    async setTableFormatting(request): Promise<DocumentMutationExecutionResult> {
      return applyWorkingBytes(request.document, "document.set_table_formatting", {
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
      });
    },
  };
}
