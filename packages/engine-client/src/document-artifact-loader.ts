import type { DocumentRef } from "@opensuite/agent-core";

/**
 * Resolves exact immutable version bytes for a DocumentRef.
 *
 * Application storage/version services implement this. The engine adapter
 * never hardcodes filesystem paths or storage keys.
 */
export interface DocumentArtifactLoader {
  loadExactVersionBytes(document: DocumentRef): Promise<Uint8Array>;
}

/** In-memory loader for tests and local smoke runs. */
export function createMemoryArtifactLoader(
  versions: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>,
): DocumentArtifactLoader {
  const map =
    versions instanceof Map
      ? versions
      : new Map(Object.entries(versions));

  return {
    async loadExactVersionBytes(document) {
      const bytes = map.get(document.versionId) ?? map.get(document.documentId);
      if (!bytes) {
        throw new Error(
          `No artifact bytes configured for document=${document.documentId} version=${document.versionId}`,
        );
      }
      return bytes;
    },
  };
}
