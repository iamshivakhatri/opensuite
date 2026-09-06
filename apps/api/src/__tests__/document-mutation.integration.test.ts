import "../load-env.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { createDbClient, schema } from "@opensuite/db";
import {
  buildMinimalDocx,
  createOpenSuiteEngineAdapter,
  createNapiDocxEngineBinding,
  type DocxEngineBinding,
} from "@opensuite/engine-client";
import { asc, desc, eq } from "drizzle-orm";

import { createOwnedDocumentArtifactLoader } from "../documents/artifact-loader.js";
import { createDocumentMutationService } from "../documents/mutation.js";
import { createDocumentService } from "../documents/service.js";
import { createMemoryObjectStorage } from "../storage/index.js";

const runDbIntegrationTests = process.env.RUN_DB_INTEGRATION_TESTS === "true";
const databaseUrl = process.env.DATABASE_URL;

type Db = ReturnType<typeof createDbClient>["db"];

async function seedUser(db: Db, label: string): Promise<string> {
  const id = randomUUID();
  await db.insert(schema.user).values({
    id,
    name: label,
    email: `mutation-${label}-${id}@example.com`,
    emailVerified: true,
  });
  return id;
}

async function seedWorkspace(
  db: Db,
  ownerUserId: string,
  name: string,
): Promise<string> {
  const [row] = await db
    .insert(schema.workspace)
    .values({ ownerUserId, name })
    .returning({ id: schema.workspace.id });
  assert.ok(row);
  return row.id;
}

async function resolveBinding(): Promise<DocxEngineBinding | null> {
  try {
    return await createNapiDocxEngineBinding();
  } catch {
    return null;
  }
}

