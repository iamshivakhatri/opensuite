import { getDocument, listDocuments } from "@/lib/api";

export const queryKeys = {
  workspaceDocuments: (workspaceId: string) =>
    ["workspaces", workspaceId, "documents"] as const,
  document: (documentId: string) => ["documents", documentId] as const,
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
