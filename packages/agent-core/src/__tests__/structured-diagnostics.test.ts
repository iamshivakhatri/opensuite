import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AgentCoreError,
  AgentRunner,
  ArtifactHandleRegistry,
  DOCUMENT_TOOL_NAMES,
  ToolRegistry,
  assistantOnlyResponse,
  createDocumentInspectTool,
  createDocumentSetTableCellsTextTool,
  createFakeToolExecutionContext,
  createInMemoryDocumentMutationExecutor,
  createScriptedAgentModel,
  listDocumentToolDescriptors,
  mutableDocumentCapabilities,
  shapeDiagnosticForToolResult,
  toolCallResponse,
  type Diagnostic,
  type DocumentMutationExecutor,
  type DocumentRef,
  type DocumentRuntime,
  type NonEmptyDiagnostics,
} from "../index.js";

const docxRef: DocumentRef = {
  documentId: "doc-1",
  versionId: "ver-1",
  format: "docx",
};

const structuredFailure: Diagnostic = {
  code: "UNSUPPORTED_OPERATION",
  severity: "error",
  reasonCode: "MULTIPLE_PARAGRAPHS",
  operation: "set_table_cells_text",
  targetHandle: "t0:r1:c1",
  message:
    "set_table_cells_text requires one ordinary paragraph with direct runs",
};

test("shapeDiagnosticForToolResult preserves structured fields and omits absences", () => {
  assert.deepEqual(shapeDiagnosticForToolResult(structuredFailure), {
    code: "UNSUPPORTED_OPERATION",
    message: structuredFailure.message,
    reasonCode: "MULTIPLE_PARAGRAPHS",
    operation: "set_table_cells_text",
    targetHandle: "t0:r1:c1",
  });

  const minimal: Diagnostic = {
    code: "TARGET_NOT_FOUND",
    severity: "error",
    message: "missing",
  };
  assert.deepEqual(shapeDiagnosticForToolResult(minimal), {
    code: "TARGET_NOT_FOUND",
    message: "missing",
  });
  assert.equal("reasonCode" in shapeDiagnosticForToolResult(minimal), false);
});

test("failed document mutation exposes structured diagnostic to the model", async () => {
  const diagnostics: NonEmptyDiagnostics = [structuredFailure];
  const mutations: DocumentMutationExecutor = {
    async replaceText() {
      throw new Error("unused");
    },
    async insertParagraph() {
      throw new Error("unused");
    },
    async setTableCellsText() {
      return {
        status: "error",
        code: "UNSUPPORTED_OPERATION",
        diagnostics,
      };
    },
    async insertTableRows() {
      throw new Error("unused");
    },
    async insertTableColumn() {
      throw new Error("unused");
    },
  };

  const seenDiagnostics: Diagnostic[] = [];
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "u1",
          name: DOCUMENT_TOOL_NAMES.setTableCellsText,
          input: {
            table: { headerCells: ["Name", "Year"] },
            updates: [
              {
                rowLabel: "OpenSuite",
                columnHeader: "Year",
                expectedCurrentText: "2026",
                replacement: "2027",
              },
            ],
          },
        },
      ]),
      (request) => {
        for (const message of request.messages) {
          if (message.role === "tool" && message.diagnostic) {
            seenDiagnostics.push(message.diagnostic);
          }
        }
        return assistantOnlyResponse("cell unsupported");
      },
    ]),
    tools: ToolRegistry.create([]),
    documentToolCatalog: listDocumentToolDescriptors(),
    runtime: {
      async capabilities() {
        return mutableDocumentCapabilities();
      },
      async inspect() {
        throw new Error("inspect unused");
      },
    },
    mutations,
    capabilities: mutableDocumentCapabilities(),
  });

  const result = await runner.run({
    instruction: "set year",
    threadId: "t1",
    runId: "run-structured-diag",
    primaryDocument: docxRef,
  });

  const failed = result.toolOutcomes.find(
    (o) => o.toolName === DOCUMENT_TOOL_NAMES.setTableCellsText,
  );
  assert.equal(failed?.status, "failed");
  assert.deepEqual(failed?.diagnostic, structuredFailure);
  assert.equal(seenDiagnostics.length, 1);
  assert.deepEqual(seenDiagnostics[0], structuredFailure);
  assert.equal(seenDiagnostics[0]?.reasonCode, "MULTIPLE_PARAGRAPHS");
});

