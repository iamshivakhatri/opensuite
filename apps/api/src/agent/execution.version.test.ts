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
