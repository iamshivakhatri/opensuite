const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL;

export interface Me {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export type DocumentFormat = "docx" | "pptx" | "xlsx";

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly documentCount: number;
  readonly recentDocuments: readonly WorkspaceRecentDocument[];
}

export interface WorkspaceRecentDocument {
  readonly id: string;
  readonly name: string;
  readonly format: DocumentFormat;
}

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
  readonly starred?: boolean;
}

/** Cross-workspace library row (recent / starred / format libraries). */
export interface LibraryDocument {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly name: string;
  readonly format: DocumentFormat;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastOpenedAt: string | null;
  readonly starred: boolean;
  readonly starredAt: string | null;
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
  return body.workspaces.map((workspace) => ({
    ...workspace,
    documentCount: workspace.documentCount ?? 0,
    recentDocuments: workspace.recentDocuments ?? [],
  }));
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
  return {
    ...body.workspace,
    documentCount: body.workspace.documentCount ?? 0,
    recentDocuments: body.workspace.recentDocuments ?? [],
  };
}

export async function renameWorkspace(
  workspaceId: string,
  name: string,
): Promise<Workspace> {
  const response = await apiFetch(`/api/workspaces/${workspaceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { workspace: Workspace };
  return {
    ...body.workspace,
    documentCount: body.workspace.documentCount ?? 0,
    recentDocuments: body.workspace.recentDocuments ?? [],
  };
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  const response = await apiFetch(`/api/workspaces/${workspaceId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw await parseError(response);
  }
}

export async function restoreWorkspace(workspaceId: string): Promise<Workspace> {
  const response = await apiFetch(`/api/workspaces/${workspaceId}/restore`, {
    method: "POST",
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { workspace: Workspace };
  return {
    ...body.workspace,
    documentCount: body.workspace.documentCount ?? 0,
    recentDocuments: body.workspace.recentDocuments ?? [],
  };
}

export interface TrashedWorkspace {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string;
}

export interface TrashedDocument {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceDeleted: boolean;
  readonly name: string;
  readonly format: DocumentFormat;
  readonly deletedAt: string;
}

export async function listTrash(): Promise<{
  workspaces: TrashedWorkspace[];
  documents: TrashedDocument[];
}> {
  const response = await apiFetch("/api/trash");
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as {
    workspaces: TrashedWorkspace[];
    documents: TrashedDocument[];
  };
}

export async function renameDocument(
  documentId: string,
  name: string,
): Promise<ListedDocument> {
  const response = await apiFetch(`/api/documents/${documentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { document: ListedDocument };
  return body.document;
}

export async function deleteDocument(documentId: string): Promise<void> {
  const response = await apiFetch(`/api/documents/${documentId}`, {
    method: "DELETE",
  });
  if (!response.ok) {
    throw await parseError(response);
  }
}

export async function restoreDocument(
  documentId: string,
): Promise<ListedDocument> {
  const response = await apiFetch(`/api/documents/${documentId}/restore`, {
    method: "POST",
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { document: ListedDocument };
  return body.document;
}

export interface SearchDocumentHit {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly name: string;
  readonly format: DocumentFormat;
  readonly updatedAt: string;
  readonly rank: number;
}

export interface SearchWorkspaceHit {
  readonly id: string;
  readonly name: string;
  readonly updatedAt: string;
  readonly rank: number;
}

export async function searchMetadata(query: string): Promise<{
  documents: SearchDocumentHit[];
  workspaces: SearchWorkspaceHit[];
}> {
  const response = await apiFetch(
    `/api/search?q=${encodeURIComponent(query)}`,
  );
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as {
    documents: SearchDocumentHit[];
    workspaces: SearchWorkspaceHit[];
  };
}

export async function listRecentDocuments(): Promise<LibraryDocument[]> {
  const response = await apiFetch("/api/documents/recent");
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { documents: LibraryDocument[] };
  return body.documents;
}

export async function listStarredDocuments(): Promise<LibraryDocument[]> {
  const response = await apiFetch("/api/documents/starred");
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { documents: LibraryDocument[] };
  return body.documents;
}

export async function listLibraryDocuments(
  format: DocumentFormat,
): Promise<LibraryDocument[]> {
  const response = await apiFetch(
    `/api/documents/library?format=${encodeURIComponent(format)}`,
  );
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { documents: LibraryDocument[] };
  return body.documents;
}

export async function setDocumentStarred(
  documentId: string,
  starred: boolean,
): Promise<{ starred: boolean; starredAt: string | null }> {
  const response = await apiFetch(`/api/documents/${documentId}/star`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ starred }),
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as {
    starred: boolean;
    starredAt: string | null;
  };
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
      source: "upload" | "user" | "agent" | "system";
      createdAt: string;
      parentVersionId?: string | null;
      sha256?: string | null;
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

/** Create a blank Word document (Rust-generated DOCX) without uploading a file. */
export async function createBlankDocument(
  workspaceId: string,
  options?: { name?: string },
): Promise<{ document: ListedDocument; version: ListedDocumentVersion }> {
  const response = await apiFetch(
    `/api/workspaces/${workspaceId}/documents/blank`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        options?.name !== undefined ? { name: options.name } : {},
      ),
    },
  );
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
      source: "upload" | "user" | "agent" | "system";
      createdAt: string;
    };
  };

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

export interface SavedDocumentVersion {
  readonly id: string;
  readonly documentId: string;
  readonly versionNumber: number;
  readonly parentVersionId: string | null;
  readonly sizeBytes: number;
  readonly sha256: string | null;
  readonly source: "upload" | "user" | "agent" | "system";
  readonly createdByUserId: string;
  readonly createdAt: string;
}

/**
 * Fetch exact immutable Office bytes for a specific document version.
 * For a future browser editor — not latest-only download.
 */
export async function fetchDocumentVersionContent(
  documentId: string,
  versionId: string,
): Promise<ArrayBuffer> {
  const response = await apiFetch(
    `/api/documents/${documentId}/versions/${versionId}/content`,
  );
  if (!response.ok) {
    throw await parseError(response);
  }
  return response.arrayBuffer();
}

/**
 * Explicit human save: append exported Office bytes as a new user version.
 * One request = one immutable version. Client must pass the exact baseVersionId
 * it loaded; stale bases return 409 VERSION_CONFLICT.
 */
export async function saveDocumentVersion(
  documentId: string,
  input: {
    readonly baseVersionId: string;
    readonly file: Blob;
    readonly filename?: string;
  },
): Promise<{ document: ListedDocument; version: SavedDocumentVersion }> {
  const form = new FormData();
  form.append("baseVersionId", input.baseVersionId);
  form.append(
    "file",
    input.file,
    input.filename ?? "document.docx",
  );

  const response = await apiFetch(`/api/documents/${documentId}/versions`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw await parseError(response);
  }

  return (await response.json()) as {
    document: ListedDocument;
    version: SavedDocumentVersion;
  };
}

export type AgentRunStatus =
  | "queued"
  | "planning"
  | "running"
  | "waiting_for_confirmation"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentThread {
  readonly id: string;
  readonly workspaceId: string;
  readonly documentId: string | null;
  readonly title: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: string;
}

export interface AgentRun {
  readonly id: string;
  readonly threadId: string;
  readonly status: AgentRunStatus;
  readonly baseDocumentVersionId?: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface AgentStep {
  readonly id: string;
  readonly sequence: number;
  readonly kind: string;
  readonly status: string;
  readonly name: string;
  readonly summary: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface AgentLiveEvent {
  readonly id: number;
  readonly runId: string;
  readonly type: string;
  readonly at: string;
  readonly data: Record<string, unknown>;
}

const ACTIVE_RUN_STATUSES = new Set<AgentRunStatus>([
  "queued",
  "planning",
  "running",
  "waiting_for_confirmation",
]);

export function isActiveAgentRunStatus(status: AgentRunStatus): boolean {
  return ACTIVE_RUN_STATUSES.has(status);
}

export async function listDocumentAgentThreads(
  documentId: string,
): Promise<AgentThread[]> {
  const response = await apiFetch(
    `/api/documents/${documentId}/agent/threads`,
  );
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { threads: AgentThread[] };
  return body.threads;
}

export async function createDocumentAgentThread(
  documentId: string,
  title?: string | null,
): Promise<AgentThread> {
  const response = await apiFetch(
    `/api/documents/${documentId}/agent/threads`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        title === undefined || title === null || title === ""
          ? {}
          : { title },
      ),
    },
  );
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { thread: AgentThread };
  return body.thread;
}

/** Workspace-scoped agent threads (Cursor-style chat, not bound to one file). */
export async function listWorkspaceAgentThreads(
  workspaceId: string,
): Promise<AgentThread[]> {
  const response = await apiFetch(
    `/api/workspaces/${workspaceId}/agent/threads`,
  );
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { threads: AgentThread[] };
  return body.threads;
}

export async function createWorkspaceAgentThread(
  workspaceId: string,
  title?: string | null,
): Promise<AgentThread> {
  const response = await apiFetch(
    `/api/workspaces/${workspaceId}/agent/threads`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        title === undefined || title === null || title === ""
          ? {}
          : { title },
      ),
    },
  );
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { thread: AgentThread };
  return body.thread;
}

export async function getAgentMessages(threadId: string): Promise<{
  messages: AgentMessage[];
  latestRun: AgentRun | null;
}> {
  const response = await apiFetch(
    `/api/agent/threads/${threadId}/messages`,
  );
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as {
    messages: AgentMessage[];
    latestRun?: AgentRun | null;
  };
  return {
    messages: body.messages,
    latestRun: body.latestRun ?? null,
  };
}

export async function startAgentRun(
  threadId: string,
  instruction: string,
  options?: { documentIds?: readonly string[] },
): Promise<AgentRun> {
  const response = await apiFetch(`/api/agent/threads/${threadId}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instruction,
      ...(options?.documentIds && options.documentIds.length > 0
        ? { documentIds: [...options.documentIds] }
        : {}),
    }),
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  const body = (await response.json()) as { run: AgentRun };
  return body.run;
}

export async function getAgentRun(runId: string): Promise<{
  run: AgentRun;
  steps: AgentStep[];
}> {
  const response = await apiFetch(`/api/agent/runs/${runId}`);
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as { run: AgentRun; steps: AgentStep[] };
}

/**
 * Poll durable run snapshot until terminal (or timeout).
 * Prefer SSE for live progress — this is a short recovery helper only.
 * Uses backoff so a stuck non-terminal run cannot flood GET /runs.
 */
export async function waitForAgentRunTerminal(
  runId: string,
  options?: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal },
): Promise<{ run: AgentRun; steps: AgentStep[] }> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const baseIntervalMs = options?.intervalMs ?? 500;
  const started = Date.now();
  let last = await getAgentRun(runId);
  let attempt = 0;

  while (isActiveAgentRunStatus(last.run.status)) {
    if (options?.signal?.aborted) {
      return last;
    }
    if (Date.now() - started >= timeoutMs) {
      return last;
    }
    const delay = Math.min(5_000, baseIntervalMs * 2 ** attempt);
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, delay));
    last = await getAgentRun(runId);
  }

  return last;
}

