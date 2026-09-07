import {
  createMockDocumentRuntime,
  mockCapabilitiesForFormat,
  type DocumentRuntime,
  type RuntimeCapabilities,
} from "@opensuite/agent-core";
import {
  createNapiDocxEngineBinding,
  createOpenSuiteEngineAdapter,
  type DocxEngineBinding,
} from "@opensuite/engine-client";

import { createOwnedDocumentArtifactLoader } from "./artifact-loader.js";
import type { DocumentService } from "./service.js";

export type DocumentRuntimeResolver = (input: {
  readonly format: string | undefined;
  readonly ownerUserId: string;
}) => DocumentRuntime;

/**
 * Production runtime selection:
 *   DOCX → OpenSuite engine adapter (Rust N-API, exact version bytes)
 *   PPTX/XLSX/unknown → mock runtime (engine not wired yet)
 *
 * DOCX never falls back to mock fixture content.
 * Mock formats advertise their own capability ids (not DOCX mutation caps).
 */
export function createDocumentRuntimeResolver(input: {
  readonly documents: Pick<DocumentService, "readExactVersionBytes">;
  readonly binding: DocxEngineBinding;
  /** @deprecated Ignored for mock formats — use format-specific mock caps. */
  readonly mockCapabilities?: RuntimeCapabilities;
}): DocumentRuntimeResolver {
  const { documents, binding } = input;

  return ({ format, ownerUserId }) => {
    if (format !== "docx") {
      const mockFormat =
        format === "pptx" || format === "xlsx" ? format : undefined;
      return createMockDocumentRuntime({
        capabilities: mockCapabilitiesForFormat(mockFormat),
      });
    }

    return createOpenSuiteEngineAdapter({
      binding,
      artifactLoader: createOwnedDocumentArtifactLoader({
        documents,
        ownerUserId,
      }),
    });
  };
}

/** Load the local N-API binding once at process start. */
export async function loadDocxEngineBinding(): Promise<DocxEngineBinding> {
  return createNapiDocxEngineBinding();
}
