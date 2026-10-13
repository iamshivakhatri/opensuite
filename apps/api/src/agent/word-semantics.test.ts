import assert from "node:assert/strict";
import { test } from "node:test";
import { createNapiDocxEngineBinding, type DocxCommentInspection, type DocxRevisionInspection, type DocxFieldInspection } from "@opensuite/engine-client";
import { createPrimaryDocxTools } from "./docx-tools.js";
import { createToolSurface } from "./capabilities/runtime/tool-surface.js";

// Uses the actual native engine and API tool/session/save path, with no model calls.
test("Phase 7: Northstar mixed Word semantics survive API edits; refused edits save no version", async t => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.executeDocxReplaceTextWithTrackedChange || !binding.executeDocxInsertToc || !binding.executeDocxAddComment) return t.skip("local Word semantics engine required");
  let stored = binding.createBlankDocx();
  for (const text of ["Northstar Project Lighthouse", "Prepared for the client. Review scope for pilot."]) {
    stored = (await binding.executeDocxInsertParagraph(stored, { text, placement: { kind: "end" } })).output!;
  }
  stored = (await binding.executeDocxAddComment(stored, { target: { text: "Review scope" }, text: "Keep the agreed scope.", author: "Reviewer", date: "2026-10-13T12:00:00Z" })).output!;
  stored = (await binding.executeDocxReplaceTextWithTrackedChange(stored, { target: { text: "pilot" }, replacement: "rollout", author: "Editor", date: "2026-10-13T12:00:00Z" })).output!;
  stored = (await binding.executeDocxInsertToc(stored, { placement: { kind: "start" }, title: "Contents" })).output!;
  stored = (await binding.executeDocxInsertFields!(stored, { placement: { kind: "end" }, content: [{ kind: "text", text: "Page " }, { kind: "page" }, { kind: "text", text: " of " }, { kind: "numPages" }] })).output!;
  const original = Buffer.from(stored);
  const originalComments = await binding.inspectDocxComments!(stored);
  const originalRevisions = await binding.inspectDocxTrackedChanges!(stored);
  const originalFields = await binding.inspectDocxFields!(stored);
  assert.equal(originalComments.total, 1);
  assert.equal(originalRevisions.total, 2);
  assert.equal(originalFields.total, 3);
  let saves = 0;
  const session = await createPrimaryDocxTools({ binding, ownerUserId: "user", workspaceId: "workspace", documentId: "doc", versionId: "v1",
    documents: { getOwnedDocument: async () => ({ format: "docx", workspaceId: "workspace" }) as never,
      readExactVersionBytes: async () => stored,
      appendDocumentVersion: async ({ bytes }: { bytes: Uint8Array }) => { saves++; stored = Buffer.from(bytes); return { version: { id: "v2", versionNumber: 2 } } as never; } } as never,
  });
  assert.ok(session);
  const surface = createToolSurface(session.tools);
  assert.equal(surface.session.load(["document.comments", "document.revisions", "document.fields", "document.delete_paragraph", "document.set_paragraph_style"]).ok, true);
  const tools = surface.projectTools();
  const call = { toolCallId: "word-semantics", messages: [], context: undefined as never };
  const run = async (name: string, input: Record<string, unknown>) => await tools[`document.${name}`]!.execute!(input, call) as { ok: boolean; reasonCode?: string };
  assert.equal((await run("replace_text", { target: { text: "client. Review" }, replacement: "changed", expectedCurrentText: "client. Review" })).reasonCode, "UNSAFE_TEXT_BOUNDARY");
  assert.equal((await run("replace_text", { target: { text: "Page ? of ?" }, replacement: "Page 1 of 1", expectedCurrentText: "Page ? of ?" })).ok, false);
  assert.equal((await run("delete_paragraph", { target: { text: "Review scope" } })).ok, false);
  assert.equal(session.getWorkingRevision(), 0);
  assert.equal(session.getWorkingDocument(), null);
  await session.flush();
  assert.equal(saves, 0);
  assert.deepEqual(Buffer.from(stored), original);

  assert.equal((await run("replace_text", { target: { text: "Prepared" }, replacement: "Approved", expectedCurrentText: "Prepared" })).ok, true);
  assert.equal((await run("set_paragraph_style", { target: { text: "Page " }, style: "Normal" })).ok, true);
  const comments = (await tools["document.inspect_comments"]!.execute!({}, call) as { comments: DocxCommentInspection }).comments;
  const revisions = (await tools["document.inspect_tracked_changes"]!.execute!({}, call) as { revisions: DocxRevisionInspection }).revisions;
  const fields = (await tools["document.inspect_fields"]!.execute!({}, call) as { fields: DocxFieldInspection }).fields;
  assert.equal(comments.comments[0]!.anchoredText, "Review scope");
  assert.equal(comments.comments[0]!.text, originalComments.comments[0]!.text);
  assert.equal(comments.comments[0]!.author, "Reviewer");
  assert.deepEqual(revisions.revisions.map(r => [r.id, r.revisionType, r.text, r.author, r.date]), originalRevisions.revisions.map(r => [r.id, r.revisionType, r.text, r.author, r.date]));
  assert.deepEqual(fields, originalFields);
  await session.flush();
  assert.equal(saves, 1);
  assert.equal((await binding.findDocxText(stored, { text: "Approved" })).matches.length, 1);
  assert.deepEqual(await binding.inspectDocxFields!(stored), originalFields);
  assert.equal((await binding.inspectDocxComments!(stored)).comments[0]!.anchoredText, "Review scope");
  assert.equal((await binding.inspectDocxTrackedChanges!(stored)).total, 2);
});
