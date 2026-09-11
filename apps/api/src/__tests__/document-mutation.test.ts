import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type {
  DocumentOperation,
  DocumentRef,
  DocumentRuntime,
  OperationResult,
} from "@opensuite/agent-core";
import { buildMinimalDocx } from "@opensuite/engine-client";

import { createDocumentMutationService } from "../documents/mutation.js";
import {
  DocumentAccessError,
  type AppendedDocumentDto,
  type DocumentService,
  type ListedDocumentDto,
} from "../documents/service.js";
import { createMemoryObjectStorage } from "../storage/index.js";

function listedDoc(overrides: {
  id: string;
  latestVersionId: string;
  format?: "docx" | "pptx" | "xlsx";
}): ListedDocumentDto {
  return {
    id: overrides.id,
    workspaceId: randomUUID(),
    name: "Memo.docx",
    format: overrides.format ?? "docx",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    latestVersion: {
      id: overrides.latestVersionId,
      versionNumber: 1,
      sizeBytes: 10,
      source: "upload",
      createdAt: new Date().toISOString(),
    },
  };
}

function createFakeRuntime(
  execute: (
    document: DocumentRef,
    operation: DocumentOperation,
  ) => Promise<OperationResult>,
): DocumentRuntime {
  return {
    capabilities() {
      return { ids: new Set(["document.mutate"]) };
    },
    async inspect() {
      return {
        status: "error",
        diagnostics: [
          {
            code: "UNSUPPORTED_CAPABILITY",
            severity: "error",
            message: "inspect unsupported in fake",
          },
        ],
      };
    },
    execute,
  };
}

test("successful mutation persists agent version N+1 from artifactBytes", async () => {
  const documentId = randomUUID();
  const baseVersionId = randomUUID();
  const nextVersionId = randomUUID();
  const outputBytes = buildMinimalDocx(["replaced"]);
  const storage = createMemoryObjectStorage();
  const appendCalls: Array<{
    baseVersionId: string;
    source: string;
    bytes: Buffer;
  }> = [];

  const documents = {
    async getOwnedDocument() {
      return listedDoc({ id: documentId, latestVersionId: baseVersionId });
    },
    async appendDocumentVersion(input: {
      documentId: string;
      ownerUserId: string;
      baseVersionId: string;
      source: "user" | "agent" | "system";
      bytes: Buffer;
    }): Promise<AppendedDocumentDto> {
      appendCalls.push({
        baseVersionId: input.baseVersionId,
        source: input.source,
        bytes: input.bytes,
      });
      await storage.putObject({
        key: `next/${nextVersionId}`,
        body: input.bytes,
        contentType: "application/octet-stream",
      });
      return {
        document: {
          ...listedDoc({
            id: documentId,
            latestVersionId: nextVersionId,
          }),
          latestVersion: {
            id: nextVersionId,
            versionNumber: 2,
            sizeBytes: input.bytes.byteLength,
            source: "agent",
            createdAt: new Date().toISOString(),
          },
        },
        version: {
          id: nextVersionId,
          documentId,
          versionNumber: 2,
          parentVersionId: baseVersionId,
          sizeBytes: input.bytes.byteLength,
          sha256: "abc",
          source: "agent",
          createdByUserId: input.ownerUserId,
          createdAt: new Date().toISOString(),
        },
      };
    },
  } as Pick<DocumentService, "getOwnedDocument" | "appendDocumentVersion">;

  const runtime = createFakeRuntime(async () => ({
    status: "success",
    diagnostics: [],
    change: {
      operation: "document.replace_text",
      area: "text_replaced",
      before: "old text",
      after: "replaced",
    },
    artifactBytes: outputBytes,
  }));

  const mutations = createDocumentMutationService(documents);
  const result = await mutations.applyReplaceText({
    documentId,
    ownerUserId: "user-1",
    baseVersionId,
    find: "old text",
    replace: "replaced",
    runtime,
  });

  assert.equal(result.status, "success");
  if (result.status !== "success") return;
  assert.equal(result.version.id, nextVersionId);
  assert.equal(result.version.versionNumber, 2);
  assert.equal(result.version.parentVersionId, baseVersionId);
  assert.equal(result.version.source, "agent");
  assert.equal(result.change?.after, "replaced");
  assert.equal(appendCalls.length, 1);
  assert.equal(appendCalls[0]!.source, "agent");
  assert.deepEqual(appendCalls[0]!.bytes, outputBytes);
  assert.equal(storage.objects.size, 1);
});

