import { jsonSchema } from "ai";
import {
  bindDocxDocument,
  type DocxEngineBinding,
} from "@opensuite/engine-client";
import {
  defineTool,
  type AgentToolSet,
} from "@opensuite/agent-core-v3";

import type { DocumentService } from "../documents/service.js";
import {
  DocumentUploadError,
} from "../documents/service.js";
import {
  createDocumentTools,
  type BoundDocumentHost,
} from "./document-tools.js";

export interface DocumentTransition {
  readonly kind: "created" | "duplicated";
  readonly fromDocumentId: string | null;
  readonly toDocumentId: string;
  readonly title: string;
}

export interface PrimaryDocxToolsResult {
  readonly tools: AgentToolSet;
  readonly documentId: string | null;
  readonly getActiveDocumentId: () => string | null;
  readonly getActiveVersionId: () => string | null;
  readonly getWorkingRevision: () => number;
  readonly getWorkingDocument: () => { documentId: string; baseVersionId: string; revision: number; bytes: Uint8Array } | null;
  readonly getWorkingMutationCount: () => number;
  readonly flush: () => Promise<void>;
  readonly getTransitions: () => readonly DocumentTransition[];
}

type SessionDocuments = Pick<
  DocumentService,
  | "getOwnedDocument"
  | "readExactVersionBytes"
  | "appendDocumentVersion"
  | "createBlankDocxDocument"
  | "createOfficeDocumentFromBytes"
>;

function collectHandles(value: unknown, handles: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectHandles(item, handles);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/(^handle$|Handle$)/.test(key) && typeof item === "string") handles.add(item);
    else if (key.endsWith("Handles") && Array.isArray(item)) {
      for (const handle of item) if (typeof handle === "string") handles.add(handle);
    }
    else collectHandles(item, handles);
  }
}

/**
 * Mutable active DOCX binding for one agent run.
 * Document tools dereference the redirecting host at execution time so
 * lifecycle rebinds affect subsequent calls without rebuilding the toolset.
 */
