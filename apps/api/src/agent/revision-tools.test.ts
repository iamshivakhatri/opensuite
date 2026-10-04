import assert from "node:assert/strict";
import { test } from "node:test";
import { createNapiDocxEngineBinding, type DocxRevisionInspection } from "@opensuite/engine-client";
import { createPrimaryDocxTools } from "./docx-tools.js";
import { createToolSurface } from "./capabilities/runtime/tool-surface.js";

test("revision inspection loads lazily, preserves bytes, and saves no version", async t => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("inspect_tracked_changes")) return t.skip("local revision engine required");
  const bytes = binding.createBlankDocx();
  const before = Buffer.from(bytes);
  let appends = 0;
  const session = await createPrimaryDocxTools({ binding, ownerUserId: "user", workspaceId: "workspace", documentId: "doc", versionId: "v1",
    documents: { getOwnedDocument: async () => ({ format: "docx" }) as never, readExactVersionBytes: async () => bytes,
      appendDocumentVersion: async () => { appends++; throw new Error("read must not save"); } } as never,
  });
  assert.ok(session);
  const surface = createToolSurface(session.tools);
  assert.equal(surface.initialTools["document.inspect_tracked_changes"], undefined);
  assert.equal(surface.session.load(["document.revisions"]).ok, true);
  const tool = surface.projectTools()["document.inspect_tracked_changes"]!;
  const result = await tool.execute!({ limit: 1 }, { toolCallId: "revisions", messages: [], context: undefined as never }) as { revisions: DocxRevisionInspection };
  assert.equal(result.revisions.ok, true);
  assert.equal(result.revisions.total, 0);
  assert.deepEqual(result.revisions.revisions, []);
  assert.deepEqual(await binding.inspectDocxTrackedChanges!(bytes), result.revisions);
  await session.flush();
  assert.equal(appends, 0);
  assert.deepEqual(Buffer.from(bytes), before);
});


test("tracked change tools load lazily and persist one verified version", async t => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("replace_text_with_tracked_change")) return t.skip("local authoring engine required");
  let stored = binding.createBlankDocx();
  for (const text of ["Revenue improved in Q3.", "Revenue was approximately $2.1M.", "Replace old amount."]) {
    stored = (await binding.executeDocxInsertParagraph(stored, { text, placement: { kind: "end" } })).output!;
  }
  let appends = 0;
  const session = await createPrimaryDocxTools({ binding, ownerUserId: "user", workspaceId: "workspace", documentId: "doc", versionId: "v1",
    documents: { getOwnedDocument: async () => ({ format: "docx" }) as never, readExactVersionBytes: async () => stored,
      appendDocumentVersion: async ({ bytes }: { bytes: Uint8Array }) => { appends++; stored = Buffer.from(bytes); return { version: { id: "v2", versionNumber: 2 } } as never; } } as never,
  });
  assert.ok(session);
  const surface = createToolSurface(session.tools);
  for (const name of ["insert_tracked_text", "delete_tracked_text", "replace_text_with_tracked_change"]) assert.equal(surface.initialTools[`document.${name}`], undefined);
  assert.equal(surface.session.load(["document.revisions"]).ok, true);
  const tools = surface.projectTools();
  const call = { toolCallId: "tracked-edit", messages: [], context: undefined as never };
  const run = async (name: string, input: Record<string, unknown>) => tools[`document.${name}`]!.execute!(input, call) as Promise<{ ok: boolean; reasonCode?: string }>;
  assert.equal((await run("insert_tracked_text", { target: { text: "improved" }, text: " materially", author: "Sarah" })).ok, true);
  assert.equal((await run("delete_tracked_text", { target: { text: "approximately " }, author: "Sarah" })).ok, true);
  const stale = await run("replace_text_with_tracked_change", { target: { text: "old amount", handle: "stale" }, replacement: "new amount", author: "Sarah" });
  assert.equal(stale.reasonCode, "STALE_HANDLE");
  assert.equal((await run("replace_text_with_tracked_change", { target: { text: "old amount" }, replacement: "new amount", author: "Sarah" })).ok, true);
  const result = await tools["document.inspect_tracked_changes"]!.execute!({}, call) as { revisions: DocxRevisionInspection };
  assert.deepEqual(result.revisions.revisions.map(r => [r.kind, r.text]), [["insertion", " materially"], ["deletion", "approximately "], ["deletion", "old amount"], ["insertion", "new amount"]]);
  assert.ok(result.revisions.revisions.every(r => r.author === "Sarah" && Number.isFinite(Date.parse(r.date!))));
  assert.equal(appends, 0);
  await session.flush();
  assert.equal(appends, 1);
  assert.equal((await binding.inspectDocxTrackedChanges!(stored)).total, 4);
});
