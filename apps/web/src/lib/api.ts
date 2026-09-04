const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL;

export interface Me {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DocumentFormat = "docx" | "pptx" | "xlsx";

export interface ListedDocumentVersion {
  readonly id: string;
  readonly versionNumber: number;
  readonly sizeBytes: number;
  readonly source: "upload" | "user" | "agent" | "system";
  readonly createdAt: string;
}

export interface ListedDocument {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly format: DocumentFormat;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestVersion: ListedDocumentVersion;
}

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function requireApiBaseUrl(): string {
  if (!apiBaseUrl) {
    throw new ApiError(
      500,
      "MISSING_API_URL",
      "OpenSuite API URL is not configured",
    );
  }
  return apiBaseUrl;
}

async function parseError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as {
      error?: { statusCode?: number; code?: string; message?: string };
    };
    return new ApiError(
      body.error?.statusCode ?? response.status,
      body.error?.code ?? "REQUEST_FAILED",
      body.error?.message ?? "Something went wrong. Please try again.",
    );
  } catch {
    return new ApiError(
      response.status,
      "REQUEST_FAILED",
      "Something went wrong. Please try again.",
    );
  }
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${requireApiBaseUrl()}${path}`, {
    ...init,
    credentials: "include",
  });
  return response;
}

/**
 * Calls the OpenSuite-owned `GET /api/me` (not a Better Auth endpoint) to
 * prove the backend recognizes the current session. `credentials: "include"`
 * is required because apps/web and apps/api are different origins.
 */
export async function fetchMe(): Promise<Me | null> {
  const response = await apiFetch("/api/me");

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  const body = (await response.json()) as { user: Me };
  return body.user;
}

export async function listWorkspaces(): Promise<Workspace[]> {
  const response = await apiFetch("/api/workspaces");
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { workspaces: Workspace[] };
  return body.workspaces;
}

export async function createWorkspace(name: string): Promise<Workspace> {
  const response = await apiFetch("/api/workspaces", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { workspace: Workspace };
  return body.workspace;
}

export async function listDocuments(
  workspaceId: string,
): Promise<ListedDocument[]> {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/documents`);
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { documents: ListedDocument[] };
  return body.documents;
}

export async function getDocument(documentId: string): Promise<ListedDocument> {
  const response = await apiFetch(`/api/documents/${documentId}`);
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { document: ListedDocument };
  return body.document;
}

export async function uploadDocument(
  workspaceId: string,
  file: File,
): Promise<{ document: ListedDocument; version: ListedDocumentVersion }> {
  const form = new FormData();
  form.append("file", file);

  const response = await apiFetch(`/api/workspaces/${workspaceId}/documents`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw await parseError(response);
  }

  const body = (await response.json()) as {
    document: {
      id: string;
      workspaceId: string;
      name: string;
      format: DocumentFormat;
      createdAt: string;
      updatedAt: string;
    };
    version: {
      id: string;
      documentId: string;
      versionNumber: number;
      sizeBytes: number;
      source: "upload";
      createdAt: string;
      storageKey?: string;
      createdByUserId?: string;
    };
  };

  // Map upload response onto the list DTO shape used by the Files UI.
  return {
    document: {
      id: body.document.id,
      workspaceId: body.document.workspaceId,
      name: body.document.name,
      format: body.document.format,
      createdAt: body.document.createdAt,
      updatedAt: body.document.updatedAt,
      latestVersion: {
        id: body.version.id,
        versionNumber: body.version.versionNumber,
        sizeBytes: body.version.sizeBytes,
        source: body.version.source,
        createdAt: body.version.createdAt,
      },
    },
    version: {
      id: body.version.id,
      versionNumber: body.version.versionNumber,
      sizeBytes: body.version.sizeBytes,
      source: body.version.source,
      createdAt: body.version.createdAt,
    },
  };
}

function filenameFromContentDisposition(
  header: string | null,
): string | undefined {
  if (!header) return undefined;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      // fall through
    }
  }
  const plain = /filename="([^"]+)"/i.exec(header);
  return plain?.[1];
}

/**
 * Downloads the latest version of a document through the Fastify API
 * (proxied bytes — never a storage URL).
 */
export async function downloadDocument(documentId: string): Promise<void> {
  const response = await apiFetch(`/api/documents/${documentId}/download`);
  if (!response.ok) {
    throw await parseError(response);
  }

  const blob = await response.blob();
  const filename =
    filenameFromContentDisposition(response.headers.get("Content-Disposition")) ??
    "document";

  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
