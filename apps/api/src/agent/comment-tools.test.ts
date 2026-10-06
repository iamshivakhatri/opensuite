import assert from "node:assert/strict";
import { test } from "node:test";
import { createNapiDocxEngineBinding, type DocxCommentInspection } from "@opensuite/engine-client";
import { createPrimaryDocxTools } from "./docx-tools.js";
import { createToolSurface } from "./capabilities/runtime/tool-surface.js";

const call = { toolCallId: "comments", messages: [], context: undefined as never };
test("comment tools load lazily, require inspected handles, and save once", async t => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("add_comment")) return t.skip("local comments engine required");
  const inserted = await binding.executeDocxInsertParagraph(binding.createBlankDocx(), { text: "Revenue increased 12% in Q3.", placement: { kind: "end" } });
  let stored = Buffer.from(inserted.output!); let appends = 0;
  const session = await createPrimaryDocxTools({ binding, ownerUserId: "user", workspaceId: "workspace", documentId: "doc", versionId: "v1",
    documents: { getOwnedDocument: async () => ({ format: "docx" }) as never, readExactVersionBytes: async () => stored,
      appendDocumentVersion: async ({ bytes }: { bytes: Uint8Array }) => { stored = Buffer.from(bytes); appends++; return { version: { id: "v2", versionNumber: 2 } } as never; } } as never,
  });
  assert.ok(session);
  const surface = createToolSurface(session.tools);
  for (const name of ["inspect_comments", "add_comment", "update_comment", "delete_comment"]) assert.equal(surface.initialTools[`document.${name}`], undefined);
  assert.equal(surface.session.load(["document.comments"]).ok, true);
  const tools = surface.projectTools();
  const run = async (name: string, input: Record<string, unknown>) => tools[`document.${name}`]!.execute!(input, call) as Promise<{ ok: boolean }>;
  const inspect = async () => tools["document.inspect_comments"]!.execute!({}, call) as Promise<{ comments: DocxCommentInspection }>;
  assert.equal((await run("add_comment", { target: { text: "12%" }, text: "Check finance.", author: "Reviewer" })).ok, true);
  let result = await inspect(); const old = result.comments.comments[0]!.handle!;
  assert.equal(result.comments.comments[0]!.anchoredText, "12%");
  assert.equal((await run("update_comment", { handle: old, text: "Confirmed." })).ok, true);
  assert.equal((await run("delete_comment", { handle: old })).ok, false);
  result = await inspect();
  assert.equal(result.comments.comments[0]!.text, "Confirmed.");
  assert.equal((await run("delete_comment", { handle: result.comments.comments[0]!.handle! })).ok, true);
  assert.equal((await inspect()).comments.total, 0);
  assert.equal((await run("add_comment", { target: { text: "12%" }, text: "Manual review.", author: "Reviewer" })).ok, true);
  assert.equal(appends, 0); await session.flush(); assert.equal(appends, 1);
  assert.equal((await binding.inspectDocxComments!(stored)).total, 1);
});
