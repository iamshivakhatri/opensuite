import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Db } from "@opensuite/db";

import {
  createDocumentService,
  DocumentUploadError,
} from "../documents/service.js";
import { buildDocumentVersionStorageKey } from "../documents/storage-key.js";
import { createMemoryObjectStorage } from "../storage/index.js";

test("buildDocumentVersionStorageKey uses stable path segments and format extension", () => {
  const key = buildDocumentVersionStorageKey({
    workspaceId: "ws-1",
    documentId: "doc-1",
    versionId: "ver-1",
    format: "docx",
  });
  assert.equal(
    key,
    "workspaces/ws-1/documents/doc-1/versions/ver-1/content.docx",
  );
});

test("upload rejects unsupported file types before touching storage", async () => {
  const storage = createMemoryObjectStorage();
  let transactions = 0;
  const db = {
    transaction: async () => {
      transactions += 1;
      throw new Error("should not run");
    },
  } as unknown as Db;

  const documents = createDocumentService(db, storage, {
    uploadMaxBytes: 1024,
  });

  await assert.rejects(
    () =>
      documents.uploadOfficeDocument({
        workspaceId: randomUUID(),
        ownerUserId: "user-1",
        filename: "notes.pdf",
        bytes: Buffer.from("%PDF-1.4"),
      }),
    (error: unknown) =>
      error instanceof DocumentUploadError &&
      error.code === "UNSUPPORTED_FORMAT",
  );

  assert.equal(storage.objects.size, 0);
  assert.equal(transactions, 0);
});

test("storage put failure creates no DB transaction and leaves no objects", async () => {
  const storage = createMemoryObjectStorage({ failPuts: true });
  let transactions = 0;
  const db = {
    transaction: async () => {
      transactions += 1;
      throw new Error("should not run");
    },
  } as unknown as Db;

  const documents = createDocumentService(db, storage, {
    uploadMaxBytes: 1024,
  });

  await assert.rejects(() =>
    documents.uploadOfficeDocument({
      workspaceId: randomUUID(),
      ownerUserId: "user-1",
      filename: "brief.docx",
      bytes: Buffer.from("PK fake zip"),
    }),
  );

  assert.equal(transactions, 0);
  assert.equal(storage.objects.size, 0);
});

test("DB failure after storage upload deletes the uploaded object", async () => {
  const storage = createMemoryObjectStorage();
  const db = {
    transaction: async () => {
      throw new Error("forced db failure");
    },
  } as unknown as Db;

  const cleanupFailures: string[] = [];
  const documents = createDocumentService(db, storage, {
    uploadMaxBytes: 1024,
    onCleanupFailure: (_error, key) => {
      cleanupFailures.push(key);
    },
  });

  await assert.rejects(() =>
    documents.uploadOfficeDocument({
      workspaceId: randomUUID(),
      ownerUserId: "user-1",
      filename: "brief.docx",
      bytes: Buffer.from("PK fake zip"),
    }),
  );

  assert.equal(storage.objects.size, 0);
  assert.deepEqual(cleanupFailures, []);
});
