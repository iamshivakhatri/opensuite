import { apiFetch, parseApiError } from './api-client';

export interface DocumentDraft {
  readonly id: string;
  readonly baseVersionId: string;
  readonly sizeBytes: number;
  readonly updatedAt: string;
}

export async function fetchDocumentDraft(documentId: string): Promise<{ id: string; baseVersionId: string; bytes: ArrayBuffer } | null> {
  const response = await apiFetch(`/api/documents/${documentId}/draft`, { cache: 'no-store' });
  if (!response.ok) throw await parseApiError(response);
  if (response.status === 204) return null;
  const id = response.headers.get('X-Draft-Id');
  const baseVersionId = response.headers.get('X-Base-Version-Id');
  if (!id || !baseVersionId) throw new Error('The saved draft is missing its document details.');
  return { id, baseVersionId, bytes: await response.arrayBuffer() };
}

export async function saveDocumentDraft(documentId: string, input: {
  readonly baseVersionId: string; readonly baseDraftId: string | null; readonly file: Blob; readonly filename: string;
}): Promise<DocumentDraft> {
  const form = new FormData();
  form.append('baseVersionId', input.baseVersionId);
  if (input.baseDraftId) form.append('baseDraftId', input.baseDraftId);
  form.append('file', input.file, input.filename);
  const response = await apiFetch(`/api/documents/${documentId}/draft`, { method: 'PUT', body: form });
  if (!response.ok) throw await parseApiError(response);
  return ((await response.json()) as { draft: DocumentDraft }).draft;
}
