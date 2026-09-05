/**
 * Canonical app paths. Prefer these over string-building in components.
 */
export function workspacePath(workspaceId: string): string {
  return `/app/workspaces/${workspaceId}`;
}

export function documentPath(
  workspaceId: string,
  documentId: string,
): string {
  return `/app/workspaces/${workspaceId}/documents/${documentId}`;
}