test("runtime TARGET_NOT_FOUND does not upload or append", async () => {
  let appendCalls = 0;
  const documents = {
    async getOwnedDocument() {
      return listedDoc({
        id: "doc-1",
        latestVersionId: "ver-1",
      });
    },
    async appendDocumentVersion() {
      appendCalls += 1;
      throw new Error("should not append");
    },
  } as Pick<DocumentService, "getOwnedDocument" | "appendDocumentVersion">;

  const runtime = createFakeRuntime(async () => ({
    status: "error",
    code: "TARGET_NOT_FOUND",
    diagnostics: [
      {
        code: "TARGET_NOT_FOUND",
        severity: "error",
        message: "missing",
      },
    ],
  }));

  const mutations = createDocumentMutationService(documents);
  const result = await mutations.applyReplaceText({
    documentId: "doc-1",
    ownerUserId: "user-1",
    baseVersionId: "ver-1",
    find: "missing",
    replace: "x",
    runtime,
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "TARGET_NOT_FOUND");
  }
  assert.equal(appendCalls, 0);
});

test("success without artifactBytes does not persist", async () => {
  let appendCalls = 0;
  const documents = {
    async getOwnedDocument() {
      return listedDoc({ id: "doc-1", latestVersionId: "ver-1" });
    },
    async appendDocumentVersion() {
      appendCalls += 1;
      throw new Error("should not append");
    },
  } as Pick<DocumentService, "getOwnedDocument" | "appendDocumentVersion">;

  const runtime = createFakeRuntime(async () => ({
    status: "success",
    diagnostics: [],
  }));

  const mutations = createDocumentMutationService(documents);
  const result = await mutations.applyReplaceText({
    documentId: "doc-1",
    ownerUserId: "user-1",
    baseVersionId: "ver-1",
    find: "a",
    replace: "b",
    runtime,
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "RUNTIME_MISSING_ARTIFACT");
  }
  assert.equal(appendCalls, 0);
});

test("stale base version before execute returns VERSION_CONFLICT", async () => {
  let executeCalls = 0;
  const documents = {
    async getOwnedDocument() {
      return listedDoc({ id: "doc-1", latestVersionId: "ver-2" });
    },
    async appendDocumentVersion() {
      throw new Error("should not append");
    },
  } as Pick<DocumentService, "getOwnedDocument" | "appendDocumentVersion">;

  const runtime = createFakeRuntime(async () => {
    executeCalls += 1;
    return { status: "success", diagnostics: [], artifactBytes: Buffer.from("x") };
  });

  const mutations = createDocumentMutationService(documents);
  const result = await mutations.applyReplaceText({
    documentId: "doc-1",
    ownerUserId: "user-1",
    baseVersionId: "ver-1",
    find: "a",
    replace: "b",
    runtime,
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "VERSION_CONFLICT");
    assert.equal(result.statusCode, 409);
  }
  assert.equal(executeCalls, 0);
});

test("VERSION_CONFLICT from append after successful runtime is returned", async () => {
  const outputBytes = buildMinimalDocx(["stale-output"]);
  let cleanedViaAppend = false;

  const documents = {
    async getOwnedDocument() {
      return listedDoc({ id: "doc-1", latestVersionId: "ver-1" });
    },
    async appendDocumentVersion() {
      cleanedViaAppend = true;
      throw new DocumentAccessError(
        409,
        "VERSION_CONFLICT",
        "Document was updated; reload the latest version before saving",
      );
    },
  } as Pick<DocumentService, "getOwnedDocument" | "appendDocumentVersion">;

  const runtime = createFakeRuntime(async () => ({
    status: "success",
    diagnostics: [],
    artifactBytes: outputBytes,
  }));

  const mutations = createDocumentMutationService(documents);
  const result = await mutations.applyReplaceText({
    documentId: "doc-1",
    ownerUserId: "user-1",
    baseVersionId: "ver-1",
    find: "a",
    replace: "b",
    runtime,
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "VERSION_CONFLICT");
  }
  assert.equal(cleanedViaAppend, true);
});

