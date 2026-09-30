import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { createFinishTool, runAgent, type AgentEvent } from "@opensuite/agent-core-v3";
import { bindDocxDocument, buildMinimalDocx, createNapiDocxEngineBinding } from "@opensuite/engine-client";
import { createPrimaryDocxTools } from "./docx-tools.js";
import { createToolSurface } from "./tool-groups.js";

type Call = { name: string; input: Record<string, unknown> };
const inspect: Call = { name: "document.inspect", input: { kind: "tables" } };

async function createSession() {
  const binding = await createNapiDocxEngineBinding();
  const seed = bindDocxDocument({ binding, bytes: buildMinimalDocx(["Status"]) });
  for (let index = 0; index < 3; index++) {
    assert.equal((await seed.mutate("create_table", {
      rows: [[`Item ${index}`, "Owner"], ["Plan", "Alice"], ["Build", "Bob"]],
      placement: { kind: "end" },
    })).ok, true);
  }
  let stored = Buffer.from(seed.currentBytes());
  const initial = Buffer.from(stored);
  let appends = 0;
  const revisions: number[] = [];
  const session = await createPrimaryDocxTools({
    binding, ownerUserId: "user-1", workspaceId: "ws-1", documentId: "doc-1", versionId: "v1",
    documents: {
      getOwnedDocument: async () => ({ format: "docx" }) as never,
      readExactVersionBytes: async () => stored,
      appendDocumentVersion: async ({ bytes, baseVersionId }) => {
        assert.equal(baseVersionId, "v1");
        stored = Buffer.from(bytes);
        appends++;
        return { version: { id: "v2", versionNumber: 2 } } as never;
      },
      createBlankDocxDocument: async () => { throw new Error("unused"); },
      createOfficeDocumentFromBytes: async () => { throw new Error("unused"); },
    },
    onWorkingUpdated: ({ revision }) => { revisions.push(revision); },
  });
  assert.ok(session);
  const tables = (await binding.inspectDocx(stored, { focus: { kind: "tables" } })).tables!.items;
  return { session, tables, initial, revisions, stored: () => stored, appends: () => appends };
}

// Exercise the real generic scheduler and N-API engine; only the model is fake.
async function runTurns(session: NonNullable<Awaited<ReturnType<typeof createPrimaryDocxTools>>>, turns: Call[][], surface?: ReturnType<typeof createToolSurface>) {
  let turn = 0;
  const events: AgentEvent[] = [];
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const calls = turns[turn++] ?? [];
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start" as const, warnings: [] },
        ...calls.map((call, index) => ({
          type: "tool-call" as const,
          toolCallId: `${turn}-${index}`,
          toolName: call.name.replaceAll(".", "_"),
          input: JSON.stringify(call.input),
        })),
        {
          type: "finish" as const,
          finishReason: { unified: calls.length ? "tool-calls" as const : "stop" as const, raw: "stop" },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ] }) };
    },
  });
  try {
    const result = await runAgent({
      model, tools: surface?.tools ?? session.tools, projectTools: surface?.projectTools, messages: [{ role: "user", content: "Format the tables" }],
      onEvent: (event) => {
        if (event.type === "model_turn_started") session.setModelTurn(event.turn);
        if (event.type === "model_turn_completed") surface?.recordTurn(event, "report-test");
        events.push(event);
      },
    });
    return { result, events };
  } finally {
    session.setModelTurn(null);
  }
}

const format = (handle: string): Call => ({
  name: "document.set_table_formatting", input: { table: { handle }, borders: "grid" },
});
const widths = (handle: string, widthsTwips = [3000, 3000]): Call => ({
  name: "document.set_table_column_widths", input: { table: { handle }, widthsTwips },
});

test("same-turn table borders and widths reuse an inspected handle, then expire it", async () => {
  const run = await createSession();
  const handle = run.tables[0]!.handle;
  const { result } = await runTurns(run.session, [[inspect], [format(handle), widths(handle)], [widths(handle)]]);
  assert.deepEqual(result.metrics.toolCalls.map((call) => [call.outcome, call.failureCode]), [
    ["success", undefined], ["success", undefined], ["success", undefined], ["failure", "STALE_HANDLE"],
  ]);
  assert.deepEqual(run.revisions, [1, 2]);
  assert.equal(run.appends(), 0);
  const working = Buffer.from(run.session.getWorkingDocument()!.bytes);
  assert.notDeepEqual(working, run.initial);
  await run.session.flush();
  await run.session.flush();
  assert.equal(run.appends(), 1);
  assert.deepEqual(run.stored(), working);
});

