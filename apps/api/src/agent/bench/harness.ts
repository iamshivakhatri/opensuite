import { randomUUID } from "node:crypto";

import {
  AgentRunner,
  ToolRegistry,
  createDocumentAgentRunnerOptions,
  createFakeTool,
  createRecordingEventSink,
  elapsedMs,
  listDocumentToolDescriptors,
  type AgentModel,
  type AgentResult,
  type DocumentMutationExecutor,
  type DocumentMutationResult,
  type DocumentRef,
  type DocumentRuntime,
  type ToolExecutionContext,
} from "@opensuite/agent-core";
import {
  createNapiDocxEngineBinding,
  createOpenSuiteEngineAdapter,
  type DocxEngineBinding,
} from "@opensuite/engine-client";

import { createAgentDocumentMutationExecutor } from "../document-mutation-executor.js";
import {
  DocumentAccessError,
  type AppendedDocumentDto,
  type DocumentService,
  type DocumentVersionDto,
  type ListedDocumentDto,
  type UploadedDocumentDto,
} from "../../documents/service.js";
import {
  createWorkspaceCreateBlankDocxTool,
  WORKSPACE_TOOL_NAMES,
} from "../workspace-tools.js";

/**
 * In-memory artifact store that persists N→N+1 bytes after engine mutations.
 * Mirrors production immutable versioning without DB/S3.
 */
export function createBenchArtifactStore(
  initial: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array> = {},
) {
  const versions = new Map<string, Uint8Array>(
    initial instanceof Map
      ? initial
      : Object.entries(initial).map(([k, v]) => [k, v]),
  );
  let persistMs = 0;
  let sequence = 0;

  return {
    versions,
    get totalPersistMs() {
      return persistMs;
    },
    resetPersistMs() {
      persistMs = 0;
    },
    put(versionId: string, bytes: Uint8Array) {
      const started = Date.now();
      versions.set(versionId, bytes);
      persistMs += elapsedMs(started);
    },
    loader: {
      async loadExactVersionBytes(document: DocumentRef): Promise<Uint8Array> {
        const bytes = versions.get(document.versionId);
        if (!bytes) {
          throw new Error(
            `Bench artifact missing for version=${document.versionId}`,
          );
        }
        return bytes;
      },
    },
    nextVersionId(baseVersionId: string): string {
      sequence += 1;
      return `${baseVersionId}+${sequence}`;
    },
  };
}

export type BenchArtifactStore = ReturnType<typeof createBenchArtifactStore>;

const BENCH_OWNER_ID = "bench-owner";
const BENCH_WORKSPACE_ID = "bench-workspace";

