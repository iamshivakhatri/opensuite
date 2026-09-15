import {
  createDocumentTools,
  type BoundDocumentReads,
  type ToolSet,
} from "@opensuite/agent-core-v2";
import {
  bindDocxDocument,
  type DocxEngineBinding,
} from "@opensuite/engine-client";

import type { DocumentService } from "../documents/service.js";

/**
 * Load exact primary DOCX bytes and bind read tools for one agent run.
 * Returns undefined when there is no DOCX primary document or no engine.
 */
export async function createPrimaryDocxTools(input: {
  readonly binding: DocxEngineBinding | undefined;
  readonly documents: Pick<
    DocumentService,
    "getOwnedDocument" | "readExactVersionBytes"
  >;
  readonly ownerUserId: string;
  readonly documentId: string | null;
  readonly versionId: string | null;
}): Promise<ToolSet | undefined> {
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

  const bound: BoundDocumentReads = bindDocxDocument({
    binding: input.binding,
    bytes,
  });
  return createDocumentTools(bound);
}
