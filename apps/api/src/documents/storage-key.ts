/**
 * Deterministic object-storage key for a document version's bytes.
 * Bucket/endpoint stay in configuration — only this key is stored in Postgres.
 */
export function buildDocumentVersionStorageKey(input: {
  workspaceId: string;
  documentId: string;
  versionId: string;
  format: "docx" | "pptx" | "xlsx";
}): string {
  return `workspaces/${input.workspaceId}/documents/${input.documentId}/versions/${input.versionId}/content.${input.format}`;
}