/** In-memory implementation of the production document persistence contract. */
function createBenchDocumentService(input: {
  readonly binding: DocxEngineBinding;
  readonly store: BenchArtifactStore;
}) {
  const documents = new Map<
    string,
    {
      ownerUserId: string;
      workspaceId: string;
      name: string;
      createdAt: string;
      versions: DocumentVersionDto[];
    }
  >();

  function listed(documentId: string, document: NonNullable<ReturnType<typeof documents.get>>): ListedDocumentDto {
    const version = document.versions.at(-1)!;
    return {
      id: documentId,
      workspaceId: document.workspaceId,
      name: document.name,
      format: "docx",
      createdAt: document.createdAt,
      updatedAt: version.createdAt,
      latestVersion: {
        id: version.id,
        versionNumber: version.versionNumber,
        sizeBytes: version.sizeBytes,
        source: version.source,
        createdAt: version.createdAt,
      },
    };
  }

  function addDocument(bytes: Uint8Array, name: string, ownerUserId: string, workspaceId: string): UploadedDocumentDto {
    const documentId = randomUUID();
    const versionId = randomUUID();
    const createdAt = new Date().toISOString();
    const version: DocumentVersionDto = {
      id: versionId,
      documentId,
      versionNumber: 1,
      parentVersionId: null,
      sizeBytes: bytes.byteLength,
      sha256: null,
      source: "user",
      createdByUserId: ownerUserId,
      createdAt,
    };
    documents.set(documentId, { ownerUserId, workspaceId, name, createdAt, versions: [version] });
    input.store.put(versionId, bytes);
    return {
      document: { id: documentId, workspaceId, name, format: "docx", createdAt, updatedAt: createdAt },
      version,
    };
  }

  const service = {
    async getOwnedDocument({ documentId, ownerUserId }: { documentId: string; ownerUserId: string }) {
      const document = documents.get(documentId);
      if (!document || document.ownerUserId !== ownerUserId) {
        throw new DocumentAccessError(404, "DOCUMENT_NOT_FOUND", "Document not found");
      }
      return listed(documentId, document);
    },
    async appendDocumentVersion({ documentId, ownerUserId, baseVersionId, source, bytes }: {
      documentId: string; ownerUserId: string; baseVersionId: string;
      source: "user" | "agent" | "system"; bytes: Buffer;
    }): Promise<AppendedDocumentDto> {
      const document = documents.get(documentId);
      if (!document || document.ownerUserId !== ownerUserId) {
        throw new DocumentAccessError(404, "DOCUMENT_NOT_FOUND", "Document not found");
      }
      const previous = document.versions.at(-1)!;
      if (previous.id !== baseVersionId) {
        throw new DocumentAccessError(409, "VERSION_CONFLICT", "Document was updated; reload the latest version before mutating");
      }
      const version: DocumentVersionDto = {
        id: randomUUID(), documentId, versionNumber: previous.versionNumber + 1,
        parentVersionId: previous.id, sizeBytes: bytes.byteLength, sha256: null,
        source, createdByUserId: ownerUserId, createdAt: new Date().toISOString(),
      };
      document.versions.push(version);
      input.store.put(version.id, new Uint8Array(bytes));
      return { document: listed(documentId, document), version };
    },
    async createBlankDocxDocument({ workspaceId, ownerUserId, name }: { workspaceId: string; ownerUserId: string; name?: string }) {
      return addDocument(input.binding.createBlankDocx(), name?.endsWith(".docx") ? name : `${name ?? "Untitled Document"}.docx`, ownerUserId, workspaceId);
    },
  } as Pick<DocumentService, "getOwnedDocument" | "appendDocumentVersion" | "createBlankDocxDocument">;

  return { service, seed(bytes: Uint8Array) { const created = addDocument(bytes, "Bench.docx", BENCH_OWNER_ID, BENCH_WORKSPACE_ID); return { documentId: created.document.id, versionId: created.version.id, format: "docx" as const }; } };
}

/**
 * Mutation executor: engine execute once → store artifact bytes → new version id.
 */
