import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentRunner,
  Capabilities,
  DOCUMENT_TOOL_NAMES,
  DOCX_ENGINE_CAPS,
  ToolRegistry,
  createCapabilities,
  createDocumentInspectTool,
  createFakeToolExecutionContext,
  createScriptedAgentModel,
  filterDocumentToolsByCapabilities,
  listDocumentToolDescriptors,
  mutableDocumentCapabilities,
  assistantOnlyResponse,
  type DocumentAffordance,
  type DocumentRef,
  type DocumentRuntime,
  type InspectedTableCell,
  type InspectionResult,
  type ModelRequest,
} from "../index.js";

const docxRef: DocumentRef = {
  documentId: "doc-1",
  versionId: "ver-1",
  format: "docx",
};

test("generic affordance contract is format-neutral", () => {
  const supported: DocumentAffordance = {
    capability: "some_operation",
    supported: true,
  };
  const unsupported: DocumentAffordance = {
    capability: "another_operation",
    supported: false,
    reason: "MULTIPLE_PARAGRAPHS",
  };
  const withAffordances: InspectedTableCell = {
    handle: "some-object-handle",
    text: "x",
    affordances: [supported, unsupported],
  };
  const without: InspectedTableCell = {
    handle: "other-handle",
    text: "y",
  };

  assert.equal(withAffordances.affordances?.[0]?.supported, true);
  assert.equal(withAffordances.affordances?.[1]?.reason, "MULTIPLE_PARAGRAPHS");
  assert.equal(without.affordances, undefined);
  assert.equal("affordances" in without, false);
});

test("missing affordances is neither supported nor unsupported", () => {
  const cell: InspectedTableCell = { handle: "h", text: "t" };
  assert.equal(cell.affordances, undefined);
  assert.equal(Array.isArray(cell.affordances), false);
});

test("capability can be globally available while a target affordance is unsupported", () => {
  const caps = createCapabilities(
    Capabilities.DocumentInspect,
    Capabilities.DocumentFind,
    Capabilities.DocumentMutate,
    DOCX_ENGINE_CAPS.setTableCellsText,
  );
  const tools = filterDocumentToolsByCapabilities(
    listDocumentToolDescriptors(),
    caps,
  ).map((t) => t.name);
  assert.ok(tools.includes(DOCUMENT_TOOL_NAMES.setTableCellsText));

  const cell: InspectedTableCell = {
    handle: "t0:r0:c1",
    text: "Year",
    affordances: [
      {
        capability: DOCX_ENGINE_CAPS.setTableCellsText,
        supported: false,
        reason: "MULTIPLE_PARAGRAPHS",
      },
    ],
  };
  assert.equal(cell.affordances![0]!.supported, false);
  assert.equal(cell.affordances![0]!.capability, "set_table_cells_text");
});

test("document.inspect exposes engine-provided affordances to the model", async () => {
  const inspection: InspectionResult = {
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
          rowCount: 2,
          cols: 2,
          affordances: [
            { capability: "insert_table_rows", supported: true },
            { capability: "insert_table_column", supported: true },
          ],
          rows: [
            {
              handle: "t0:r0",
              cells: [
                {
                  handle: "t0:r0:c0",
                  text: "Name",
                  affordances: [
                    {
                      capability: "set_table_cells_text",
                      supported: true,
                    },
                  ],
                },
                {
                  handle: "t0:r0:c1",
                  text: "Year",
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

  const runtime: DocumentRuntime = {
    capabilities: () => mutableDocumentCapabilities(),
    async inspect() {
      return inspection;
    },
  };

  let modelSawAffordances = false;
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      (request: ModelRequest) => {
        assert.ok(
          request.tools.some((t) => t.name === DOCUMENT_TOOL_NAMES.inspect),
        );
        return {
          content: "",
          toolCalls: [
            {
              id: "c1",
              name: DOCUMENT_TOOL_NAMES.inspect,
              input: { focus: { kind: "tables" } },
            },
          ],
        };
      },
      (request: ModelRequest) => {
        const toolMsg = request.messages.find((m) => m.role === "tool");
        assert.ok(toolMsg && toolMsg.role === "tool");
        const output = toolMsg.output as InspectionResult;
        assert.equal(output.status, "success");
        if (output.status === "success" && output.payload.format === "docx") {
          const table = output.payload.tables?.[0];
          assert.ok(table?.affordances?.some((a) => a.capability === "insert_table_rows"));
          const year = table?.rows?.[0]?.cells?.[1];
          assert.equal(year?.text, "Year");
          assert.equal(year?.affordances?.[0]?.supported, false);
          assert.equal(year?.affordances?.[0]?.reason, "MULTIPLE_PARAGRAPHS");
          modelSawAffordances = true;
        }
        return assistantOnlyResponse("ok");
      },
    ]),
    tools: ToolRegistry.create([]),
    documentToolCatalog: listDocumentToolDescriptors(),
    runtime,
  });

  const result = await runner.run({
    instruction: "inspect tables",
    threadId: "t1",
    runId: "r-afford",
    primaryDocument: docxRef,
  });
  assert.equal(result.status, "completed");
  assert.equal(modelSawAffordances, true);
});

test("document.inspect tool returns affordances without inventing them", async () => {
  const tool = createDocumentInspectTool();
  const runtime: DocumentRuntime = {
    capabilities: () =>
      createCapabilities(Capabilities.DocumentInspect),
    async inspect() {
      return {
        status: "success",
        format: "docx",
        capabilities: createCapabilities(Capabilities.DocumentInspect),
        diagnostics: [],
        focus: { kind: "tables" },
        payload: {
          format: "docx",
          summary: { title: null, unitKind: "page", unitCount: 1 },
          tables: [
            {
              handle: "t0",
              rowCount: 1,
              cols: 1,
              rows: [
                {
                  handle: "t0:r0",
                  cells: [{ handle: "t0:r0:c0", text: "A" }],
                },
              ],
            },
          ],
        },
      };
    },
  };

  const result = (await tool.execute(
    tool.parseInput({ focus: { kind: "tables" } }),
    createFakeToolExecutionContext({
      primaryDocument: docxRef,
      runtime,
    }),
  )) as InspectionResult;

  assert.equal(result.status, "success");
  if (result.status === "success" && result.payload.format === "docx") {
    assert.equal(result.payload.tables?.[0]?.affordances, undefined);
    assert.equal(
      result.payload.tables?.[0]?.rows?.[0]?.cells?.[0]?.affordances,
      undefined,
    );
  }
});