test("upload failure from append surfaces without inventing a version", async () => {
  const documents = {
    async getOwnedDocument() {
      return listedDoc({ id: "doc-1", latestVersionId: "ver-1" });
    },
    async appendDocumentVersion() {
      throw new Error("memory storage putObject forced failure");
    },
  } as Pick<DocumentService, "getOwnedDocument" | "appendDocumentVersion">;

  const runtime = createFakeRuntime(async () => ({
    status: "success",
    diagnostics: [],
    artifactBytes: buildMinimalDocx(["x"]),
  }));

  const mutations = createDocumentMutationService(documents);
  await assert.rejects(() =>
    mutations.applyReplaceText({
      documentId: "doc-1",
      ownerUserId: "user-1",
      baseVersionId: "ver-1",
      find: "a",
      replace: "b",
      runtime,
    }),
  );
});

test("applySetTableCellsText reuses persist lifecycle once", async () => {
  const documentId = randomUUID();
  const baseVersionId = randomUUID();
  const nextVersionId = randomUUID();
  const outputBytes = buildMinimalDocx(["cells"]);
  let executeCount = 0;
  const appendCalls: string[] = [];

  const documents = {
    async getOwnedDocument() {
      return listedDoc({ id: documentId, latestVersionId: baseVersionId });
    },
    async appendDocumentVersion(input: {
      baseVersionId: string;
      source: "user" | "agent" | "system";
      bytes: Buffer;
    }): Promise<AppendedDocumentDto> {
      appendCalls.push(input.baseVersionId);
      return {
        document: listedDoc({
          id: documentId,
          latestVersionId: nextVersionId,
        }),
        version: {
          id: nextVersionId,
          documentId,
          versionNumber: 2,
          parentVersionId: baseVersionId,
          sizeBytes: input.bytes.byteLength,
          sha256: "abc",
          source: input.source,
          createdByUserId: "user-1",
          createdAt: new Date().toISOString(),
        },
      };
    },
  } as Pick<DocumentService, "getOwnedDocument" | "appendDocumentVersion">;

  const runtime = createFakeRuntime(async (_doc, operation) => {
    executeCount += 1;
    assert.equal(operation.type, "document.set_table_cells_text");
    return {
      status: "success",
      diagnostics: [],
      change: {
        operation: "document.set_table_cells_text",
        area: "table",
        before: "CEO",
        after: "Founder & CEO",
      },
      artifactBytes: outputBytes,
    };
  });

  const mutations = createDocumentMutationService(documents);
  const result = await mutations.applySetTableCellsText({
    documentId,
    ownerUserId: "user-1",
    baseVersionId,
    table: { headerCells: ["Name", "Role"] },
    updates: [
      {
        target: {
          rowLabel: "Alice",
          columnHeader: "Role",
        },
        expectedCurrentText: "CEO",
        replacement: "Founder & CEO",
      },
    ],
    runtime,
  });

  assert.equal(result.status, "success");
  assert.equal(executeCount, 1);
  assert.deepEqual(appendCalls, [baseVersionId]);
});

test("applyInsertTableRows and applyInsertTableColumn persist once each", async () => {
  const documentId = randomUUID();
  let latest = randomUUID();
  let versionNumber = 1;
  const executeTypes: string[] = [];

  const documents = {
    async getOwnedDocument() {
      return listedDoc({ id: documentId, latestVersionId: latest });
    },
    async appendDocumentVersion(input: {
      baseVersionId: string;
      source: "user" | "agent" | "system";
      bytes: Buffer;
    }): Promise<AppendedDocumentDto> {
      assert.equal(input.baseVersionId, latest);
      const parent = latest;
      latest = randomUUID();
      versionNumber += 1;
      return {
        document: listedDoc({ id: documentId, latestVersionId: latest }),
        version: {
          id: latest,
          documentId,
          versionNumber,
          parentVersionId: parent,
          sizeBytes: input.bytes.byteLength,
          sha256: "abc",
          source: input.source,
          createdByUserId: "user-1",
          createdAt: new Date().toISOString(),
        },
      };
    },
  } as Pick<DocumentService, "getOwnedDocument" | "appendDocumentVersion">;

  const runtime = createFakeRuntime(async (_doc, operation) => {
    executeTypes.push(operation.type);
    return {
      status: "success",
      diagnostics: [],
      artifactBytes: buildMinimalDocx([operation.type]),
    };
  });

  const mutations = createDocumentMutationService(documents);
  const baseA = latest;
  const rows = await mutations.applyInsertTableRows({
    documentId,
    ownerUserId: "user-1",
    baseVersionId: baseA,
    table: { headerCells: ["Name", "Role"] },
    after: { firstCellText: "Bob" },
    rows: [["Charlie", "CFO"]],
    runtime,
  });
  assert.equal(rows.status, "success");

  const baseB = latest;
  const column = await mutations.applyInsertTableColumn({
    documentId,
    ownerUserId: "user-1",
    baseVersionId: baseB,
    table: { headerCells: ["Name", "Role"] },
    afterColumnHeader: "Role",
    header: "Location",
    cells: ["NY"],
    runtime,
  });
  assert.equal(column.status, "success");
  assert.deepEqual(executeTypes, [
    "document.insert_table_rows",
    "document.insert_table_column",
  ]);
});

