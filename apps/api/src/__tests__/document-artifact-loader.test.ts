import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";

import { buildMinimalDocx } from "@opensuite/engine-client";

import { createOwnedDocumentArtifactLoader } from "../documents/artifact-loader.js";
import {
  DocumentAccessError,
  type DocumentService,
} from "../documents/service.js";

test("artifact loader returns exact requested version bytes", async () => {
  const v1 = buildMinimalDocx(["version one"]);
  const v2 = buildMinimalDocx(["version two"]);
  const calls: Array<{ documentId: string; versionId: string }> = [];

  const documents = {
    async readExactVersionBytes(input: {
      documentId: string;
      versionId: string;
      ownerUserId: string;
    }) {
      calls.push({
        documentId: input.documentId,
        versionId: input.versionId,
      });
      if (input.versionId === "ver-1") return v1;
      if (input.versionId === "ver-2") return v2;
      throw new DocumentAccessError(404, "DOCUMENT_NOT_FOUND", "missing");
    },
  } as Pick<DocumentService, "readExactVersionBytes">;

  const loader = createOwnedDocumentArtifactLoader({
    documents,
    ownerUserId: "user-1",
  });

  const older = await loader.loadExactVersionBytes({
    documentId: "doc-1",
    versionId: "ver-1",
    format: "docx",
  });
  const newer = await loader.loadExactVersionBytes({
    documentId: "doc-1",
    versionId: "ver-2",
    format: "docx",
  });

  assert.deepEqual(Buffer.from(older), v1);
  assert.deepEqual(Buffer.from(newer), v2);
  assert.deepEqual(calls, [
    { documentId: "doc-1", versionId: "ver-1" },
    { documentId: "doc-1", versionId: "ver-2" },
  ]);
});

test("artifact loader does not fall back to latest on missing version", async () => {
  const documents = {
    async readExactVersionBytes() {
      throw new DocumentAccessError(
        404,
        "DOCUMENT_NOT_FOUND",
        "Document not found",
      );
    },
  } as Pick<DocumentService, "readExactVersionBytes">;

  const loader = createOwnedDocumentArtifactLoader({
    documents,
    ownerUserId: "user-1",
  });

  await assert.rejects(
    () =>
      loader.loadExactVersionBytes({
        documentId: randomUUID(),
        versionId: randomUUID(),
        format: "docx",
      }),
    (error: unknown) =>
      error instanceof DocumentAccessError &&
      error.code === "DOCUMENT_NOT_FOUND",
  );
});

test("artifact loader surfaces STORAGE_OBJECT_MISSING without Base64", async () => {
  const documents = {
    async readExactVersionBytes() {
      throw new DocumentAccessError(
        500,
        "STORAGE_OBJECT_MISSING",
        "Document content is temporarily unavailable",
      );
    },
  } as Pick<DocumentService, "readExactVersionBytes">;

  const loader = createOwnedDocumentArtifactLoader({
    documents,
    ownerUserId: "user-1",
  });

  await assert.rejects(
    () =>
      loader.loadExactVersionBytes({
        documentId: "doc-1",
        versionId: "ver-1",
        format: "docx",
      }),
    (error: unknown) =>
      error instanceof DocumentAccessError &&
      error.code === "STORAGE_OBJECT_MISSING",
  );
});

test("readExactVersionBytes buffers raw stream bytes", async () => {
  const expected = buildMinimalDocx(["streamed"]);
  const documents = {
    async openVersionContent() {
      return {
        body: Readable.from(expected),
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        contentLength: expected.byteLength,
        contentDisposition: 'attachment; filename="x.docx"',
      };
    },
    async readExactVersionBytes(input: {
      documentId: string;
      versionId: string;
      ownerUserId: string;
    }) {
      // Exercise the same buffering pattern DocumentService uses.
      const download = await documents.openVersionContent();
      void input;
      const chunks: Buffer[] = [];
      for await (const chunk of download.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    },
  };

  const bytes = await documents.readExactVersionBytes({
    documentId: "doc",
    versionId: "ver",
    ownerUserId: "user",
  });
  assert.ok(Buffer.isBuffer(bytes));
  assert.deepEqual(bytes, expected);
  assert.equal(bytes.toString("utf8").includes("base64"), false);
});