test("affordance reason and mutation reasonCode stay the same identifier", async () => {
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      return {
        status: "success",
        format: "docx",
        capabilities: mutableDocumentCapabilities(),
        diagnostics: [],
        focus: { kind: "tables" },
        payload: {
          format: "docx",
          summary: { title: null, unitKind: "page", unitCount: 1 },
          tables: [
            {
              handle: "t0",
              occurrence: 1,
              rowCount: 2,
              cols: 1,
              isRectangular: true,
              columns: [],
              rows: [
                {
                  handle: "t0:r1",
                  cells: [
                    {
                      handle: "t0:r1:c1",
                      text: "2026",
                      affordances: [
                        {
                          capability: "set_table_cells_text",
                          supported: false,
                          reason: "MULTIPLE_PARAGRAPHS",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
    },
  };

  const mutations: DocumentMutationExecutor = {
    async replaceText() {
      throw new Error("unused");
    },
    async insertParagraph() {
      throw new Error("unused");
    },
    async setTableCellsText() {
      return {
        status: "error",
        code: "UNSUPPORTED_OPERATION",
        diagnostics: [structuredFailure],
      };
    },
    async insertTableRows() {
      throw new Error("unused");
    },
    async insertTableColumn() {
      throw new Error("unused");
    },
  };

  const inspect = createDocumentInspectTool();
  const setCells = createDocumentSetTableCellsTextTool();
  const registry = new ArtifactHandleRegistry();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docxRef,
    runtime,
    mutations,
    handles: registry,
  });

  const inspected = await inspect.execute(
    { focus: { kind: "tables", offset: 0, limit: 10 } },
    ctx,
  );
  assert.equal(inspected.status, "success");
  if (inspected.status !== "success" || inspected.payload.format !== "docx") {
    assert.fail("expected docx tables");
  }
  const affordanceReason =
    inspected.payload.tables?.[0]?.rows?.[0]?.cells?.[0]?.affordances?.[0]
      ?.reason;
  assert.equal(affordanceReason, "MULTIPLE_PARAGRAPHS");

  await assert.rejects(
    () =>
      setCells.execute(
        {
          table: { handle: "t0" },
          updates: [
            {
              target: { handle: "t0:r1:c1" },
              expectedCurrentText: "2026",
              replacement: "2027",
            },
          ],
        },
        ctx,
      ),
    (error: unknown) => {
      assert.ok(error instanceof AgentCoreError);
      assert.equal(error.diagnostic?.reasonCode, "MULTIPLE_PARAGRAPHS");
      assert.equal(error.diagnostic?.reasonCode, affordanceReason);
      assert.equal(error.diagnostic?.operation, "set_table_cells_text");
      assert.equal(error.diagnostic?.targetHandle, "t0:r1:c1");
      return true;
    },
  );
});

test("UNKNOWN_HANDLE remains an application diagnostic without engine fields", async () => {
  let executeCalled = false;
  const runtime: DocumentRuntime = {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("inspect unused");
    },
    async execute() {
      executeCalled = true;
      assert.fail("unknown handle must not reach runtime.execute");
    },
  };
  const tool = createDocumentSetTableCellsTextTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docxRef,
    runtime,
    mutations: createInMemoryDocumentMutationExecutor(runtime),
    handles: new ArtifactHandleRegistry(),
  });

  await assert.rejects(
    () =>
      tool.execute(
        {
          table: { handle: "t0" },
          updates: [
            {
              target: { handle: "t0:r1:c1" },
              expectedCurrentText: "x",
              replacement: "y",
            },
          ],
        },
        ctx,
      ),
    (error: unknown) => {
      assert.ok(error instanceof AgentCoreError);
      assert.equal(error.code, "UNKNOWN_HANDLE");
      assert.equal(error.diagnostic?.code, "UNKNOWN_HANDLE");
      assert.equal(error.diagnostic?.reasonCode, undefined);
      assert.equal(error.diagnostic?.operation, undefined);
      return true;
    },
  );
  assert.equal(executeCalled, false);
});

test("no message parsing for reasonCode in agent-core diagnostic path", () => {
  // Tests compile to dist/; source lives one level up under src/.
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../src");
  for (const relative of [
    "types.ts",
    "instructions.ts",
    "document-tools/define-tool.ts",
    "document-tools/mutations.ts",
  ]) {
    const source = readFileSync(join(root, relative), "utf8");
    assert.doesNotMatch(source, /message\.includes\s*\(/);
    assert.doesNotMatch(source, /\/multiple\s*paragraphs\/i/);
  }
});