test("table mutation engine failure does not append a version", async () => {
  const documentId = randomUUID();
  const baseVersionId = randomUUID();
  let appendCount = 0;
  const documents = {
    async getOwnedDocument() {
      return listedDoc({ id: documentId, latestVersionId: baseVersionId });
    },
    async appendDocumentVersion(): Promise<AppendedDocumentDto> {
      appendCount += 1;
      throw new Error("should not append");
    },
  } as Pick<DocumentService, "getOwnedDocument" | "appendDocumentVersion">;

  const runtime = createFakeRuntime(async () => ({
    status: "error",
    code: "UNSUPPORTED_OPERATION",
    diagnostics: [
      {
        code: "UNSUPPORTED_OPERATION",
        severity: "error",
        message: "merged table",
      },
    ],
  }));

  const mutations = createDocumentMutationService(documents);
  const result = await mutations.applyInsertTableColumn({
    documentId,
    ownerUserId: "user-1",
    baseVersionId,
    table: { headerCells: ["Name", "Role"] },
    afterColumnHeader: "Role",
    header: "Location",
    cells: ["A", "B"],
    runtime,
  });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "UNSUPPORTED_OPERATION");
  }
  assert.equal(appendCount, 0);
});

test("table widths persist through the generic table mutation path", async () => {
  const documentId = randomUUID();
  const baseVersionId = randomUUID();
  let appended = 0;
  const documents = {
    async getOwnedDocument() { return listedDoc({ id: documentId, latestVersionId: baseVersionId }); },
    async appendDocumentVersion(input: { baseVersionId: string; source: "user" | "agent" | "system"; bytes: Buffer }): Promise<AppendedDocumentDto> {
      appended += 1;
      return { document: listedDoc({ id: documentId, latestVersionId: "v2" }), version: { id: "v2", documentId, versionNumber: 2, parentVersionId: input.baseVersionId, sizeBytes: input.bytes.length, sha256: "hash", source: input.source, createdByUserId: "user-1", createdAt: new Date().toISOString() } };
    },
  } as Pick<DocumentService, "getOwnedDocument" | "appendDocumentVersion">;
  const runtime = createFakeRuntime(async (_document, operation) => {
    assert.equal(operation.type, "document.set_table_column_widths");
    return { status: "success", diagnostics: [], artifactBytes: buildMinimalDocx(["widths"]) };
  });
  const result = await createDocumentMutationService(documents).applyOperation({ documentId, ownerUserId: "user-1", baseVersionId, runtime, type: "document.set_table_column_widths", payload: { table: { handle: "t0" }, widthsTwips: [1440, 2880] } });
  assert.equal(result.status, "success");
  assert.equal(appended, 1);
});

test("table shading diagnostics prevent persistence", async () => {
  const documentId = randomUUID();
  const baseVersionId = randomUUID();
  let appended = 0;
  const documents = {
    async getOwnedDocument() { return listedDoc({ id: documentId, latestVersionId: baseVersionId }); },
    async appendDocumentVersion(): Promise<AppendedDocumentDto> { appended += 1; throw new Error("must not append"); },
  } as Pick<DocumentService, "getOwnedDocument" | "appendDocumentVersion">;
  const runtime = createFakeRuntime(async () => ({ status: "error", code: "VALIDATION_FAILED", diagnostics: [{ code: "VALIDATION_FAILED", severity: "error", message: "invalid fill", reasonCode: "INVALID_COLOR" }] }));
  const result = await createDocumentMutationService(documents).applyOperation({ documentId, ownerUserId: "user-1", baseVersionId, runtime, type: "document.set_table_cell_shading", payload: { table: { handle: "t0" }, updates: [{ target: { handle: "c0" }, fill: "invalid" }] } });
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.diagnostics[0].reasonCode, "INVALID_COLOR");
  assert.equal(appended, 0);
});
