import {
  createDocumentTools,
  type BoundDocumentHost,
  type ToolSet,
} from "@opensuite/agent-core-v2";
import {
  bindDocxDocument,
  type DocxEngineBinding,
} from "@opensuite/engine-client";

import type { DocumentService } from "../documents/service.js";

export interface PrimaryDocxToolsResult {
  readonly tools: ToolSet;
  readonly documentId: string;
}

/**
 * Load exact primary DOCX bytes and bind read/write tools for one agent run.
 * Returns undefined when there is no DOCX primary document or no engine.
 *
 * Successful mutations: Rust verifies bytes → appendDocumentVersion → host advances.
 */
export async function createPrimaryDocxTools(input: {
  readonly binding: DocxEngineBinding | undefined;
  readonly documents: Pick<
    DocumentService,
    "getOwnedDocument" | "readExactVersionBytes" | "appendDocumentVersion"
  >;
  readonly ownerUserId: string;
  readonly documentId: string | null;
  readonly versionId: string | null;
  readonly onVersionAdvanced?: (event: {
    readonly documentId: string;
    readonly versionId: string;
    readonly versionNumber: number;
  }) => void | Promise<void>;
}): Promise<PrimaryDocxToolsResult | undefined> {
  if (!input.binding || !input.documentId || !input.versionId) {
    return undefined;
  }

  const document = await input.documents.getOwnedDocument({
    documentId: input.documentId,
    ownerUserId: input.ownerUserId,
  });
  if (document.format !== "docx") {
    return undefined;
  }

  const bytes = await input.documents.readExactVersionBytes({
    documentId: input.documentId,
    versionId: input.versionId,
    ownerUserId: input.ownerUserId,
  });

  const documentId = input.documentId;
  const bound: BoundDocumentHost = bindDocxDocument({
    binding: input.binding,
    bytes,
    versionId: input.versionId,
    persist: async ({ bytes: nextBytes, baseVersionId }) => {
      const appended = await input.documents.appendDocumentVersion({
        documentId,
        ownerUserId: input.ownerUserId,
        baseVersionId,
        source: "agent",
        bytes: Buffer.from(nextBytes),
      });
      await input.onVersionAdvanced?.({
        documentId,
        versionId: appended.version.id,
        versionNumber: appended.version.versionNumber,
      });
      return {
        versionId: appended.version.id,
        versionNumber: appended.version.versionNumber,
      };
    },
  });

  return { tools: createDocumentTools(bound), documentId };
}
