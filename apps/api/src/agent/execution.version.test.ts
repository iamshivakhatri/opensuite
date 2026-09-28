import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bindDocxDocument,
  buildMinimalDocx,
  createNapiDocxEngineBinding,
} from "@opensuite/engine-client";

import { createDocumentTools } from "./document-tools.js";
import { createPrimaryDocxTools } from "./docx-tools.js";

test("V3 document mutation tool advances immutable version via host persist", async () => {
  const binding = await createNapiDocxEngineBinding();
  const initial = new Uint8Array(buildMinimalDocx(["Before"]));
  let versionId = "v1";
  let versionNumber = 1;
  let appends = 0;

  const bound = bindDocxDocument({
    binding,
    bytes: initial,
    versionId,
    persist: async ({ bytes, baseVersionId }) => {
      assert.equal(baseVersionId, versionId);
      assert.ok(bytes.byteLength > 0);
      appends += 1;
      versionId = `v${appends + 1}`;
      versionNumber = appends + 1;
      return { versionId, versionNumber };
    },
  });

  const tools = createDocumentTools(bound);
  const mutate = tools["document.insert_paragraph"];
  assert.equal(mutate?.kind, "mutate");
  assert.ok(mutate?.execute);

  const result = await mutate.execute(
    { text: "After", placement: { kind: "end" } },
    { toolCallId: "t1", messages: [], context: undefined as never },
  );

  assert.equal(appends, 1);
  assert.equal(versionId, "v2");
  assert.equal(versionNumber, 2);
  assert.ok(result);
});

test("run-local mutations persist and emit one version at flush", async () => {
  const binding = await createNapiDocxEngineBinding();
  const initial = Buffer.from(buildMinimalDocx(["Primary"]));
  let stored = initial;
  let versionId = "ver-1";
  let versionNumber = 1;
  const advanced: Array<{ versionId: string; versionNumber: number }> = [];
  const working: number[] = [];

  const tools = await createPrimaryDocxTools({
    binding,
    ownerUserId: "user-1",
    workspaceId: "ws-1",
    documentId: "doc-1",
    versionId,
    documents: {
      getOwnedDocument: async () =>
        ({
          id: "doc-1",
          name: "Primary.docx",
          format: "docx",
          workspaceId: "ws-1",
        }) as never,
      readExactVersionBytes: async () => stored,
      appendDocumentVersion: async (input) => {
        assert.equal(input.baseVersionId, versionId);
        assert.equal(input.source, "agent");
        stored = Buffer.from(input.bytes);
        versionNumber += 1;
        versionId = `ver-${versionNumber}`;
        return {
          version: { id: versionId, versionNumber },
        } as never;
      },
      createBlankDocxDocument: async () => {
        throw new Error("unused");
      },
      createOfficeDocumentFromBytes: async () => {
        throw new Error("unused");
      },
    },
    onVersionAdvanced: async (event) => {
      advanced.push({
        versionId: event.versionId,
        versionNumber: event.versionNumber,
      });
      assert.equal(event.fromVersionId, "ver-1");
    },
    onWorkingUpdated: ({ revision }) => { working.push(revision); },
  });

  assert.ok(tools);
  assert.equal(tools.tools["document.capabilities"], undefined);
  const mutate = tools.tools["document.insert_paragraph"];
  assert.ok(mutate?.execute);
  await mutate.execute(
    { text: "Inserted", placement: { kind: "end" } },
    { toolCallId: "t1", messages: [], context: undefined as never },
  );

  assert.equal(advanced.length, 0);
  assert.deepEqual(working, [1]);
  assert.equal(tools.getWorkingDocument()?.revision, 1);
  assert.match(JSON.stringify(await binding.inspectDocx(tools.getWorkingDocument()!.bytes, { focus: { kind: "body_blocks" } })), /Inserted/);
  assert.equal(versionId, "ver-1");
  await tools.flush();
  assert.equal(advanced.length, 1);
  assert.equal(advanced[0]!.versionNumber, 2);
  assert.equal(tools.getWorkingDocument(), null);
  assert.equal(tools.tools["document.inspect"]?.kind, "read");
  assert.equal(tools.tools["document.insert_paragraph"]?.kind, "mutate");
});

