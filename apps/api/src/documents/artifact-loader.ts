import type { DocumentRef } from "@opensuite/agent-core";
import type { DocumentArtifactLoader } from "@opensuite/engine-client";

import type { DocumentService } from "./service.js";

/**
 * Production DocumentArtifactLoader backed by document version + object storage.
 *
 * Loads the exact requested version — never silently substitutes latest.
 * Storage keys stay inside DocumentService; AgentTools never see them.
 */
export function createOwnedDocumentArtifactLoader(input: {
  readonly documents: Pick<DocumentService, "readExactVersionBytes">;
  readonly ownerUserId: string;
}): DocumentArtifactLoader {
  const { documents, ownerUserId } = input;

  return {
    async loadExactVersionBytes(document: DocumentRef): Promise<Uint8Array> {
      const bytes = await documents.readExactVersionBytes({
        documentId: document.documentId,
        versionId: document.versionId,
        ownerUserId,
      });
      return bytes;
    },
  };
}
