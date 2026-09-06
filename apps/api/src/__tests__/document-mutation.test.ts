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