function createActiveDocxSession(input: {
  readonly binding: DocxEngineBinding;
  readonly documents: SessionDocuments;
  readonly ownerUserId: string;
  readonly workspaceId: string;
  readonly onVersionAdvanced?: (event: {
    readonly documentId: string;
    readonly fromVersionId: string;
    readonly versionId: string;
    readonly versionNumber: number;
  }) => void | Promise<void>;
  readonly onDocumentCreated?: (event: {
    readonly documentId: string;
    readonly versionId: string;
    readonly versionNumber: number;
    readonly name: string;
    readonly kind: "created" | "duplicated";
  }) => void | Promise<void>;
  readonly onWorkingUpdated?: (event: { documentId: string; baseVersionId: string; revision: number }) => void;
}) {
  let documentId: string | null = null;
  let versionId: string | null = null;
  let host: ReturnType<typeof bindDocxDocument> | null = null;
  let dirty = false;
  let workingRevision = 0;
  let workingMutationCount = 0;
  const currentHandles = new Set<string>();
  const mutationFailures = new Map<string, number>();
  const transitions: DocumentTransition[] = [];

  function noteMutationFailure(capability: string, result: unknown): unknown {
    if (!result || typeof result !== "object" || (result as { ok?: unknown }).ok !== false) return result;
    const failures = (mutationFailures.get(capability) ?? 0) + 1;
    mutationFailures.set(capability, failures);
    if (failures !== 2) return result;
    console.info(`[agent] repeated_mutation_failure capability=${capability}`);
    return {
      ...result,
      retryGuidance: "This operation failed twice. Skip optional polish. For an explicit requirement, retry only with a changed target or method that addresses the failure; otherwise finish and report the unmet requirement.",
    };
  }

  function bindHost(next: {
    readonly documentId: string;
    readonly versionId: string;
    readonly bytes: Uint8Array;
  }) {
    return bindDocxDocument({
      binding: input.binding,
      bytes: next.bytes,
      versionId: next.versionId,
    });
  }

  async function flush(): Promise<void> {
    if (!dirty || !host || !documentId || !versionId) return;
    const fromVersionId = versionId;
    const appended = await input.documents.appendDocumentVersion({
      documentId,
      ownerUserId: input.ownerUserId,
      baseVersionId: fromVersionId,
      source: "agent",
      bytes: Buffer.from(host.currentBytes()),
    });
    dirty = false;
    versionId = appended.version.id;
    try {
      await input.onVersionAdvanced?.({
        documentId,
        fromVersionId,
        versionId,
        versionNumber: appended.version.versionNumber,
      });
    } catch (error) {
      console.error("[agent] document version event failed", error);
    }
  }

  function rebind(next: {
    readonly documentId: string;
    readonly versionId: string;
    readonly bytes: Uint8Array;
  }): void {
    // Fresh host → fresh handle state; handles from the prior binding stay stale.
    documentId = next.documentId;
    versionId = next.versionId;
    host = bindHost(next);
    dirty = false;
    workingRevision = 0;
    currentHandles.clear();
    mutationFailures.clear();
  }

  function requireHost(): BoundDocumentHost {
    if (!host) {
      throw new Error("NO_ACTIVE_DOCUMENT");
    }
    return host;
  }

  function advanceWorkingState(applied: number): void {
    if (!applied) return;
    dirty = true;
    workingRevision += 1;
    workingMutationCount += applied;
    currentHandles.clear();
    if (documentId && versionId) {
      try {
        input.onWorkingUpdated?.({ documentId, baseVersionId: versionId, revision: workingRevision });
      } catch (error) {
        console.error("[agent] working document event failed", error);
      }
    }
  }

  const redirectingHost: BoundDocumentHost = {
    capabilities: () => input.binding.getDocxCapabilities(),
    inspect: async (request) => {
      const result = await requireHost().inspect(request);
      collectHandles(result, currentHandles);
      return result;
    },
    find: (request) => requireHost().find(request),
    mutate: async (capability, operation) => {
      if (!host?.mutate) {
        return {
          ok: false,
          reasonCode: "NO_ACTIVE_DOCUMENT",
          status: "error",
          capability,
          diagnostics: [],
        };
      }
      const handles = new Set<string>();
      collectHandles(operation, handles);
      if ([...handles].some((handle) => !currentHandles.has(handle))) {
        return noteMutationFailure(capability, { ok: false, reasonCode: "STALE_HANDLE", status: "error", capability,
          diagnostics: [{ code: "STALE_HANDLE", severity: "error", message: "Inspect the current document again before using this handle." }] });
      }
      const result = await host.mutate(capability, operation);
      if (result.ok) {
        advanceWorkingState(1);
        mutationFailures.delete(capability);
      }
      return noteMutationFailure(capability, result);
    },
    mutateBatch: async (capability, operations) => {
      if (!host) return { ok: false, capability, reasonCode: "NO_ACTIVE_DOCUMENT", applied: 0 };
      if (operations.length < 1 || operations.length > 100) {
        return { ok: false, capability, reasonCode: "VALIDATION_FAILED", applied: 0 };
      }
      for (let index = 0; index < operations.length; index++) {
        const result = await host.mutate(capability, operations[index]!);
        if (!result.ok) {
          advanceWorkingState(index);
          if (index) mutationFailures.delete(capability);
          return noteMutationFailure(capability, {
            ok: false, capability, applied: index, failedIndex: index,
            reasonCode: result.reasonCode, diagnostics: result.diagnostics,
            workingRevision,
          });
        }
      }
      advanceWorkingState(operations.length);
      mutationFailures.delete(capability);
      return { ok: true, capability, applied: operations.length, workingRevision };
    },
  };

  async function activateCreated(created: {
    readonly kind: "created" | "duplicated";
    readonly fromDocumentId: string | null;
    readonly documentId: string;
    readonly versionId: string;
    readonly name: string;
    readonly bytes: Uint8Array;
  }): Promise<{ created: true; title: string; becameActive: true }> {
    rebind({
      documentId: created.documentId,
      versionId: created.versionId,
      bytes: created.bytes,
    });
    transitions.push({
      kind: created.kind,
      fromDocumentId: created.fromDocumentId,
      toDocumentId: created.documentId,
      title: created.name,
    });
    await input.onDocumentCreated?.({
      documentId: created.documentId,
      versionId: created.versionId,
      versionNumber: 1,
      name: created.name,
      kind: created.kind,
    });
    return {
      created: true,
      title: created.name,
      becameActive: true,
    };
  }

  return {
    redirectingHost,
    getActiveDocumentId: () => documentId,
    getActiveVersionId: () => versionId,
    getWorkingRevision: () => workingRevision,
    getWorkingDocument: () => dirty && host && documentId && versionId
      ? { documentId, baseVersionId: versionId, revision: workingRevision, bytes: host.currentBytes() }
      : null,
    getWorkingMutationCount: () => workingMutationCount,
    flush,
    getTransitions: () => transitions,
    rebind,
    async createBlank(title?: string) {
      const fromDocumentId = documentId;
      try {
        await flush();
        const created = await input.documents.createBlankDocxDocument({
          workspaceId: input.workspaceId,
          ownerUserId: input.ownerUserId,
          ...(title !== undefined ? { name: title } : {}),
          source: "agent",
        });
        const bytes = await input.documents.readExactVersionBytes({
          documentId: created.document.id,
          versionId: created.version.id,
          ownerUserId: input.ownerUserId,
        });
        return activateCreated({
          kind: "created",
          fromDocumentId,
          documentId: created.document.id,
          versionId: created.version.id,
          name: created.document.name,
          bytes: new Uint8Array(bytes),
        });
      } catch (error) {
        if (error instanceof DocumentUploadError) {
          return {
            ok: false as const,
            reasonCode: error.code,
            status: "error",
          };
        }
        throw error;
      }
    },
    async duplicateCurrent(title?: string) {
      if (!documentId || !versionId) {
        return {
          ok: false as const,
          reasonCode: "NO_ACTIVE_DOCUMENT",
          status: "error",
        };
      }
      const fromDocumentId = documentId;
      try {
        await flush();
        const fromVersionId = versionId!;
        const source = await input.documents.getOwnedDocument({
          documentId: fromDocumentId,
          ownerUserId: input.ownerUserId,
        });
        const bytes = await input.documents.readExactVersionBytes({
          documentId: fromDocumentId,
          versionId: fromVersionId,
          ownerUserId: input.ownerUserId,
        });

        const filename = duplicateFilename(source.name, title);
        const created = await input.documents.createOfficeDocumentFromBytes({
          workspaceId: input.workspaceId,
          ownerUserId: input.ownerUserId,
          filename,
          bytes,
          source: "agent",
          format: "docx",
        });

        return activateCreated({
          kind: "duplicated",
          fromDocumentId,
          documentId: created.document.id,
          versionId: created.version.id,
          name: created.document.name,
          bytes: new Uint8Array(bytes),
        });
      } catch (error) {
        if (error instanceof DocumentUploadError) {
          return {
            ok: false as const,
            reasonCode: error.code,
            status: "error",
          };
        }
        throw error;
      }
    },
  };
}