export function createBenchMutationExecutor(input: {
  readonly runtime: DocumentRuntime;
  readonly store: BenchArtifactStore;
}): DocumentMutationExecutor {
  const { runtime, store } = input;

  async function executeOnce(
    document: DocumentRef,
    type: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
    runId?: string,
  ): Promise<DocumentMutationResult> {
    if (!runtime.execute) {
      return {
        status: "error",
        code: "UNSUPPORTED_CAPABILITY",
        diagnostics: [
          {
            code: "UNSUPPORTED_CAPABILITY",
            severity: "error",
            message: "DocumentRuntime does not support execute/mutate",
          },
        ],
      };
    }

    const result = await runtime.execute(
      document,
      {
        type,
        baseVersionId: document.versionId,
        payload,
      },
      { signal, runId },
    );

    if (result.status === "error") {
      return {
        status: "error",
        code: result.code,
        diagnostics: result.diagnostics,
      };
    }

    const nextVersionId = store.nextVersionId(document.versionId);
    if (result.artifactBytes) {
      store.put(nextVersionId, result.artifactBytes);
    }

    return {
      status: "success",
      document: {
        documentId: document.documentId,
        versionId: nextVersionId,
        format: document.format,
      },
      versionNumber: 1,
      baseVersionId: document.versionId,
      ...(result.change !== undefined ? { change: result.change } : {}),
      diagnostics: result.diagnostics,
    };
  }

  return {
    async replaceText(req) {
      return executeOnce(
        req.document,
        "document.replace_text",
        {
          find: req.find,
          replace: req.replace,
          ...(req.expectedCurrentText !== undefined
            ? { expectedCurrentText: req.expectedCurrentText }
            : {}),
          ...(req.occurrence !== undefined
            ? { occurrence: req.occurrence }
            : {}),
        },
        req.signal,
        req.runId,
      );
    },
    async insertParagraph(req) {
      return executeOnce(
        req.document,
        "document.insert_paragraph",
        { text: req.text, placement: req.placement },
        req.signal,
        req.runId,
      );
    },
    async insertParagraphs(req) {
      return executeOnce(
        req.document,
        "document.insert_paragraphs",
        { texts: req.texts, placement: req.placement },
        req.signal,
        req.runId,
      );
    },
    async deleteParagraph(req) {
      return executeOnce(
        req.document,
        "document.delete_paragraph",
        { target: req.target },
        req.signal,
        req.runId,
      );
    },
    async setParagraphStyle(req) {
      return executeOnce(
        req.document,
        "document.set_paragraph_style",
        {
          target: req.target,
          ...(req.style !== undefined ? { style: req.style } : {}),
        },
        req.signal,
        req.runId,
      );
    },
    async setParagraphFormatting(req) {
      return executeOnce(
        req.document,
        "document.set_paragraph_formatting",
        {
          target: req.target,
          ...(req.alignment !== undefined ? { alignment: req.alignment } : {}),
          ...(req.spacingBeforeTwips !== undefined
            ? { spacingBeforeTwips: req.spacingBeforeTwips }
            : {}),
          ...(req.spacingAfterTwips !== undefined
            ? { spacingAfterTwips: req.spacingAfterTwips }
            : {}),
        },
        req.signal,
        req.runId,
      );
    },
    async setTextFormatting(req) {
      return executeOnce(
        req.document,
        "document.set_text_formatting",
        {
          target: req.target,
          ...(req.bold !== undefined ? { bold: req.bold } : {}),
          ...(req.italic !== undefined ? { italic: req.italic } : {}),
          ...(req.fontSizeHalfPoints !== undefined
            ? { fontSizeHalfPoints: req.fontSizeHalfPoints }
            : {}),
          ...(req.fontFamily !== undefined
            ? { fontFamily: req.fontFamily }
            : {}),
        },
        req.signal,
        req.runId,
      );
    },
    async createTable(req) {
      return executeOnce(
        req.document,
        "document.create_table",
        { rows: req.rows, placement: req.placement },
        req.signal,
        req.runId,
      );
    },
    async setTableCellsText(req) {
      return executeOnce(
        req.document,
        "document.set_table_cells_text",
        { table: req.table, updates: req.updates },
        req.signal,
        req.runId,
      );
    },
    async insertTableRows(req) {
      return executeOnce(
        req.document,
        "document.insert_table_rows",
        { table: req.table, after: req.after, rows: req.rows },
        req.signal,
        req.runId,
      );
    },
    async insertTableColumn(req) {
      return executeOnce(
        req.document,
        "document.insert_table_column",
        {
          table: req.table,
          ...(req.afterColumnHeader !== undefined
            ? { afterColumnHeader: req.afterColumnHeader }
            : {}),
          ...(req.afterColumnHandle !== undefined
            ? { afterColumnHandle: req.afterColumnHandle }
            : {}),
          header: req.header,
          cells: req.cells,
        },
        req.signal,
        req.runId,
      );
    },
    async deleteTable(req) {
      return executeOnce(
        req.document,
        "document.delete_table",
        { table: req.table },
        req.signal,
        req.runId,
      );
    },
    async deleteTableRow(req) {
      return executeOnce(
        req.document,
        "document.delete_table_row",
        { table: req.table, row: req.row },
        req.signal,
        req.runId,
      );
    },
    async deleteTableColumn(req) {
      return executeOnce(
        req.document,
        "document.delete_table_column",
        {
          table: req.table,
          ...(req.columnHeader !== undefined
            ? { columnHeader: req.columnHeader }
            : {}),
          ...(req.columnHandle !== undefined
            ? { columnHandle: req.columnHandle }
            : {}),
        },
        req.signal,
        req.runId,
      );
    },
    async setTableFormatting(req) {
      return executeOnce(
        req.document,
        "document.set_table_formatting",
        {
          table: req.table,
          ...(req.alignment !== undefined ? { alignment: req.alignment } : {}),
          ...(req.cellMarginTopTwips !== undefined
            ? { cellMarginTopTwips: req.cellMarginTopTwips }
            : {}),
          ...(req.cellMarginRightTwips !== undefined
            ? { cellMarginRightTwips: req.cellMarginRightTwips }
            : {}),
          ...(req.cellMarginBottomTwips !== undefined
            ? { cellMarginBottomTwips: req.cellMarginBottomTwips }
            : {}),
          ...(req.cellMarginLeftTwips !== undefined
            ? { cellMarginLeftTwips: req.cellMarginLeftTwips }
            : {}),
          ...(req.borders !== undefined ? { borders: req.borders } : {}),
        },
        req.signal,
        req.runId,
      );
    },
  };
}

