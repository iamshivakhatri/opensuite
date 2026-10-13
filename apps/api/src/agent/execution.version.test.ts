import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bindDocxDocument,
  buildMinimalDocx,
  createNapiDocxEngineBinding,
} from "@opensuite/engine-client";

import { createDocumentTools } from "./document-tools.js";
import { createPrimaryDocxTools } from "./docx-tools.js";

test("agent-core document mutation tool advances immutable version via host persist", async () => {
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

test("blank DOCX uses semantic placement and logs rejected handles without changing stale rules", async () => {
  const binding = await createNapiDocxEngineBinding();
  const blank = Buffer.from(binding.createBlankDocx());
  const tools = await createPrimaryDocxTools({
    binding, ownerUserId: "user-1", workspaceId: "ws-1", documentId: "doc-1", versionId: "v1",
    documents: {
      getOwnedDocument: async () => ({ format: "docx", workspaceId: "ws-1" }) as never,
      readExactVersionBytes: async () => blank,
      appendDocumentVersion: async () => { throw new Error("unused"); },
      createBlankDocxDocument: async () => { throw new Error("unused"); },
      createOfficeDocumentFromBytes: async () => { throw new Error("unused"); },
    },
  });
  assert.ok(tools);
  const call = { toolCallId: "blank", messages: [], context: undefined as never };
  const inspect = () => tools.tools["document.inspect"]!.execute!({ kind: "body_blocks" }, call) as Promise<{
    bodyBlocks: { items: { handle: string; text: string }[] };
  }>;
  const insert = (texts: string[], placement: Record<string, string>) =>
    tools.tools["document.insert_paragraphs"]!.execute!({ texts, placement }, call) as Promise<{ ok: boolean; reasonCode?: string }>;

  assert.deepEqual((await inspect()).bodyBlocks.items, []);
  const logs: string[] = [];
  const originalInfo = console.info;
  console.info = (message?: unknown) => { logs.push(String(message)); };
  let rejected;
  try {
    rejected = await insert(["Wrong"], { kind: "before", handle: "b999" });
  } finally {
    console.info = originalInfo;
  }
  assert.equal(rejected.reasonCode, "STALE_HANDLE");
  assert.equal((rejected as { staleCause?: string }).staleCause, "unregistered_handle");
  assert.equal((rejected as { recoveryKind?: string }).recoveryKind, "reinspect");
  const diagnostic = JSON.parse(logs.find((line) => line.startsWith("[agent] stale_handle "))!.slice("[agent] stale_handle ".length));
  assert.equal(diagnostic.tool, "document.insert_paragraphs");
  assert.equal(diagnostic.documentId, "doc-1");
  assert.equal(diagnostic.versionId, "v1");
  assert.equal(diagnostic.selectorKind, "before");
  assert.equal(diagnostic.providedHandle, "b999");
  assert.equal(diagnostic.registeredHandleCount, 0);
  assert.equal(diagnostic.providedHandleRegistered, false);
  assert.equal(diagnostic.lastHandleEvent, "inspect");

  assert.equal((await insert(["Still wrong"], { kind: "before", handle: "" })).reasonCode, "STALE_HANDLE");
  assert.deepEqual((await inspect()).bodyBlocks.items, []);
  assert.equal((await insert(["First", "Second"], { kind: "end", handle: "" })).ok, true);
  assert.equal((await insert(["Third"], { kind: "end" })).ok, true);
  assert.equal((await tools.tools["document.insert_paragraph"]!.execute!({
    text: "Opening", placement: { kind: "start", handle: "" },
  }, call) as { ok: boolean }).ok, true);
  const firstHandle = (await inspect()).bodyBlocks.items[0]!.handle;
  assert.equal((await insert(["Before"], { kind: "before", handle: firstHandle })).ok, true);
  const stale = await insert(["Stale"], { kind: "before", handle: firstHandle });
  assert.equal(stale.reasonCode, "STALE_HANDLE");
  assert.equal((stale as { staleCause?: string }).staleCause, "mutation_since_inspect");
  assert.equal((await tools.tools["document.create_table"]!.execute!({
    rows: [["Header"], ["Value"]], placement: { kind: "end", handle: "" },
  }, call) as { ok: boolean }).ok, true);
  const turnHandle = (await inspect()).bodyBlocks.items[0]!.handle;
  tools.setModelTurn(1);
  const nextTurn = await insert(["Later"], { kind: "before", handle: turnHandle });
  assert.equal((nextTurn as { staleCause?: string }).staleCause, "model_turn_boundary");
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
      getOwnedDocument: async () => ({ format: "docx", workspaceId: "ws-1" }) as never,
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
      getOwnedDocument: async () => ({ format: "docx", workspaceId: "ws-1" }) as never,
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
  const binding = await createNapiDocxEngineBinding();
  assert.equal(binding.getDocxCapabilities().engineVersion, "0.1.7");
  assert.ok(binding.getDocxCapabilities().formats.find((format) => format.format === "docx")?.capabilities.includes("set_table_cells_formatting"));
  const tools = await createPrimaryDocxTools({
    binding, ownerUserId: "user-1", workspaceId: "ws-1", documentId: "doc-1", versionId: "v1",
    documents: {
      getOwnedDocument: async () => ({ format: "docx", workspaceId: "ws-1" }) as never,
      readExactVersionBytes: async () => Buffer.from(buildMinimalDocx(["Status"])),
      appendDocumentVersion: async () => { throw new Error("unused"); },
      createBlankDocxDocument: async () => { throw new Error("unused"); },
      createOfficeDocumentFromBytes: async () => { throw new Error("unused"); },
    },
  });
  assert.ok(tools);
  assert.ok(tools.tools["document.set_table_cells_formatting"]);
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
  assert.equal(tools.getWorkingRevision(), 2);
  assert.notDeepEqual(Buffer.from(tools.getWorkingDocument()!.bytes), before);
  const stale = await execute("document.set_table_cells_formatting", {
    table: { handle: table.handle }, updates,
  });
  assert.equal(stale.reasonCode, "STALE_HANDLE");
  assert.equal((stale as { staleCause?: string }).staleCause, "mutation_since_inspect");
  assert.equal((stale as { recoveryKind?: string }).recoveryKind, "use_semantic_selector");
  assert.deepEqual((stale as { diagnostics?: unknown[] }).diagnostics, [{
    code: "STALE_HANDLE", severity: "error", message: "Handle is no longer valid.",
    operation: "set_table_cells_formatting", staleCause: "mutation_since_inspect",
    recoveryKind: "use_semantic_selector", retryable: false,
  }]);
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
      getOwnedDocument: async () => ({ format: "docx", workspaceId: "ws-1" }) as never,
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
  const unknownHandle = await insert.execute!({ text: "Bad", placement: { kind: "before", handle: "b999" } }, call) as { reasonCode: string; staleCause?: string };
  assert.equal(unknownHandle.reasonCode, "STALE_HANDLE");
  assert.equal(unknownHandle.staleCause, "unregistered_handle");
  const fresh = await inspect.execute!({ kind: "body_blocks" }, call) as { bodyBlocks: { items: { handle: string }[] } };
  const handle = fresh.bodyBlocks.items[0]!.handle;
  assert.equal((await insert.execute!({ text: "No target", placement: { kind: "before", handle } }, call) as { ok: boolean }).ok, true);
  assert.equal((await insert.execute!({ text: "Stale", placement: { kind: "before", handle } }, call) as { reasonCode: string }).reasonCode, "STALE_HANDLE");
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
      getOwnedDocument: async () => ({ format: "docx", workspaceId: "ws-1" }) as never,
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
    getOwnedDocument: async () => ({ format: "docx", workspaceId: "ws-1" }) as never,
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
      getOwnedDocument: async () => ({ format: "docx", workspaceId: "ws-1" }) as never,
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


test("Northstar targets preserve contents, neighbors, and handle document/version boundaries", async (t) => {
  const binding = await createNapiDocxEngineBinding();
  const seed = bindDocxDocument({ binding, bytes: buildMinimalDocx([
    "Pricing .... 4", "Executive summary: Northstar", "Pricing", "Commercial terms: Northstar", "Unique deadline",
  ]) });
  assert.equal((await seed.mutate("set_paragraph_style", { target: { text: "Pricing", occurrence: 1 }, style: "Heading 1" })).ok, true);
  const kpi = [["Metric", "Baseline", "Target", "Owner"], ["Detection", "15", "10", "Sam"], ["Response", "20", "12", "Ada"]];
  const pricing = [["Line item", "Amount"], ["Setup", "Northstar"], ["Support", "200"]];
  for (const rows of [kpi, pricing, [["Value", "Value"], ["One", "Two"]]]) {
    assert.equal((await seed.mutate("create_table", { rows, placement: { kind: "end" } })).ok, true);
  }
  const saved = Buffer.from(seed.currentBytes());
  if (!(await binding.inspectDocx(saved, { focus: { kind: "headings" } })).headings?.items[0]?.textTarget) return t.skip("Requires the Phase 3 local native engine");
  const session = await createPrimaryDocxTools({
    binding, ownerUserId: "user", workspaceId: "workspace", documentId: "first", versionId: "v1",
    documents: {
      getOwnedDocument: async (id) => ({ id, format: "docx", workspaceId: "workspace", latestVersion: { id: "v1" } }) as never,
      readExactVersionBytes: async () => saved,
      appendDocumentVersion: async () => { throw new Error("unused"); },
      createBlankDocxDocument: async () => { throw new Error("unused"); },
      createOfficeDocumentFromBytes: async () => { throw new Error("unused"); },
    },
  });
  assert.ok(session);
  const call = { toolCallId: "target", messages: [], context: undefined as never };
  const execute = (name: string, input: unknown) => session.tools[name]!.execute!(input, call) as Promise<{ ok: boolean; reasonCode?: string }>;
  const tables = async () => await session.tools["document.inspect"]!.execute!({ kind: "tables" }, call) as Awaited<ReturnType<typeof binding.inspectDocx>>;
  const old = (await tables()).tables!.items[0]!;
  assert.equal((await execute("workspace.select_document", { documentId: "second" })).ok, true);
  const current = (await tables()).tables!.items[0]!;
  assert.notEqual(old.handle, current.handle);
  assert.equal((await execute("document.set_table_formatting", { table: { handle: old.handle }, borders: "grid" })).reasonCode, "STALE_HANDLE");
  assert.equal(session.getWorkingMutationCount(), 0);
  session.setModelTurn(1);
  assert.equal((await execute("document.set_table_formatting", { table: { handle: current.handle, headerCells: ["Wrong"] }, borders: "grid" })).reasonCode, "EXPECTED_TEXT_MISMATCH");
  assert.equal((await execute("document.set_table_cells_formatting", {
    table: { handle: current.handle }, updates: [{ target: { row: { kind: "header" }, column: { kind: "header", text: "Metric" } }, fill: "D9E2F3" }],
  })).ok, true);
  assert.equal((await execute("document.set_table_cells_formatting", {
    table: { handle: current.handle }, updates: [{ target: { handle: current.rows[0]!.cellHandles[1] }, textFormatting: { bold: true } }],
  })).ok, true);
  const beforeAmbiguous = Buffer.from(session.getWorkingDocument()!.bytes);
  assert.equal((await execute("document.set_table_cells_formatting", {
    table: { headerCells: ["Value", "Value"] }, updates: [{ target: { row: { kind: "header" }, column: { kind: "header", text: "Value" } }, fill: "ABCDEF" }],
  })).reasonCode, "TARGET_AMBIGUOUS");
  assert.equal((await execute("document.replace_text", { target: { text: "Northstar" }, expectedCurrentText: "Northstar", replacement: "Blue Harbor" })).reasonCode, "TARGET_AMBIGUOUS");
  assert.deepEqual(Buffer.from(session.getWorkingDocument()!.bytes), beforeAmbiguous);
  const found = await session.tools["document.find"]!.execute!({ text: "Unique deadline" }, call) as Awaited<ReturnType<typeof binding.findDocxText>>;
  assert.equal((await execute("document.replace_text", { target: found.matches[0]!.target ?? { text: found.matches[0]!.text, occurrence: found.matches[0]!.occurrence }, expectedCurrentText: "Unique deadline", replacement: "New deadline" })).ok, true);
  assert.equal((await execute("document.set_table_formatting", { table: { handle: current.handle }, borders: "grid" })).reasonCode, "STALE_HANDLE");
  const headings = await session.tools["document.inspect"]!.execute!({ kind: "headings" }, call) as Awaited<ReturnType<typeof binding.inspectDocx>>;
  const target = headings.headings!.items[0]!.textTarget;
  if (!target) throw new Error("Phase 3 requires the updated native engine's textTarget output");
  assert.deepEqual(target, { text: "Pricing", occurrence: 1 });
  assert.equal((await execute("document.replace_text", { target, expectedCurrentText: "Pricing", replacement: "Fees" })).ok, true);
  session.setModelTurn(2);
  const fresh = (await tables()).tables!.items[0]!;
  assert.equal((await execute("document.set_table_cells_text", { table: { handle: fresh.handle }, updates: [
    { target: { handle: fresh.rows[1]!.cellHandles[2] }, expectedCurrentText: "10", replacement: "8" },
    { target: { row: { kind: "index", index: 2, expectedFirstCellText: "Response" }, column: { kind: "index", index: 2, expectedHeaderText: "Target" } }, expectedCurrentText: "12", replacement: "9" },
  ] })).ok, true);
  assert.equal((await execute("document.set_table_formatting", { table: { handle: fresh.handle }, borders: "grid" })).reasonCode, "STALE_HANDLE");
  const refreshed = (await tables()).tables!.items[0]!;
  assert.notEqual(refreshed.handle, fresh.handle);
  assert.equal((await execute("document.set_table_formatting", { table: { handle: fresh.handle }, borders: "grid" })).reasonCode, "STALE_HANDLE");
  assert.equal((await execute("document.set_table_formatting", { table: { handle: refreshed.handle }, borders: "grid" })).ok, true);
  const beforeBatch = Buffer.from(session.getWorkingDocument()!.bytes);
  assert.equal((await execute("document.batch_replace_text", { operations: [{ target: { text: "Fees", handle: old.handle }, expectedCurrentText: "Fees", replacement: "Wrong" }] })).reasonCode, "STALE_HANDLE");
  assert.deepEqual(Buffer.from(session.getWorkingDocument()!.bytes), beforeBatch);
  const final = await binding.inspectDocx(session.getWorkingDocument()!.bytes, { focus: { kind: "tables" } });
  assert.deepEqual(final.tables!.items[0]!.rows.map(row => row.cells), [kpi[0], ["Detection", "15", "8", "Sam"], ["Response", "20", "9", "Ada"]]);
  assert.deepEqual(final.tables!.items[1]!.rows.map(row => row.cells), pricing);
  const paragraphs = await binding.inspectDocx(session.getWorkingDocument()!.bytes, { focus: { kind: "paragraphs" } });
  assert.deepEqual(paragraphs.paragraphs!.items.map(item => item.text), ["Pricing .... 4", "Executive summary: Northstar", "Fees", "Commercial terms: Northstar", "New deadline"]);
});