function duplicateFilename(sourceName: string, title?: string): string {
  if (title !== undefined) {
    const raw = title.trim() || sourceName;
    return raw.toLowerCase().endsWith(".docx") ? raw : `${raw}.docx`;
  }
  const base = sourceName.replace(/\.docx$/i, "");
  return `${base} Copy.docx`;
}

const titleInput = jsonSchema<{ title?: string }>({
  type: "object",
  properties: {
    title: {
      type: "string",
      description: "Optional display name for the new document",
    },
  },
  additionalProperties: false,
});

function createLifecycleTools(session: {
  createBlank: (title?: string) => Promise<unknown>;
  duplicateCurrent: (title?: string) => Promise<unknown>;
}): AgentToolSet {
  return {
    "workspace.create_blank_document": defineTool({
      kind: "mutate",
      description:
        "Create a new blank document in the current workspace and make it the active document for subsequent document tools.",
      inputSchema: titleInput,
      execute: async (input) => session.createBlank(input.title),
    }),
    "workspace.duplicate_current_document": defineTool({
      kind: "mutate",
      description:
        "Create an exact copy of the currently active document in the current workspace and make the copy active for subsequent document tools. Does not require inspect — copies bytes exactly. Original document is unchanged.",
      inputSchema: titleInput,
      execute: async (input) => session.duplicateCurrent(input.title),
    }),
  };
}

/**
 * Bind redirecting document tools + workspace lifecycle tools for one agent run.
 * Returns undefined when there is no engine binding.
 */
export async function createPrimaryDocxTools(input: {
  readonly binding: DocxEngineBinding | undefined;
  readonly documents: SessionDocuments;
  readonly ownerUserId: string;
  readonly workspaceId: string;
  readonly documentId: string | null;
  readonly versionId: string | null;
  readonly onVersionAdvanced?: (event: {
    readonly documentId: string;
    readonly fromVersionId: string;
    readonly versionId: string;
    readonly versionNumber: number;
  }) => void | Promise<void>;
  readonly onDocumentCreated?: (event: {
    readonly documentId: string;
    readonly versionId: string;
    readonly versionNumber: number;
    readonly name: string;
    readonly kind: "created" | "duplicated";
  }) => void | Promise<void>;
  readonly onWorkingUpdated?: (event: { documentId: string; baseVersionId: string; revision: number }) => void;
}): Promise<PrimaryDocxToolsResult | undefined> {
  if (!input.binding) {
    return undefined;
  }

  const session = createActiveDocxSession({
    binding: input.binding,
    documents: input.documents,
    ownerUserId: input.ownerUserId,
    workspaceId: input.workspaceId,
    ...(input.onVersionAdvanced
      ? { onVersionAdvanced: input.onVersionAdvanced }
      : {}),
    ...(input.onDocumentCreated
      ? { onDocumentCreated: input.onDocumentCreated }
      : {}),
    ...(input.onWorkingUpdated ? { onWorkingUpdated: input.onWorkingUpdated } : {}),
  });

  if (input.documentId && input.versionId) {
    const document = await input.documents.getOwnedDocument({
      documentId: input.documentId,
      ownerUserId: input.ownerUserId,
    });
    if (document.format === "docx") {
      const bytes = await input.documents.readExactVersionBytes({
        documentId: input.documentId,
        versionId: input.versionId,
        ownerUserId: input.ownerUserId,
      });
      session.rebind({
        documentId: input.documentId,
        versionId: input.versionId,
        bytes: new Uint8Array(bytes),
      });
    }
  }

  return {
    tools: {
      ...createDocumentTools(session.redirectingHost),
      ...createLifecycleTools(session),
    },
    documentId: session.getActiveDocumentId(),
    getActiveDocumentId: session.getActiveDocumentId,
    getActiveVersionId: session.getActiveVersionId,
    getWorkingRevision: session.getWorkingRevision,
    getWorkingDocument: session.getWorkingDocument,
    getWorkingMutationCount: session.getWorkingMutationCount,
    flush: session.flush,
    getTransitions: session.getTransitions,
  };
}
