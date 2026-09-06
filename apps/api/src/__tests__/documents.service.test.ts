import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Db } from "@opensuite/db";

import {
  contentDispositionForDocument,
  normalizeDocumentRenameName,
} from "../documents/format.js";
import {
  createDocumentService,
  DocumentAccessError,
  DocumentUploadError,
} from "../documents/service.js";
import { buildDocumentVersionStorageKey } from "../documents/storage-key.js";
import {
  createMemoryObjectStorage,
  ObjectNotFoundError,
} from "../storage/index.js";

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

test("contentDispositionForDocument quotes a safe attachment filename", () => {
  const header = contentDispositionForDocument("Q1 Report.docx", "docx");
  assert.match(header, /^attachment;/);
  assert.match(header, /filename="Q1 Report.docx"/);
  assert.match(header, /filename\*=UTF-8''Q1%20Report\.docx/);
});

test("normalizeDocumentRenameName preserves format and rejects cross-format names", () => {
  assert.equal(normalizeDocumentRenameName("  Brief  ", "docx"), "Brief.docx");
  assert.equal(
    normalizeDocumentRenameName("Brief.docx", "docx"),
    "Brief.docx",
  );
  assert.equal(normalizeDocumentRenameName("Brief.pptx", "docx"), null);
  assert.equal(normalizeDocumentRenameName("Brief.pdf", "docx"), null);
  assert.equal(normalizeDocumentRenameName("", "docx"), null);
});

test("memory storage getObject streams stored bytes and throws ObjectNotFoundError", async () => {
  const storage = createMemoryObjectStorage();
  await storage.putObject({
    key: "a.docx",
    body: Buffer.from("hello"),
    contentType: "application/octet-stream",
  });

  const found = await storage.getObject("a.docx");
  const chunks: Buffer[] = [];
  for await (const chunk of found.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  assert.equal(Buffer.concat(chunks).toString("utf8"), "hello");
  assert.equal(found.contentLength, 5);

  await assert.rejects(
    () => storage.getObject("missing"),
    (error: unknown) => error instanceof ObjectNotFoundError,
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

test("missing storage object maps to STORAGE_OBJECT_MISSING without leaking provider errors", async () => {
  const documentId = randomUUID();
  const versionId = randomUUID();
  const storageKey = "workspaces/ws/documents/doc/versions/v/content.docx";
  const storage = createMemoryObjectStorage();

  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({
              orderBy: () => ({
                limit: async () => [
                  {
                    documentId,
                    name: "brief.docx",
                    format: "docx",
                    versionId,
                    versionNumber: 1,
                    sizeBytes: 12,
                    storageKey,
                  },
                ],
              }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Db;

  const logged: Array<{ storageKey: string }> = [];
  const documents = createDocumentService(db, storage, {
    uploadMaxBytes: 1024,
    onMissingStorageObject: (details) => {
      logged.push({ storageKey: details.storageKey });
    },
  });

  await assert.rejects(
    () =>
      documents.openLatestDownload({
        documentId,
        ownerUserId: "user-1",
      }),
    (error: unknown) =>
      error instanceof DocumentAccessError &&
      error.code === "STORAGE_OBJECT_MISSING" &&
      error.statusCode === 500 &&
      !error.message.toLowerCase().includes("nosuchkey") &&
      !error.message.toLowerCase().includes("minio"),
  );

  assert.deepEqual(logged, [{ storageKey }]);
});

test("append DB failure after storage upload deletes the uploaded object", async () => {
  const documentId = randomUUID();
  const workspaceId = randomUUID();
  const baseVersionId = randomUUID();
  const storage = createMemoryObjectStorage();

  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [
              {
                id: documentId,
                workspaceId,
                name: "brief.docx",
                format: "docx",
              },
            ],
          }),
        }),
      }),
    }),
    transaction: async () => {
      throw new Error("forced db failure");
    },
  } as unknown as Db;

  const documents = createDocumentService(db, storage, {
    uploadMaxBytes: 1024,
  });

  await assert.rejects(() =>
    documents.appendDocumentVersion({
      documentId,
      ownerUserId: "user-1",
      baseVersionId,
      source: "user",
      bytes: Buffer.from("PK next version"),
    }),
  );

  assert.equal(storage.objects.size, 0);
});

test("append rejects empty bytes before touching storage", async () => {
  const storage = createMemoryObjectStorage();
  let selects = 0;
  const db = {
    select: () => {
      selects += 1;
      throw new Error("should not query");
    },
  } as unknown as Db;

  const documents = createDocumentService(db, storage, {
    uploadMaxBytes: 1024,
  });

  await assert.rejects(
    () =>
      documents.appendDocumentVersion({
        documentId: randomUUID(),
        ownerUserId: "user-1",
        baseVersionId: randomUUID(),
        source: "user",
        bytes: Buffer.alloc(0),
      }),
    (error: unknown) =>
      error instanceof DocumentUploadError && error.code === "EMPTY_UPLOAD",
  );

  assert.equal(selects, 0);
  assert.equal(storage.objects.size, 0);
});