test("same-turn formatting across three tables includes widths, shading, and cell text formatting", async () => {
  const run = await createSession();
  const calls = run.tables.flatMap((table): Call[] => [
    format(table.handle), widths(table.handle),
    { name: "document.set_table_cell_shading", input: {
      table: { handle: table.handle }, updates: [{ target: { handle: table.rows[0]!.cellHandles[0] }, fill: "17365D" }],
    } },
    { name: "document.set_table_cells_formatting", input: {
      table: { handle: table.handle }, updates: [{ target: { handle: table.rows[0]!.cellHandles[1] }, fill: "17365D", textFormatting: { bold: true } }],
    } },
  ]);
  const logs: string[] = [];
  const originalInfo = console.info;
  console.info = (line?: unknown) => { logs.push(String(line)); };
  try {
    const { result } = await runTurns(run.session, [[inspect], calls]);
    assert.equal(result.metrics.toolCalls.length, 13);
    assert.ok(result.metrics.toolCalls.every((call) => call.outcome === "success"));
  } finally {
    console.info = originalInfo;
  }
  assert.ok(logs.includes("[agent] mutation_turn turn=2 sameTurnMutations=12 compatibleMutations=12 handleReuses=11"));
  assert.equal(logs.some((line) => line.startsWith("[agent] stale_handle ")), false);
  assert.equal(run.session.getWorkingMutationCount(), 12);
  // Compare saved bytes to a fresh engine sequence using semantic table selectors.
  const expected = bindDocxDocument({ binding: await createNapiDocxEngineBinding(), bytes: run.initial });
  for (const call of calls) {
    const table = run.tables.find((table) => table.handle === (call.input.table as { handle: string }).handle)!;
    assert.equal((await expected.mutate(call.name.slice("document.".length), {
      ...call.input, table: { headerCells: table.rows[0]!.cells },
    })).ok, true);
  }
  await run.session.flush();
  assert.deepEqual(run.stored(), Buffer.from(expected.currentBytes()));
});

test("paragraph style/formatting, split text formatting, and format batches preserve table and body handles in the turn", async () => {
  const run = await createSession();
  const table = run.tables[0]!;
  const { result } = await runTurns(run.session, [[inspect, { name: "document.inspect", input: { kind: "body_blocks" } }], [
    { name: "document.set_paragraph_style", input: { target: { text: "Status" }, style: "Heading 1" } },
    { name: "document.set_paragraph_formatting", input: { target: { text: "Status" }, alignment: "center" } },
    { name: "document.set_text_formatting", input: { target: { text: "Stat" }, bold: true } },
    { name: "document.batch_paragraph_formatting", input: { operations: [{ target: { text: "Status" }, alignment: "left" }] } },
    { name: "document.set_text_formatting", input: { target: { text: "Item 0" }, italic: true } },
    widths(table.handle),
    { name: "document.insert_paragraph", input: { text: "Opening", placement: { kind: "before", handle: "b0" } } },
  ]]);
  assert.ok(result.metrics.toolCalls.every((call) => call.outcome === "success"));
  assert.equal(run.session.getWorkingMutationCount(), 7);
});

test("a structural row delete expires sibling cell handles and keeps the failure fuse", async () => {
  const run = await createSession();
  const table = run.tables[0]!;
  const { result, events } = await runTurns(run.session, [[inspect], [
    format(table.handle),
    { name: "document.delete_table_row", input: { table: { handle: table.handle }, row: { handle: table.rows[1]!.handle } } },
    { name: "document.set_table_cell_shading", input: { table: { handle: table.handle }, updates: [{ target: { handle: table.rows[1]!.cellHandles[0] }, fill: "FFFFFF" }] } },
    widths(table.handle),
  ]]);
  assert.equal(result.metrics.toolCalls.at(-1)?.failureCode, "STALE_HANDLE");
  assert.ok(events.some((event) => event.type === "tool_skipped" && event.reason === "PRIOR_MUTATION_FAILED"));
  assert.equal(run.session.getWorkingMutationCount(), 2);
  await run.session.flush();
  const saved = await (await createNapiDocxEngineBinding()).inspectDocx(run.stored(), { focus: { kind: "tables" } });
  assert.deepEqual(saved.tables!.items[0]!.rows.map((row) => row.cells), [["Item 0", "Owner"], ["Build", "Bob"]]);
});

test("a genuine invalid width stops later siblings and preserves the earlier formatting", async () => {
  const run = await createSession();
  const handle = run.tables[0]!.handle;
  const { result, events } = await runTurns(run.session, [[inspect], [format(handle), widths(handle, [3000]), widths(handle)]]);
  assert.equal(result.metrics.toolCalls.at(-1)?.failureCode, "INVALID_OPERATION");
  assert.ok(events.some((event) => event.type === "tool_skipped" && event.reason === "PRIOR_MUTATION_FAILED"));
  assert.deepEqual(run.revisions, [1]);
  const expected = bindDocxDocument({ binding: await createNapiDocxEngineBinding(), bytes: run.initial });
  assert.equal((await expected.mutate("set_table_formatting", { table: { headerCells: run.tables[0]!.rows[0]!.cells }, borders: "grid" })).ok, true);
  await run.session.flush();
  assert.equal(run.appends(), 1);
  assert.deepEqual(run.stored(), Buffer.from(expected.currentBytes()));
});