export async function cancelAgentRun(runId: string): Promise<{
  run: AgentRun;
  steps: AgentStep[];
}> {
  const response = await apiFetch(`/api/agent/runs/${runId}/cancel`, {
    method: "POST",
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as { run: AgentRun; steps: AgentStep[] };
}

/**
 * Approve or deny a pending `waiting_for_confirmation` tool call. Throws
 * `ApiError` with code `CONFIRMATION_NOT_PENDING` (409) for a stale,
 * duplicate, unknown, or already-resolved `toolCallId`.
 */
export async function resolveAgentConfirmation(
  runId: string,
  input: { toolCallId: string; decision: "approve" | "deny" },
): Promise<{ run: AgentRun }> {
  const response = await apiFetch(`/api/agent/runs/${runId}/confirmation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw await parseError(response);
  }
  return (await response.json()) as { run: AgentRun };
}

export interface SubscribeAgentRunEventsOptions {
  readonly onEvent: (event: AgentLiveEvent) => void;
  /** Fired when the SSE stream ends without a handled terminal event. */
  readonly onDisconnect?: () => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Subscribe to live run SSE. Caller must abort to unsubscribe.
 * Disconnect does not cancel the run — recover via getAgentRun.
 */
export function subscribeAgentRunEvents(
  runId: string,
  options: SubscribeAgentRunEventsOptions,
): { abort: () => void } {
  const controller = new AbortController();

  void (async () => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const response = await apiFetch(`/api/agent/runs/${runId}/events`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw await parseError(response);
      }
      if (!response.body) {
        throw new ApiError(500, "SSE_UNAVAILABLE", "SSE stream unavailable");
      }

      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let sawTerminal = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const block of parts) {
          const event = parseSseBlock(block);
          if (!event) continue;
          // Keep the stream alive if a UI handler throws.
          try {
            options.onEvent(event);
          } catch {
            // ignore listener errors
          }
          if (
            event.type === "agent.completed" ||
            event.type === "agent.failed" ||
            event.type === "agent.cancelled"
          ) {
            sawTerminal = true;
          }
        }
      }

      if (!sawTerminal && !controller.signal.aborted) {
        options.onDisconnect?.();
      }
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      options.onError?.(error);
    } finally {
      try {
        reader?.releaseLock();
      } catch {
        // already released / cancelled
      }
    }
  })();

  return {
    abort: () => {
      controller.abort();
    },
  };
}

function parseSseBlock(block: string): AgentLiveEvent | null {
  const trimmed = block.trim();
  if (!trimmed || trimmed.startsWith(":")) {
    return null;
  }

  let id: number | undefined;
  let type: string | undefined;
  let dataRaw: string | undefined;

  for (const line of trimmed.split("\n")) {
    if (line.startsWith("id:")) {
      const parsed = Number.parseInt(line.slice(3).trim(), 10);
      if (!Number.isNaN(parsed)) id = parsed;
    } else if (line.startsWith("event:")) {
      type = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataRaw = line.slice(5).trim();
    }
  }

  if (!dataRaw) {
    return null;
  }

  try {
    const payload = JSON.parse(dataRaw) as {
      runId?: string;
      type?: string;
      at?: string;
      data?: Record<string, unknown>;
    };
    return {
      id: id ?? 0,
      runId: payload.runId ?? "",
      type: type ?? payload.type ?? "message",
      at: payload.at ?? new Date().toISOString(),
      data: payload.data ?? {},
    };
  } catch {
    return null;
  }
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
