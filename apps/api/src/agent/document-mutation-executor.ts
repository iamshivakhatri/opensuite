import type {
  DocumentMutationExecutor,
  DocumentMutationResult,
  DocumentRuntime,
} from "@opensuite/agent-core";

import {
  createDocumentMutationService,
  type DocumentMutationService,
} from "../documents/mutation.js";
import type { DocumentService } from "../documents/service.js";

/**
 * Adapts DocumentMutationService.applyReplaceText to agent-core's
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
        baseVersionId: request.document.versionId,
        ...(applied.change !== undefined ? { change: applied.change } : {}),
        diagnostics: applied.diagnostics,
      };
    },
  };
}
