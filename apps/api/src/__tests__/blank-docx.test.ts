import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Db } from "@opensuite/db";

import {
  createDocumentService,
  DocumentUploadError,
} from "../documents/service.js";
import { createMemoryObjectStorage } from "../storage/index.js";

test("createBlankDocxDocument requires configured Rust byte factory", async () => {
  const storage = createMemoryObjectStorage();
  const documents = createDocumentService(
    {
      transaction: async () => {
        throw new Error("should not run");
      },
    } as unknown as Db,
    storage,
    { uploadMaxBytes: 1024 },
  );

  await assert.rejects(
    () =>
      documents.createBlankDocxDocument({
        workspaceId: randomUUID(),
        ownerUserId: "user-1",
      }),
    (error: unknown) =>
      error instanceof DocumentUploadError &&
      error.code === "BLANK_DOCX_UNAVAILABLE",
  );
});

test("createBlankDocxDocument rejects empty factory bytes before DB", async () => {
  const storage = createMemoryObjectStorage();
  const documents = createDocumentService(
    {
      transaction: async () => {
        throw new Error("db not needed for empty check");
      },
    } as unknown as Db,
    storage,
    {
      uploadMaxBytes: 1024,
      createBlankDocxBytes: () => new Uint8Array(0),
    },
  );

  await assert.rejects(
    () =>
      documents.createBlankDocxDocument({
        workspaceId: randomUUID(),
        ownerUserId: "user-1",
      }),
    (error: unknown) =>
      error instanceof DocumentUploadError && error.code === "EMPTY_UPLOAD",
  );
  assert.equal(storage.objects.size, 0);
});

test("createBlankDocxDocument stores Rust bytes as Version 1 with source user", async () => {
  const workspaceId = randomUUID();
  const sentinel = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xaa, 0xbb]);
  const storage = createMemoryObjectStorage();
  let insertedVersion: {
    versionNumber: number;
    source: string;
    sizeBytes: number;
  } | null = null;

  const db = {
    transaction: async (
      fn: (tx: {
        insert: (table: unknown) => {
          values: (values: Record<string, unknown>) => {
            returning: (cols: unknown) => Promise<unknown[]>;
          };
        };
        update: () => {
          set: () => {
            where: () => Promise<void>;
          };
        };
      }) => Promise<unknown>,
    ) => {
      const tx = {
        insert: (_table: unknown) => ({
          values: (values: Record<string, unknown>) => ({
            returning: async () => {
              if ("versionNumber" in values) {
                insertedVersion = {
                  versionNumber: values.versionNumber as number,
                  source: values.source as string,
                  sizeBytes: values.sizeBytes as number,
                };
                return [
                  {
                    id: values.id,
                    documentId: values.documentId,
                    versionNumber: values.versionNumber,
                    parentVersionId: null,
                    sizeBytes: values.sizeBytes,
                    sha256: values.sha256,
                    source: values.source,
                    createdByUserId: values.createdByUserId,
                    createdAt: new Date(),
                  },
                ];
              }
              return [
                {
                  id: values.id,
                  workspaceId: values.workspaceId,
                  name: values.name,
                  format: values.format,
                  createdAt: new Date(),
                  updatedAt: new Date(),
                },
              ];
            },
          }),
        }),
        update: () => ({
          set: () => ({
            where: async () => undefined,
          }),
        }),
      };
      return fn(tx);
    },
  } as unknown as Db;

  const documents = createDocumentService(db, storage, {
    uploadMaxBytes: 1024,
    createBlankDocxBytes: () => new Uint8Array(sentinel),
  });

  const created = await documents.createBlankDocxDocument({
    workspaceId,
    ownerUserId: "user-1",
    name: "Board Report",
  });

  assert.equal(created.document.format, "docx");
  assert.equal(created.document.name, "Board Report.docx");
  assert.equal(created.version.versionNumber, 1);
  assert.equal(created.version.source, "user");
  assert.equal(created.version.sizeBytes, sentinel.byteLength);
  assert.deepEqual(insertedVersion, {
    versionNumber: 1,
    source: "user",
    sizeBytes: sentinel.byteLength,
  });
  assert.equal(storage.objects.size, 1);
  const stored = [...storage.objects.values()][0];
  assert.ok(stored);
  assert.deepEqual(Buffer.from(stored.body), sentinel);
});
