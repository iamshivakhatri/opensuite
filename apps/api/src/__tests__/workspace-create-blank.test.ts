import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentRunner,
  ToolRegistry,
  assistantOnlyResponse,
  createDocumentAgentRunnerOptions,
  createInMemoryDocumentMutationExecutor,
  createScriptedAgentModel,
  listDocumentToolDescriptors,
  toolCallResponse,
  type DocumentRef,
  type DocumentRuntime,
} from "@opensuite/agent-core";

import type { UploadedDocumentDto } from "../documents/service.js";
import { createWorkspaceCreateBlankDocxTool } from "../agent/workspace-tools.js";

test("workspace.create_blank_docx creates Version 1 and advances primary", async () => {
  const events: string[] = [];
  let createdName: string | undefined;
  const tool = createWorkspaceCreateBlankDocxTool({
    workspaceId: "ws-1",
    ownerUserId: "user-1",
    documents: {
      async createBlankDocxDocument(input): Promise<UploadedDocumentDto> {
        createdName = input.name;
        return {
          document: {
            id: "doc-new",
            workspaceId: "ws-1",
            name: "Board Report.docx",
            format: "docx",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          version: {
            id: "ver-1",
            documentId: "doc-new",
            versionNumber: 1,
            parentVersionId: null,
            sizeBytes: 100,
            sha256: "abc",
            source: "user",
            createdByUserId: "user-1",
            createdAt: new Date().toISOString(),
          },
        };
      },
    },
  });

  const runtime: DocumentRuntime = {
    async capabilities() {
      return {
        ids: new Set([
          "document.inspect",
          "document.mutate",
          "insert_paragraph",
        ]),
      };
    },
    async inspect() {
      return {
        status: "success",
        format: "docx",
        capabilities: { ids: new Set(["document.inspect"]) },
        diagnostics: [],
        focus: { kind: "overview" },
        payload: {
          format: "docx",
          summary: { title: null, unitKind: "page", unitCount: 0 },
        },
      };
    },
    async execute() {
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([1]),
      };
    },
  };

  let primary: DocumentRef | null = null;
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "c1",
          name: "workspace.create_blank_docx",
          input: { name: "Board Report" },
        },
      ]),
      // After create, runner forces tools until a mutation lands.
      toolCallResponse("", [
        {
          id: "c2",
          name: "document.insert_paragraph",
          input: { text: "Hello", placement: { kind: "end" } },
        },
      ]),
      assistantOnlyResponse("Created blank document."),
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([tool]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
    }),
    events: {
      async emit(event) {
        events.push(event.type);
        if (event.type === "document.created") {
          primary = {
            documentId: event.documentId,
            versionId: event.versionId,
            format: "docx",
          };
        }
      },
    },
  });

  const result = await runner.run({
    instruction: "create a blank doc",
    threadId: "t1",
    runId: "run-1",
    primaryDocument: null,
  });

  assert.equal(result.status, "completed");
  assert.equal(createdName, "Board Report");
  assert.ok(events.includes("document.created"));
  assert.deepEqual(primary, {
    documentId: "doc-new",
    versionId: "ver-1",
    format: "docx",
  });
  const outcome = result.toolOutcomes.find(
    (o) => o.toolName === "workspace.create_blank_docx",
  );
  assert.equal(outcome?.status, "succeeded");
});
