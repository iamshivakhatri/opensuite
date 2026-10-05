import assert from "node:assert/strict";
import { test } from "node:test";
import { createNapiDocxEngineBinding, type DocxNoteInspection } from "@opensuite/engine-client";
import { createPrimaryDocxTools } from "./docx-tools.js";
import { createToolSurface } from "./capabilities/runtime/tool-surface.js";
import { verifyDocumentUpdate, hasBlockingVerificationFailure } from "./document-verification.js";

const call = { toolCallId: "notes", messages: [], context: undefined as never };
test("notes load lazily, use fresh handles, save once, and verify references", async t => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("insert_note")) return t.skip("local notes engine required");
  const inserted = await binding.executeDocxInsertParagraph(binding.createBlankDocx(), { text: "Revenue improved. Margin increased.", placement: { kind: "end" } });
  const before = inserted.output!;
  let stored = Buffer.from(before); let appends = 0;
  const session = await createPrimaryDocxTools({ binding, ownerUserId: "user", workspaceId: "workspace", documentId: "doc", versionId: "v1",
    documents: { getOwnedDocument: async () => ({ format: "docx" }) as never, readExactVersionBytes: async () => stored,
      appendDocumentVersion: async ({ bytes }: { bytes: Uint8Array }) => { stored = Buffer.from(bytes); appends++; return { version: { id: "v2", versionNumber: 2 } } as never; } } as never,
  });
  assert.ok(session);
  const surface = createToolSurface(session.tools);
  for (const name of ["inspect_notes", "insert_note", "update_note", "delete_note"]) assert.equal(surface.initialTools[`document.${name}`], undefined);
  assert.equal(surface.session.load(["document.notes"]).ok, true);
  const tools = surface.projectTools();
  const run = async (name: string, input: Record<string, unknown>) => tools[`document.${name}`]!.execute!(input, call) as Promise<{ ok: boolean }>;
  const inspect = async () => tools["document.inspect_notes"]!.execute!({}, call) as Promise<{ notes: DocxNoteInspection }>;
  assert.equal((await run("insert_note", { kind: "footnote", target: { text: "Revenue improved." }, text: "Report basis." })).ok, true);
  assert.equal((await run("insert_note", { kind: "endnote", target: { text: "Margin increased." }, text: "Source detail." })).ok, true);
  let result = await inspect();
  assert.equal(result.notes.footnoteCount, 1); assert.equal(result.notes.endnoteCount, 1);
  const old = result.notes.notes[0]!.handle!;
  assert.equal((await run("update_note", { handle: old, text: "Updated report basis." })).ok, true);
  assert.equal((await run("delete_note", { handle: old })).ok, false);
  result = await inspect();
  assert.equal(result.notes.notes[0]!.text, "Updated report basis.");
  assert.equal((await run("delete_note", { handle: result.notes.notes[1]!.handle! })).ok, true);
  assert.equal(appends, 0); await session.flush(); assert.equal(appends, 1);
  const checked = await binding.inspectDocxNotes!(stored);
  assert.equal(checked.footnoteCount, 1); assert.equal(checked.endnoteCount, 0);
  const input = { binding, before, after: stored, instruction: "Add a footnote", targetAdvanced: true, sourcesUnchanged: true,
    successfulMutations: ["document.insert_note", "document.update_note", "document.delete_note"] };
  const checks = await verifyDocumentUpdate(input);
  assert.equal(checks.find(c => c.id === "notes")?.status, "pass");
  const broken = await verifyDocumentUpdate({ ...input, binding: { ...binding, inspectDocxNotes: async () => ({ ...checked, ok: false, diagnostics: [{ code: "ORPHANED_NOTE_REFERENCE", message: "missing note" }] }) } });
  assert.equal(broken.find(c => c.id === "notes")?.status, "fail");
  assert.equal(hasBlockingVerificationFailure(broken), true);
});