export function createBenchCreateBlankTool(input: {
  readonly binding: DocxEngineBinding;
  readonly store: BenchArtifactStore;
}) {
  return createFakeTool({
    name: WORKSPACE_TOOL_NAMES.createBlankDocx,
    description:
      "Create a new blank DOCX. Call ALONE as the first action for a NEW document " +
      "(no inspect/inserts in that turn). Author on the next turn.",
    risk: "safe" as const,
    effect: "write" as const,
    executionMode: "sequential" as const,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
      },
    },
    parseInput(raw: unknown): { name?: string } {
      if (raw == null) return {};
      if (typeof raw !== "object" || Array.isArray(raw)) return {};
      const name = (raw as { name?: unknown }).name;
      return typeof name === "string" && name.trim()
        ? { name: name.trim() }
        : {};
    },
    async execute(args: { name?: string }, ctx: ToolExecutionContext) {
      const documentId = randomUUID();
      const versionId = randomUUID();
      const bytes = input.binding.createBlankDocx();
      input.store.put(versionId, bytes);
      const document: DocumentRef = {
        documentId,
        versionId,
        format: "docx",
      };
      ctx.advancePrimaryDocument?.(document);
      await ctx.events.emit({
        type: "document.created",
        runId: ctx.runId,
        documentId,
        versionId,
        name: args.name ?? "Untitled Document.docx",
        format: "docx",
        at: new Date().toISOString(),
      });
      return {
        document: {
          documentId,
          versionId,
          format: "docx" as const,
          name: args.name ?? "Untitled Document.docx",
          versionNumber: 1,
        },
      };
    },
  });
}

export interface BenchHarness {
  readonly binding: DocxEngineBinding;
  readonly store: BenchArtifactStore;
  readonly runtime: DocumentRuntime;
  readonly mutations: DocumentMutationExecutor;
  seedDocument(bytes: Uint8Array): DocumentRef;
  run(input: {
    readonly model: AgentModel;
    readonly instruction: string;
    readonly primaryDocument?: DocumentRef | null;
    readonly runId?: string;
    readonly maxTurns?: number;
  }): Promise<{
    readonly result: AgentResult;
    readonly events: ReturnType<typeof createRecordingEventSink>["events"];
    readonly totalPersistMs: number;
    readonly document: DocumentRef | null;
  }>;
}

