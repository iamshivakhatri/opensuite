import {
  fetchDocumentVersionContent,
  getDocument,
  listDocumentVersions,
  listDocuments,
} from "@/lib/api";
import {
  fetchAiPreference,
  listProviderCredentials,
} from "@/lib/ai-settings-api";

export const queryKeys = {
  workspaceDocuments: (workspaceId: string) =>
    ["workspaces", workspaceId, "documents"] as const,
  document: (documentId: string) => ["documents", documentId] as const,
  documentVersions: (documentId: string) =>
    ["documents", documentId, "versions"] as const,
  documentVersionContent: (documentId: string, versionId: string) =>
    ["documents", documentId, "versions", versionId, "content"] as const,
  aiPreference: ["ai-preferences"] as const,
  providerCredentials: ["provider-credentials"] as const,
};

export function workspaceDocumentsQuery(workspaceId: string) {
  return {
    queryKey: queryKeys.workspaceDocuments(workspaceId),
    queryFn: () => listDocuments(workspaceId),
    staleTime: 60_000,
  };
}

export function documentQuery(documentId: string) {
  return {
    queryKey: queryKeys.document(documentId),
    queryFn: () => getDocument(documentId),
    staleTime: 30_000,
  };
}

/** Last ~5 tips for the explorer versions rail. */
export function documentVersionsQuery(documentId: string) {
  return {
    queryKey: queryKeys.documentVersions(documentId),
    queryFn: () => listDocumentVersions(documentId, { limit: 5 }),
    staleTime: 30_000,
  };
}

/** Immutable version bytes — cache forever until explicit remove. */
export function documentVersionContentQuery(
  documentId: string,
  versionId: string,
) {
  return {
    queryKey: queryKeys.documentVersionContent(documentId, versionId),
    queryFn: () => fetchDocumentVersionContent(documentId, versionId),
    staleTime: Infinity,
  };
}

/** Stable for the session; invalidate after preference mutations. */
export function aiPreferenceQuery() {
  return {
    queryKey: queryKeys.aiPreference,
    queryFn: fetchAiPreference,
    staleTime: 5 * 60_000,
  };
}

/** Metadata only (no secrets); invalidate after connect/remove. */
export function providerCredentialsQuery() {
  return {
    queryKey: queryKeys.providerCredentials,
    queryFn: listProviderCredentials,
    staleTime: 5 * 60_000,
  };
}
