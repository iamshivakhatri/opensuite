/** Drag payload when dragging a workspace file into agent chat. */
export const OPENSUITE_DOCUMENT_DRAG_MIME = "application/x-opensuite-document";

export interface OpensuiteDocumentDragPayload {
  readonly id: string;
  readonly name: string;
  readonly format: string;
  readonly workspaceId: string;
}

export function encodeDocumentDragPayload(
  payload: OpensuiteDocumentDragPayload,
): string {
  return JSON.stringify(payload);
}

export function parseDocumentDragPayload(
  raw: string | undefined | null,
): OpensuiteDocumentDragPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OpensuiteDocumentDragPayload>;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.name === "string" &&
      typeof parsed.format === "string" &&
      typeof parsed.workspaceId === "string"
    ) {
      return {
        id: parsed.id,
        name: parsed.name,
        format: parsed.format,
        workspaceId: parsed.workspaceId,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

/** Prefer workspace-file tags over OS files when both are present on a drop. */
export function readComposerDrop(dataTransfer: DataTransfer): {
  readonly workspaceDocument: OpensuiteDocumentDragPayload | null;
  readonly files: File[];
} {
  const workspaceDocument = parseDocumentDragPayload(
    dataTransfer.getData(OPENSUITE_DOCUMENT_DRAG_MIME),
  );
  if (workspaceDocument) {
    return { workspaceDocument, files: [] };
  }
  return {
    workspaceDocument: null,
    files: Array.from(dataTransfer.files ?? []),
  };
}