function finalDocument(
  initial: DocumentRef | null | undefined,
  events: readonly ReturnType<typeof createRecordingEventSink>["events"][number][],
): DocumentRef | null {
  const latestVersion = [...events].reverse().find((event) => event.type === "document.version.advanced");
  if (latestVersion) {
    return { documentId: latestVersion.documentId, versionId: latestVersion.versionId, format: initial?.format ?? "docx" };
  }
  const created = [...events].reverse().find((event) => event.type === "document.created");
  if (created?.format === "docx") {
    return { documentId: created.documentId, versionId: created.versionId, format: "docx" };
  }
  return initial ?? null;
}

export async function createBenchHarness(): Promise<BenchHarness> {
  const binding = await createNapiDocxEngineBinding();
  const store = createBenchArtifactStore();
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: store.loader,
    binding,
  });
  const mutations = createBenchMutationExecutor({ runtime, store });
  const createTool = createBenchCreateBlankTool({ binding, store });

  return {
    binding,
    store,
    runtime,
    mutations,
    seedDocument(bytes) {
      const documentId = randomUUID();
      const versionId = randomUUID();
      store.put(versionId, bytes);
      return { documentId, versionId, format: "docx" };
    },
    async run(input) {
      store.resetPersistMs();
      const sink = createRecordingEventSink();
      const runner = new AgentRunner({
        model: input.model,
        ...createDocumentAgentRunnerOptions({
          tools: ToolRegistry.create([createTool]),
          documentToolCatalog: listDocumentToolDescriptors(),
          runtime,
          mutations,
          primaryDocument: input.primaryDocument ?? null,
        }),
        events: sink,
        maxTurns: input.maxTurns ?? 20,
      });

      const result = await runner.run({
        instruction: input.instruction,
        threadId: "bench-thread",
        runId: input.runId ?? `bench-${randomUUID()}`,
        ...(input.primaryDocument
          ? { primaryDocument: input.primaryDocument }
          : {}),
      });

      return {
        result,
        events: sink.events,
        totalPersistMs: store.totalPersistMs,
        document: finalDocument(input.primaryDocument, sink.events),
      };
    },
  };
}

/**
 * Zero-cost benchmark assembly using the same document executor and
 * formatting lifecycle as production, backed by the in-memory version store.
 */
export async function createProductionBenchHarness(): Promise<BenchHarness> {
  const binding = await createNapiDocxEngineBinding();
  const store = createBenchArtifactStore();
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: store.loader,
    binding,
  });
  const documents = createBenchDocumentService({ binding, store });
  const mutations = createAgentDocumentMutationExecutor({
    documents: documents.service,
    ownerUserId: BENCH_OWNER_ID,
    runtime,
  });
  const createTool = createWorkspaceCreateBlankDocxTool({
    workspaceId: BENCH_WORKSPACE_ID,
    ownerUserId: BENCH_OWNER_ID,
    documents: documents.service,
  });

  return {
    binding,
    store,
    runtime,
    mutations,
    seedDocument: documents.seed,
    async run(input) {
      store.resetPersistMs();
      const sink = createRecordingEventSink();
      const runner = new AgentRunner({
        model: input.model,
        ...createDocumentAgentRunnerOptions({
          tools: ToolRegistry.create([createTool]),
          documentToolCatalog: listDocumentToolDescriptors(),
          runtime,
          mutations,
          primaryDocument: input.primaryDocument ?? null,
        }),
        events: sink,
        maxTurns: input.maxTurns ?? 20,
      });
      const result = await runner.run({
        instruction: input.instruction,
        threadId: "bench-thread",
        runId: input.runId ?? `bench-${randomUUID()}`,
        ...(input.primaryDocument ? { primaryDocument: input.primaryDocument } : {}),
      });
      return {
        result,
        events: sink.events,
        totalPersistMs: store.totalPersistMs,
        document: finalDocument(input.primaryDocument, sink.events),
      };
    },
  };
}
