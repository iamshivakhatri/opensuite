const MAX_DOCUMENTS = 60;

export interface ManifestDocument {
  readonly documentId: string;
  readonly name: string;
  readonly format: string;
  readonly updatedAt?: string;
  readonly latestVersionNumber?: number;
}

/** Compact workspace awareness; this does not inspect document content. */
export function formatWorkspaceManifest(
  documents: readonly ManifestDocument[],
  openDocumentId: string | null,
  taggedDocumentIds: readonly string[],
): string {
  const tagged = new Set(taggedDocumentIds);
  const sorted = [...documents].sort((a, b) =>
    Number(b.documentId === openDocumentId) - Number(a.documentId === openDocumentId) ||
    (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.name.localeCompare(b.name));
  const lines = ["WORKSPACE MANIFEST", `${documents.length} documents`];
  for (const document of sorted.slice(0, MAX_DOCUMENTS)) {
    const markers = [document.documentId === openDocumentId ? "OPEN" : null, tagged.has(document.documentId) ? "TAGGED" : null]
      .filter(Boolean).map((marker) => `[${marker}]`).join(" ");
    lines.push(`- ${markers ? `${markers} ` : ""}${document.name} (${document.format}; ID ${document.documentId}; updated ${document.updatedAt ?? "unknown"}; v${document.latestVersionNumber ?? "?"})`);
  }
  if (sorted.length > MAX_DOCUMENTS) lines.push(`- ${sorted.length - MAX_DOCUMENTS} more documents omitted; use workspace_search_documents`);
  return lines.join("\n");
}