test(
  "integration: ReplaceText persists version N+1 with atomic concurrency",
  { skip: !runDbIntegrationTests || !databaseUrl },
  async () => {
    const binding = await resolveBinding();
    if (!binding) {
      // Still exercise persistence with a deterministic fake binding when native
      // is unavailable — real N-API path runs when the sibling package is linked.
    }

    const dbClient = createDbClient({ databaseUrl: databaseUrl! });
    const storage = createMemoryObjectStorage();
    const cleanupKeys: string[] = [];
    const documents = createDocumentService(dbClient.db, storage, {
      uploadMaxBytes: 1024 * 1024,
      onCleanupFailure: (_error, key) => {
        cleanupKeys.push(key);
      },
    });

    const ownerUserId = await seedUser(dbClient.db, "alice");
    const workspaceId = await seedWorkspace(
      dbClient.db,
      ownerUserId,
      "Mutation WS",
    );

    const inputBytes = buildMinimalDocx(["old text", "Date:", "Date:"]);
    const uploaded = await documents.uploadOfficeDocument({
      workspaceId,
      ownerUserId,
      filename: "Memo.docx",
      bytes: inputBytes,
    });

    const baseVersionId = uploaded.version.id;
    const baseKey = [...storage.objects.keys()][0]!;
    const baseObject = storage.objects.get(baseKey)!;
    assert.deepEqual(baseObject.body, inputBytes);

    const engineBinding: DocxEngineBinding =
      binding ??
      ({
        getDocxCapabilities: () => ({
          ok: true,
          protocolVersion: 1,
          engineVersion: "test",
          formats: [
            {
              format: "docx",
              capabilities: [
                "find_text",
                "inspect_context",
                "replace_text",
              ],
            },
          ],
        }),
        async findDocxText(input, request) {
          const haystack = Buffer.from(input).toString("utf8");
          const found = haystack.includes(request.text);
          return {
            ok: true,
            query: request.text,
            matchCount: found ? 1 : 0,
            matches: found
              ? [
                  {
                    occurrence: 1,
                    text: request.text,
                    before: "",
                    after: "",
                    container: "paragraph",
                  },
                ]
              : [],
            diagnostics: [],
          };
        },
        async inspectDocx(_input, request) {
          return {
            ok: true,
            target: request.target,
            container: {
              relativePosition: 0,
              text: request.target.text,
              container: "paragraph",
            },
            nearby: [],
            diagnostics: [],
          };
        },
        async executeDocxReplaceText(input, operation) {
          if (operation.target.text === "not present") {
            return {
              result: {
                ok: false,
                status: "failed",
                diagnostics: [
                  {
                    code: "TARGET_NOT_FOUND",
                    severity: "error",
                    message: "missing",
                  },
                ],
                changes: [],
              },
            };
          }
          assert.ok(Buffer.from(input).byteLength > 0);
          return {
            result: {
              ok: true,
              status: "applied",
              diagnostics: [],
              changes: [
                {
                  kind: "text_replaced",
                  before: operation.target.text,
                  after: operation.replacement,
                },
              ],
            },
            output: buildMinimalDocx([operation.replacement]),
          };
        },
      } satisfies DocxEngineBinding);

    const runtime = createOpenSuiteEngineAdapter({
      artifactLoader: createOwnedDocumentArtifactLoader({
        documents,
        ownerUserId,
      }),
      binding: engineBinding,
    });

    // Read Version N before mutating.
    const nRef = {
      documentId: uploaded.document.id,
      versionId: baseVersionId,
      format: "docx" as const,
    };
    const caps = await runtime.capabilities(nRef);
    assert.ok([...caps.ids].includes("find_text") || [...caps.ids].includes("document.find"));
    const foundN = await runtime.find!(nRef, {
      query: "old text",
      mode: "text",
    });
    assert.equal(foundN.status, "success");
    const inspectN = await runtime.inspect(nRef, {
      focus: { kind: "context", text: "old text" },
    });
    assert.equal(inspectN.status, "success");

    const mutations = createDocumentMutationService(documents);
    const applied = await mutations.applyReplaceText({
      documentId: uploaded.document.id,
      ownerUserId,
      baseVersionId,
      find: "old text",
      replace: "OpenSuite persisted replacement",
      runtime,
    });

    assert.equal(applied.status, "success");
    if (applied.status !== "success") return;

    assert.equal(applied.version.versionNumber, 2);
    assert.equal(applied.version.parentVersionId, baseVersionId);
    assert.equal(applied.version.source, "agent");
    assert.equal(applied.document.latestVersion.id, applied.version.id);
    assert.notEqual(applied.version.id, baseVersionId);

    const versions = await dbClient.db
      .select({
        id: schema.documentVersion.id,
        versionNumber: schema.documentVersion.versionNumber,
        storageKey: schema.documentVersion.storageKey,
        parentVersionId: schema.documentVersion.parentVersionId,
        source: schema.documentVersion.source,
      })
      .from(schema.documentVersion)
      .where(eq(schema.documentVersion.documentId, uploaded.document.id))
      .orderBy(asc(schema.documentVersion.versionNumber));

    assert.equal(versions.length, 2);
    assert.equal(versions[0]!.id, baseVersionId);
    assert.equal(versions[1]!.id, applied.version.id);
    assert.notEqual(versions[0]!.storageKey, versions[1]!.storageKey);

    // Version N object unchanged.
    assert.deepEqual(storage.objects.get(versions[0]!.storageKey)?.body, inputBytes);

    const v2Bytes = storage.objects.get(versions[1]!.storageKey)?.body;
    assert.ok(v2Bytes);
    assert.notDeepEqual(v2Bytes, inputBytes);

    // Exact older version still loadable.
    const older = await documents.readExactVersionBytes({
      documentId: uploaded.document.id,
      versionId: baseVersionId,
      ownerUserId,
    });
    assert.deepEqual(older, inputBytes);

    const newer = await documents.readExactVersionBytes({
      documentId: uploaded.document.id,
      versionId: applied.version.id,
      ownerUserId,
    });
    assert.deepEqual(newer, v2Bytes);

    // Read Version N+1 independently; Version N still has original text.
    const nPlusOneRuntime = createOpenSuiteEngineAdapter({
      artifactLoader: createOwnedDocumentArtifactLoader({
        documents,
        ownerUserId,
      }),
      binding: engineBinding,
    });
    const nPlusOneRef = {
      documentId: uploaded.document.id,
      versionId: applied.version.id,
      format: "docx" as const,
    };
    const foundN1 = await nPlusOneRuntime.find!(nPlusOneRef, {
      query: "OpenSuite persisted replacement",
      mode: "text",
    });
    assert.equal(foundN1.status, "success");
    const inspectN1 = await nPlusOneRuntime.inspect(nPlusOneRef, {
      focus: {
        kind: "context",
        text: "OpenSuite persisted replacement",
      },
    });
    assert.equal(inspectN1.status, "success");

    const stillN = await runtime.find!(nRef, {
      query: "old text",
      mode: "text",
    });
    assert.equal(stillN.status, "success");
    if (stillN.status === "success") {
      assert.ok(stillN.matches.length >= 1);
    }

    // Runtime failure: TARGET_NOT_FOUND → no new version.
    const missing = await mutations.applyReplaceText({
      documentId: uploaded.document.id,
      ownerUserId,
      baseVersionId: applied.version.id,
      find: "not present",
      replace: "x",
      runtime: createOpenSuiteEngineAdapter({
        artifactLoader: createOwnedDocumentArtifactLoader({
          documents,
          ownerUserId,
        }),
        binding: engineBinding,
      }),
    });
    assert.equal(missing.status, "error");
    if (missing.status === "error") {
      assert.equal(missing.code, "TARGET_NOT_FOUND");
    }
    const afterFailure = await dbClient.db
      .select({ id: schema.documentVersion.id })
      .from(schema.documentVersion)
      .where(eq(schema.documentVersion.documentId, uploaded.document.id));
    assert.equal(afterFailure.length, 2);
    assert.equal(storage.objects.size, 2);

    // Optimistic concurrency: another writer advances before persist.
    const staleRuntime = createOpenSuiteEngineAdapter({
      artifactLoader: createOwnedDocumentArtifactLoader({
        documents,
        ownerUserId,
      }),
      binding: {
        getDocxCapabilities: engineBinding.getDocxCapabilities.bind(engineBinding),
        findDocxText: engineBinding.findDocxText.bind(engineBinding),
        inspectDocx: engineBinding.inspectDocx.bind(engineBinding),
        async executeDocxReplaceText() {
          return {
            result: {
              ok: true,
              status: "applied",
              diagnostics: [],
              changes: [
                {
                  kind: "text_replaced",
                  before: "OpenSuite persisted replacement",
                  after: "stale engine output",
                },
              ],
            },
            output: buildMinimalDocx(["stale engine output"]),
          };
        },
      },
    });

    const objectsBeforeStale = storage.objects.size;
    const staleMutations = createDocumentMutationService(documents, {
      beforePersist: async () => {
        await documents.appendDocumentVersion({
          documentId: uploaded.document.id,
          ownerUserId,
          baseVersionId: applied.version.id,
          source: "user",
          bytes: buildMinimalDocx(["human raced ahead"]),
        });
      },
    });

    const stale = await staleMutations.applyReplaceText({
      documentId: uploaded.document.id,
      ownerUserId,
      baseVersionId: applied.version.id,
      find: "OpenSuite persisted replacement",
      replace: "stale engine output",
      runtime: staleRuntime,
    });

    assert.equal(stale.status, "error");
    if (stale.status === "error") {
      assert.equal(stale.code, "VERSION_CONFLICT");
    }

    const finalVersions = await dbClient.db
      .select({
        id: schema.documentVersion.id,
        versionNumber: schema.documentVersion.versionNumber,
        source: schema.documentVersion.source,
      })
      .from(schema.documentVersion)
      .where(eq(schema.documentVersion.documentId, uploaded.document.id))
      .orderBy(asc(schema.documentVersion.versionNumber));

    assert.equal(finalVersions.length, 3);
    assert.equal(finalVersions[2]!.source, "user");
    assert.equal(finalVersions[2]!.versionNumber, 3);

    const [latest] = await dbClient.db
      .select({ id: schema.documentVersion.id })
      .from(schema.documentVersion)
      .where(eq(schema.documentVersion.documentId, uploaded.document.id))
      .orderBy(desc(schema.documentVersion.versionNumber))
      .limit(1);
    assert.equal(latest?.id, finalVersions[2]!.id);

    // Stale upload cleaned up: only 3 objects remain (v1, agent v2, human v3).
    assert.equal(storage.objects.size, 3);
    assert.equal(storage.objects.size, objectsBeforeStale + 1);
    assert.equal(cleanupKeys.length, 0);

    // Missing version does not fall back to latest.
    await assert.rejects(
      () =>
        documents.readExactVersionBytes({
          documentId: uploaded.document.id,
          versionId: randomUUID(),
          ownerUserId,
        }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "DOCUMENT_NOT_FOUND",
    );

    await dbClient.db
      .delete(schema.documentVersion)
      .where(eq(schema.documentVersion.documentId, uploaded.document.id));
    await dbClient.db
      .delete(schema.document)
      .where(eq(schema.document.id, uploaded.document.id));
    await dbClient.db
      .delete(schema.workspace)
      .where(eq(schema.workspace.id, workspaceId));
    await dbClient.db.delete(schema.user).where(eq(schema.user.id, ownerUserId));
    await dbClient.close();
  },
);

test("unit-adjacent: real adapter + owned loader + mutation service without DB", async () => {
  // Proves adapter remains persistence-free while mutation service owns append.
  const inputBytes = buildMinimalDocx(["old text"]);
  const outputBytes = buildMinimalDocx(["new text"]);
  let appendCalled = false;

  const documents = {
    async getOwnedDocument() {
      return {
        id: "doc-1",
        workspaceId: "ws-1",
        name: "Memo.docx",
        format: "docx" as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        latestVersion: {
          id: "ver-1",
          versionNumber: 1,
          sizeBytes: inputBytes.byteLength,
          source: "upload" as const,
          createdAt: new Date().toISOString(),
        },
      };
    },
    async readExactVersionBytes() {
      return inputBytes;
    },
    async appendDocumentVersion(input: {
      bytes: Buffer;
      source: string;
      baseVersionId: string;
    }) {
      appendCalled = true;
      assert.equal(input.source, "agent");
      assert.equal(input.baseVersionId, "ver-1");
      assert.deepEqual(input.bytes, outputBytes);
      return {
        document: {
          id: "doc-1",
          workspaceId: "ws-1",
          name: "Memo.docx",
          format: "docx" as const,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          latestVersion: {
            id: "ver-2",
            versionNumber: 2,
            sizeBytes: outputBytes.byteLength,
            source: "agent" as const,
            createdAt: new Date().toISOString(),
          },
        },
        version: {
          id: "ver-2",
          documentId: "doc-1",
          versionNumber: 2,
          parentVersionId: "ver-1",
          sizeBytes: outputBytes.byteLength,
          sha256: null,
          source: "agent" as const,
          createdByUserId: "user-1",
          createdAt: new Date().toISOString(),
        },
      };
    },
  };

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createOwnedDocumentArtifactLoader({
      documents,
      ownerUserId: "user-1",
    }),
    binding: {
      getDocxCapabilities: () => ({
        ok: true,
        protocolVersion: 1,
        engineVersion: "test",
        formats: [
          {
            format: "docx",
            capabilities: ["find_text", "inspect_context", "replace_text"],
          },
        ],
      }),
      async findDocxText() {
        return {
          ok: true,
          query: "",
          matchCount: 0,
          matches: [],
          diagnostics: [],
        };
      },
      async inspectDocx(_input, request) {
        return {
          ok: true,
          target: request.target,
          nearby: [],
          diagnostics: [],
        };
      },
      async executeDocxReplaceText(input, operation) {
        assert.deepEqual(Buffer.from(input), inputBytes);
        assert.equal(operation.target.text, "old text");
        return {
          result: {
            ok: true,
            status: "applied",
            diagnostics: [],
            changes: [
              {
                kind: "text_replaced",
                before: "old text",
                after: "new text",
              },
            ],
          },
          output: outputBytes,
        };
      },
    },
  });

  const mutations = createDocumentMutationService(documents);
  const result = await mutations.applyReplaceText({
    documentId: "doc-1",
    ownerUserId: "user-1",
    baseVersionId: "ver-1",
    find: "old text",
    replace: "new text",
    runtime,
  });

  assert.equal(result.status, "success");
  assert.equal(appendCalled, true);
});