test("body, table, row, and column changes invalidate handles before siblings can retarget", async () => {
  const changes: Call[] = [
    { name: "document.delete_table", input: { table: { handle: "t0" } } },
    { name: "document.create_table", input: { rows: [["New"], ["Value"]], placement: { kind: "start" } } },
    { name: "document.insert_table_rows", input: { table: { handle: "t0" }, after: { handle: "t0:r0" }, rows: [["New", "Owner"]] } },
    { name: "document.insert_table_column", input: { table: { handle: "t0", headerCells: ["Item 0", "Owner"] }, afterColumnHandle: "t0:c0", header: "Extra", cells: ["A", "B"] } },
    { name: "document.delete_table_column", input: { table: { handle: "t0" }, columnHandle: "t0:c0" } },
    { name: "document.insert_paragraph", input: { text: "Opening", placement: { kind: "start" } } },
    { name: "document.delete_paragraph", input: { target: { text: "Status" } } },
  ];
  for (const change of changes) {
    const run = await createSession();
    const { result, events } = await runTurns(run.session, [[inspect], [change, widths(run.tables[1]!.handle)]]);
    assert.deepEqual(result.metrics.toolCalls.map((call) => [call.outcome, call.failureCode]), [
      ["success", undefined], ["success", undefined], ["failure", "STALE_HANDLE"],
    ], change.name);
    assert.equal(events.some((event) => event.type === "tool_skipped"), false, change.name);
    assert.equal(run.session.getWorkingMutationCount(), 1, change.name);
  }
});

test("content edits expire sibling handles; a fresh inspect permits a later turn", async () => {
  for (const contentEdit of [
    { name: "document.replace_text", input: { target: { text: "Status" }, expectedCurrentText: "Status", replacement: "Updated" } },
    { name: "document.set_table_cells_text", input: { table: { handle: "t0" }, updates: [{ target: { handle: "t0:r1:c0" }, expectedCurrentText: "Plan", replacement: "Updated" }] } },
  ]) {
    const run = await createSession();
    const handle = run.tables[0]!.handle;
    const { result } = await runTurns(run.session, [[inspect], [contentEdit, widths(handle)], [inspect], [widths(handle)]]);
    assert.deepEqual(result.metrics.toolCalls.map((call) => call.failureCode), [undefined, undefined, "STALE_HANDLE", undefined, undefined]);
    assert.equal(run.session.getWorkingMutationCount(), 2);
  }
});

test("a failed operation without applied changes does not expire otherwise current handles", async () => {
  const run = await createSession();
  const handle = run.tables[0]!.handle;
  const { result } = await runTurns(run.session, [[inspect], [widths(handle, [3000])], [widths(handle)]]);
  assert.deepEqual(result.metrics.toolCalls.map((call) => call.failureCode), [undefined, "INVALID_OPERATION", undefined]);
  assert.deepEqual(run.revisions, [1]);
});


test("recurring report edits complete on the common surface with zero discovery turns", async () => {
  const run = await createSession();
  const finish = createFinishTool();
  const surface = createToolSurface({ ...run.session.tools, [finish.name]: finish.tool });
  const table = { headerCells: ["Item 0", "Owner"] };
  const { result } = await runTurns(run.session, [
    [{ name: "document.batch_replace_text", input: { operations: [{ target: { text: "Status" }, expectedCurrentText: "Status", replacement: "October" }] } }],
    [inspect],
    [{ name: "document.delete_table_row", input: { table, row: { handle: run.tables[0]!.rows[2]!.handle } } }],
    [{ name: "document.set_table_cells_text", input: { table, updates: [{ target: { rowLabel: "Plan", columnHeader: "Owner" }, expectedCurrentText: "Alice", replacement: "Alicia" }] } }],
    [{ name: "document.replace_text", input: { target: { text: "October" }, expectedCurrentText: "October", replacement: "October Report" } }],
    [{ name: "finish", input: {} }],
  ], surface);
  assert.equal(result.stopReason, "finish_tool");
  assert.ok(result.metrics.toolCalls.every((call) => call.outcome === "success"));
  assert.equal(run.session.getWorkingMutationCount(), 4);
  assert.equal(surface.summary().discoveryTurnCount, 0);
  assert.deepEqual(surface.summary().groupsLoaded, []);
  assert.ok(result.metrics.modelTurns.every((turn) => turn.exposedToolCount === 15));
  await run.session.flush();
  assert.equal(run.appends(), 1);
  const binding = await createNapiDocxEngineBinding();
  const saved = await binding.inspectDocx(run.stored(), { focus: { kind: "body_blocks" } });
  assert.match(JSON.stringify(saved), /October Report/);
  const tables = (await binding.inspectDocx(run.stored(), { focus: { kind: "tables" } })).tables!.items;
  assert.equal(tables[0]!.rows.length, 2);
  assert.match(JSON.stringify(tables[0]), /Alicia/);
});
