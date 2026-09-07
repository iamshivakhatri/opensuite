import "../load-env.js";

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import {
  DOCUMENT_TOOL_NAMES,
  createDocumentToolRegistry,
  createScriptedAgentModel,
  mutableDocumentCapabilities,
  assistantOnlyResponse,
  toolCallResponse,
  type AgentEvent,
} from "@opensuite/agent-core";
import { createDbClient, schema } from "@opensuite/db";
import {
  buildMinimalDocx,
  createNapiDocxEngineBinding,
  createOpenSuiteEngineAdapter,
  type DocxEngineBinding,
} from "@opensuite/engine-client";
import { asc, eq } from "drizzle-orm";

import { createAgentExecutionService } from "../agent/execution.js";
import { createAgentPersistenceService } from "../agent/persistence.js";
import { createOwnedDocumentArtifactLoader } from "../documents/artifact-loader.js";
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
    email: `agent-mut-${label}-${id}@example.com`,
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
  "integration: agent replace_text persists N+1 and same-run find reads it",
  { skip: !runDbIntegrationTests || !databaseUrl },
  async () => {
    const binding = await resolveBinding();
    const dbClient = createDbClient({ databaseUrl: databaseUrl! });
    const storage = createMemoryObjectStorage();
    const documents = createDocumentService(dbClient.db, storage, {
      uploadMaxBytes: 1024 * 1024,
    });
    const persistence = createAgentPersistenceService(dbClient.db);

    const ownerUserId = await seedUser(dbClient.db, "alice");
    const workspaceId = await seedWorkspace(
      dbClient.db,
      ownerUserId,
      "Agent Mut WS",
    );

    const uploaded = await documents.uploadOfficeDocument({
      workspaceId,
      ownerUserId,
      filename: "Memo.docx",
      bytes: buildMinimalDocx(["OpenSuite rocks", "Keep going"]),
    });
    const versionN = uploaded.version.id;

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
              capabilities: ["find_text", "inspect_context", "replace_text"],
            },
          ],
        }),
        createBlankDocx() {
          return new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
        },
        async executeDocxInsertParagraph() {
          return {
            result: {
              ok: false,
              status: "failed",
              diagnostics: [
                {
                  code: "UNSUPPORTED_OPERATION",
                  severity: "error",
                  message: "unused",
                },
              ],
              changes: [],
            },
          };
        },
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
          if (request.focus.kind !== "context") {
            return {
              ok: false,
              focus: request.focus.kind,
              diagnostics: [
                {
                  code: "UNSUPPORTED_OPERATION",
                  severity: "error",
                  message: `stub does not implement ${request.focus.kind}`,
                },
              ],
            };
          }
          return {
            ok: true,
            focus: "context",
            context: {
              target: {
                text: request.focus.text,
                ...(request.focus.occurrence !== undefined
                  ? { occurrence: request.focus.occurrence }
                  : {}),
              },
              container: {
                relativePosition: 0,
                text: request.focus.text,
                container: "paragraph",
              },
              nearby: [],
            },
            diagnostics: [],
          };
        },
        async executeDocxReplaceText(input, operation) {
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
            output: buildMinimalDocx([operation.replacement, "Keep going"]),
          };
        },

        async executeDocxSetTableCellsText() {
          return {
            result: {
              ok: false,
              status: "failed",
              diagnostics: [
                {
                  code: "UNSUPPORTED_OPERATION",
                  severity: "error",
                  message: "unused",
                },
              ],
              changes: [],
            },
          };
        },
        async executeDocxInsertTableRows() {
          return {
            result: {
              ok: false,
              status: "failed",
              diagnostics: [
                {
                  code: "UNSUPPORTED_OPERATION",
                  severity: "error",
                  message: "unused",
                },
              ],
              changes: [],
            },
          };
        },
        async executeDocxInsertTableColumn() {
          return {
            result: {
              ok: false,
              status: "failed",
              diagnostics: [
                {
                  code: "UNSUPPORTED_OPERATION",
                  severity: "error",
                  message: "unused",
                },
              ],
              changes: [],
            },
          };
        },
      } satisfies DocxEngineBinding);

    let executeCalls = 0;
    const countingBinding: DocxEngineBinding = {
      ...engineBinding,
      async executeDocxReplaceText(input, operation) {
        executeCalls += 1;
        return engineBinding.executeDocxReplaceText(input, operation);
      },
    };

    const runtime = createOpenSuiteEngineAdapter({
      artifactLoader: createOwnedDocumentArtifactLoader({
        documents,
        ownerUserId,
      }),
      binding: countingBinding,
    });

    const liveEvents: AgentEvent[] = [];
    const model = createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "f1",
          name: DOCUMENT_TOOL_NAMES.find,
          input: { query: "OpenSuite", mode: "text" },
        },
      ]),
      toolCallResponse("", [
        {
          id: "r1",
          name: DOCUMENT_TOOL_NAMES.replaceText,
          input: { find: "OpenSuite", replace: "OpenSuite AI" },
        },
      ]),
      toolCallResponse("", [
        {
          id: "f2",
          name: DOCUMENT_TOOL_NAMES.find,
          input: { query: "OpenSuite AI", mode: "text" },
        },
      ]),
      assistantOnlyResponse("Updated to OpenSuite AI"),
    ]);

    const execution = createAgentExecutionService({
      persistence,
      documents,
      model,
      tools: createDocumentToolRegistry(mutableDocumentCapabilities()),
      runtime,
      capabilities: mutableDocumentCapabilities(),
    });

    const thread = await persistence.createThread({
      workspaceId,
      ownerUserId,
      documentId: uploaded.document.id,
      createdByUserId: ownerUserId,
      title: "Persist mutate",
    });

    const result = await execution.execute({
      userId: ownerUserId,
      threadId: thread.id,
      instruction: "Change OpenSuite to OpenSuite AI",
      liveEvents: {
        emit(event) {
          liveEvents.push(event);
        },
      },
    });

    assert.equal(result.result.status, "completed");
    assert.equal(executeCalls, 1);

    const versions = await dbClient.db
      .select({
        id: schema.documentVersion.id,
        versionNumber: schema.documentVersion.versionNumber,
        source: schema.documentVersion.source,
      })
      .from(schema.documentVersion)
      .where(eq(schema.documentVersion.documentId, uploaded.document.id))
      .orderBy(asc(schema.documentVersion.versionNumber));

    assert.equal(versions.length, 2);
    assert.equal(versions[0]!.id, versionN);
    assert.equal(versions[1]!.versionNumber, 2);
    assert.equal(versions[1]!.source, "agent");

    const versionNPlus1 = versions[1]!.id;
    const advanced = liveEvents.filter(
      (e) => e.type === "document.version.advanced",
    );
    assert.equal(advanced.length, 1);
    if (advanced[0]?.type === "document.version.advanced") {
      assert.equal(advanced[0].baseVersionId, versionN);
      assert.equal(advanced[0].versionId, versionNPlus1);
    }

    const findOutcomes = result.result.toolOutcomes.filter(
      (o) => o.toolName === DOCUMENT_TOOL_NAMES.find,
    );
    assert.equal(findOutcomes.length, 2);
    assert.equal(findOutcomes[0]?.status, "succeeded");
    assert.equal(findOutcomes[1]?.status, "succeeded");

    const secondFind = findOutcomes[1]!.output as {
      status?: string;
      matches?: { excerpt: string }[];
    };
    assert.equal(secondFind.status, "success");
    assert.ok(
      secondFind.matches?.some((m) => /OpenSuite AI/.test(m.excerpt)),
    );

    const nRef = {
      documentId: uploaded.document.id,
      versionId: versionN,
      format: "docx" as const,
    };
    const stillN = await runtime.find!(nRef, {
      query: "OpenSuite",
      mode: "text",
    });
    assert.equal(stillN.status, "success");
    if (stillN.status === "success") {
      assert.ok(stillN.matches.some((m) => /OpenSuite/.test(m.excerpt)));
    }
  },
);