test("format and text batches keep partial work, one preview per batch, and one saved version", async () => {
  const binding = await createNapiDocxEngineBinding();
  let stored = Buffer.from(buildMinimalDocx(["Alpha", "Beta", "Gamma"]));
  let appends = 0;
  const revisions: number[] = [];
  const tools = await createPrimaryDocxTools({
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
  assert.ok(tools);
  const call = { toolCallId: "batch", messages: [], context: undefined as never };
  const run = (name: string, operations: Record<string, unknown>[]) =>
    tools.tools[name]!.execute!({ operations }, call) as Promise<{
      ok: boolean; applied: number; failedIndex?: number; reasonCode?: string; diagnostics?: unknown[];
    }>;

  await tools.tools["document.inspect"]!.execute!({ kind: "body_blocks" }, call);
  assert.deepEqual(await run("document.batch_paragraph_styles", [
    { target: { text: "Alpha" }, style: "Heading 1" },
    { target: { text: "Beta" }, style: "Heading 2" },
  ]), { ok: true, capability: "set_paragraph_style", applied: 2, workingRevision: 1 });
  assert.deepEqual(revisions, [1]);
  const headings = JSON.stringify(await tools.tools["document.inspect"]!.execute!({ kind: "headings" }, call));
  assert.match(headings, /"styleName":"Heading 1"/);
  assert.match(headings, /"styleName":"Heading 2"/);
  assert.equal((await tools.tools["document.insert_paragraph"]!.execute!(
    { text: "Stale", placement: { kind: "before", handle: "b0" } }, call,
  ) as { reasonCode: string }).reasonCode, "STALE_HANDLE");

  const partial = await run("document.batch_replace_text", [
    { target: { text: "Alpha" }, expectedCurrentText: "Alpha", replacement: "First" },
    { target: { text: "Missing" }, expectedCurrentText: "Missing", replacement: "Wrong" },
    { target: { text: "Gamma" }, expectedCurrentText: "Gamma", replacement: "Skipped" },
  ]);
  assert.equal(partial.ok, false);
  assert.equal(partial.applied, 1);
  assert.equal(partial.failedIndex, 1);
  assert.ok(partial.reasonCode);
  assert.ok(partial.diagnostics?.length);
  assert.deepEqual(revisions, [1, 2]);
  assert.equal(tools.getWorkingDocument()?.revision, 2);

  assert.equal((await run("document.batch_replace_text", [
    { target: { text: "Beta" }, expectedCurrentText: "Beta", replacement: "Second" },
    { target: { text: "Gamma" }, expectedCurrentText: "Gamma", replacement: "Third" },
  ])).applied, 2);
  const current = JSON.stringify(await tools.tools["document.inspect"]!.execute!({ kind: "body_blocks" }, call));
  assert.match(current, /First/);
  assert.match(current, /Second/);
  assert.match(current, /Third/);
  assert.doesNotMatch(current, /Skipped/);
  assert.deepEqual(revisions, [1, 2, 3]);
  assert.equal((await run("document.batch_paragraph_formatting", [
    { target: { text: "First" }, alignment: "center" },
    { target: { text: "Second" }, alignment: "right" },
  ])).applied, 2);
  assert.equal((await run("document.batch_text_formatting", [
    { target: { text: "First" }, bold: true },
    { target: { text: "Second" }, italic: true },
  ])).applied, 2);
  assert.deepEqual(revisions, [1, 2, 3, 4, 5]);
  assert.equal(tools.getWorkingMutationCount(), 9);
  await tools.flush();
  assert.equal(appends, 1);
  assert.equal(tools.getWorkingDocument(), null);
  assert.match(JSON.stringify(await binding.inspectDocx(stored, { focus: { kind: "body_blocks" } })), /Third/);
});

test("header shading then table formatting and widths reuse one inspect", async () => {
  const binding = await createNapiDocxEngineBinding();
  const stored = Buffer.from(buildMinimalDocx(["Memo"]));
  const tools = await createPrimaryDocxTools({
    binding, ownerUserId: "user-1", workspaceId: "ws-1", documentId: "doc-1", versionId: "v1",
    documents: {
      getOwnedDocument: async () => ({ format: "docx" }) as never,
      readExactVersionBytes: async () => stored,
      appendDocumentVersion: async () => { throw new Error("unused"); },
      createBlankDocxDocument: async () => { throw new Error("unused"); },
      createOfficeDocumentFromBytes: async () => { throw new Error("unused"); },
    },
  });
  assert.ok(tools);
  const call = { toolCallId: "table", messages: [], context: undefined as never };
  const execute = (name: string, args: Record<string, unknown>) =>
    tools.tools[name]!.execute!(args, call) as Promise<{ ok: boolean; reasonCode?: string }>;
  assert.equal((await execute("document.create_table", {
    rows: [["Item", "Owner"], ["Plan", "Team"]], placement: { kind: "end" },
  })).ok, true);
  const inspected = await tools.tools["document.inspect"]!.execute!({ kind: "tables" }, call) as {
    tables?: { items: { handle: string; rows: { cellHandles: string[] }[] }[] };
  };
  const headerHandles = inspected.tables?.items[0]?.rows[0]?.cellHandles;
  assert.equal(headerHandles?.length, 2);
  assert.equal((await execute("document.set_table_cell_shading", {
    table: { handle: inspected.tables!.items[0]!.handle },
    updates: headerHandles!.map((handle) => ({ target: { handle }, fill: "17365D" })),
  })).ok, true);
  assert.equal((await execute("document.set_table_cell_shading", {
    table: { handle: inspected.tables!.items[0]!.handle },
    updates: [{ target: { handle: headerHandles![0] }, fill: "17365D" }],
  })).reasonCode, "STALE_HANDLE");
  const table = { headerCells: ["Item", "Owner"] };
  assert.equal((await execute("document.set_table_formatting", { table, borders: "grid" })).ok, true);
  assert.equal((await execute("document.set_table_column_widths", { table, widthsTwips: [3000, 3000] })).ok, true);
  assert.equal(tools.getWorkingRevision(), 4);
});

test("one structural header formatting call advances preview and expires inspected handles", async () => {
  const native = await createNapiDocxEngineBinding();
  let formattingCalls = 0;
  // The app is pinned to the previous native release; Rust and N-API test the new formatting itself.
  const binding = {
    ...native,
    getDocxCapabilities: () => {
      const caps = native.getDocxCapabilities();
      return { ...caps, formats: caps.formats.map((format) => ({
        ...format,
        capabilities: [...format.capabilities, "set_table_cells_formatting"],
      })) };
    },
    executeDocxSetTableCellsFormatting: async (
      bytes: Uint8Array,
      operation: { table: { handle?: string }; updates: { target: { handle: string }; fill?: string }[] },
    ) => {
      formattingCalls += 1;
      return native.executeDocxSetTableCellShading!(bytes, {
        table: operation.table,
        updates: operation.updates.map(({ target, fill }) => ({ target, fill })),
      });
    },
  };
  const tools = await createPrimaryDocxTools({
    binding, ownerUserId: "user-1", workspaceId: "ws-1", documentId: "doc-1", versionId: "v1",
    documents: {
      getOwnedDocument: async () => ({ format: "docx" }) as never,
      readExactVersionBytes: async () => Buffer.from(buildMinimalDocx(["Status"])),
      appendDocumentVersion: async () => { throw new Error("unused"); },
      createBlankDocxDocument: async () => { throw new Error("unused"); },
      createOfficeDocumentFromBytes: async () => { throw new Error("unused"); },
    },
  });
  assert.ok(tools);
  const call = { toolCallId: "format", messages: [], context: undefined as never };
  const execute = (name: string, args: Record<string, unknown>) =>
    tools.tools[name]!.execute!(args, call) as Promise<{ ok: boolean; reasonCode?: string }>;
  assert.equal((await execute("document.create_table", {
    rows: [["Status", "Owner", "Actual"], ["Open", "Alice", "10"]],
    placement: { kind: "end" },
  })).ok, true);
  const inspected = await tools.tools["document.inspect"]!.execute!({ kind: "tables" }, call) as {
    tables?: { items: { handle: string; rows: { cellHandles: string[] }[] }[] };
  };
  const table = inspected.tables!.items[0]!;
  const before = Buffer.from(tools.getWorkingDocument()!.bytes);
  const updates = table.rows[0]!.cellHandles.map((handle) => ({
    target: { handle }, fill: "17365D", textFormatting: { bold: true },
  }));
  const formatted = await execute("document.set_table_cells_formatting", {
    table: { handle: table.handle }, updates,
  });
  assert.equal(formatted.ok, true);
  assert.equal(formattingCalls, 1);
  assert.equal(tools.getWorkingRevision(), 2);
  assert.notDeepEqual(Buffer.from(tools.getWorkingDocument()!.bytes), before);
  const stale = await execute("document.set_table_cells_formatting", {
    table: { handle: table.handle }, updates,
  });
  assert.equal(stale.reasonCode, "STALE_HANDLE");
  assert.equal(formattingCalls, 1);
});

test("working reads, failed writes, and stale handles keep the last valid state", async () => {
  const binding = await createNapiDocxEngineBinding();
  let stored = Buffer.from(buildMinimalDocx(["Start"]));
  let appends = 0;
  const revisions: number[] = [];
  const tools = await createPrimaryDocxTools({
    binding,
    ownerUserId: "user-1", workspaceId: "ws-1", documentId: "doc-1", versionId: "v1",
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
  assert.ok(tools);
  const call = { toolCallId: "test", messages: [], context: undefined as never };
  const insert = tools.tools["document.insert_paragraph"]!;
  const inspect = tools.tools["document.inspect"]!;
  const read = async () => JSON.stringify(await inspect.execute!({ kind: "body_blocks" }, call));
  assert.match(await read(), /Start/);
  for (let i = 0; i < 5; i++) {
    assert.equal((await insert.execute!({ text: `Step ${i}`, placement: { kind: "end" } }, call) as { ok: boolean }).ok, true);
    assert.match(await read(), new RegExp(`Step ${i}`));
  }
  assert.equal((await tools.tools["document.set_paragraph_style"]!.execute!({
    target: { text: "Step 0" }, style: "Heading 1",
  }, call) as { ok: boolean }).ok, true);
  assert.match(await read(), /Step 0/);
  const failed = await tools.tools["document.replace_text"]!.execute!({
    target: { text: "Missing" }, expectedCurrentText: "Missing", replacement: "Wrong",
  }, call);
  assert.equal((failed as { ok: boolean }).ok, false);
  assert.deepEqual(revisions, [1, 2, 3, 4, 5, 6]);
  assert.equal((await insert.execute!({ text: "Bad", placement: { kind: "before", handle: "b999" } }, call) as { reasonCode: string }).reasonCode, "STALE_HANDLE");
  assert.equal((await insert.execute!({ text: "No target", placement: { kind: "before", handle: "b0" } }, call) as { ok: boolean }).ok, true);
  assert.equal((await insert.execute!({ text: "Stale", placement: { kind: "before", handle: "b0" } }, call) as { reasonCode: string }).reasonCode, "STALE_HANDLE");
  assert.equal(appends, 0);
  const previewBytes = Buffer.from(tools.getWorkingDocument()!.bytes);
  assert.equal(tools.getWorkingDocument()!.revision, 7);
  await tools.flush();
  await tools.flush();
  assert.equal(appends, 1);
  assert.deepEqual(stored, previewBytes);
  assert.equal(tools.getWorkingMutationCount(), 7);
  assert.match(JSON.stringify(await binding.inspectDocx(stored, { focus: { kind: "body_blocks" } })), /Step 4/);

  const continued = await createPrimaryDocxTools({
    binding, ownerUserId: "user-1", workspaceId: "ws-1", documentId: "doc-1", versionId: "v2",
    documents: {
      getOwnedDocument: async () => ({ format: "docx" }) as never,
      readExactVersionBytes: async () => stored,
      appendDocumentVersion: async () => { throw new Error("unused"); },
      createBlankDocxDocument: async () => { throw new Error("unused"); },
      createOfficeDocumentFromBytes: async () => { throw new Error("unused"); },
    },
  });
  assert.ok(continued);
  assert.match(JSON.stringify(await continued.tools["document.inspect"]!.execute!({ kind: "body_blocks" }, call)), /Step 4/);
});

test("repeated mutation failures nudge once, then success and a new run reset the count", async () => {
  const binding = await createNapiDocxEngineBinding();
  const stored = Buffer.from(buildMinimalDocx(["Start"]));
  const documents = {
    getOwnedDocument: async () => ({ format: "docx" }) as never,
    readExactVersionBytes: async () => stored,
    appendDocumentVersion: async () => { throw new Error("unused"); },
    createBlankDocxDocument: async () => { throw new Error("unused"); },
    createOfficeDocumentFromBytes: async () => { throw new Error("unused"); },
  };
  const createRun = () => createPrimaryDocxTools({
    binding, documents, ownerUserId: "user-1", workspaceId: "ws-1", documentId: "doc-1", versionId: "v1",
  });
  const run = await createRun();
  assert.ok(run);
  const call = { toolCallId: "test", messages: [], context: undefined as never };
  const insert = (args: Record<string, unknown>) => run.tools["document.insert_paragraph"]!.execute!(args, call) as Promise<{
    ok: boolean; reasonCode?: string; retryGuidance?: string;
  }>;
  const bad = { text: "Bad", placement: { kind: "before", handle: "b999" } };

  const first = await insert(bad);
  assert.equal(first.reasonCode, "STALE_HANDLE");
  assert.equal(first.retryGuidance, undefined);
  const second = await insert(bad);
  assert.equal(second.reasonCode, "STALE_HANDLE");
  assert.match(second.retryGuidance ?? "", /For an explicit requirement, retry only with a changed target or method/);
  assert.equal((await insert(bad)).retryGuidance, undefined); // Guidance does not block a required retry.

  assert.equal((await run.tools["document.set_paragraph_formatting"]!.execute!({
    target: { text: "Start" }, alignment: "center",
  }, call) as { ok: boolean }).ok, true);
  assert.equal((await insert(bad)).retryGuidance, undefined); // Unrelated formatting does not reset the count.

  assert.equal((await insert({ text: "Done", placement: { kind: "end" } })).ok, true);
  assert.equal((await insert(bad)).retryGuidance, undefined);
  assert.ok((await insert(bad)).retryGuidance);

  const nextRun = await createRun();
  assert.ok(nextRun);
  const next = await nextRun.tools["document.insert_paragraph"]!.execute!(bad, call) as { retryGuidance?: string };
  assert.equal(next.retryGuidance, undefined);
});

test("failed final append leaves the previous persisted version untouched", async () => {
  const binding = await createNapiDocxEngineBinding();
  const original = Buffer.from(buildMinimalDocx(["Original"]));
  const tools = await createPrimaryDocxTools({
    binding, ownerUserId: "user-1", workspaceId: "ws-1", documentId: "doc-1", versionId: "v1",
    documents: {
      getOwnedDocument: async () => ({ format: "docx" }) as never,
      readExactVersionBytes: async () => original,
      appendDocumentVersion: async () => { throw new Error("storage unavailable"); },
      createBlankDocxDocument: async () => { throw new Error("unused"); },
      createOfficeDocumentFromBytes: async () => { throw new Error("unused"); },
    },
  });
  assert.ok(tools);
  await tools.tools["document.insert_paragraph"]!.execute!({ text: "Unsaved", placement: { kind: "end" } }, { toolCallId: "m1", messages: [], context: undefined as never });
  await assert.rejects(tools.flush(), /storage unavailable/);
  assert.equal(tools.getActiveVersionId(), "v1");
  assert.doesNotMatch(JSON.stringify(await binding.inspectDocx(original, { focus: { kind: "body_blocks" } })), /Unsaved/);
});
