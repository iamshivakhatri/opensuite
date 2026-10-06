import assert from "node:assert/strict";
import { test } from "node:test";
import { createNapiDocxEngineBinding, type DocxFieldInspection } from "@opensuite/engine-client";
import { createPrimaryDocxTools } from "./docx-tools.js";
import { createToolSurface } from "./capabilities/runtime/tool-surface.js";

test("field tools load lazily, inspect without saving, and persist one version", async t => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("insert_toc")) return t.skip("local field engine required");
  let stored = binding.createBlankDocx();
  let appends = 0;
  const session = await createPrimaryDocxTools({ binding, ownerUserId: "user", workspaceId: "workspace", documentId: "doc", versionId: "v1",
    documents: { getOwnedDocument: async () => ({ format: "docx" }) as never, readExactVersionBytes: async () => stored,
      appendDocumentVersion: async ({ bytes }: { bytes: Uint8Array }) => { appends++; stored = Buffer.from(bytes); return { version: { id: "v2", versionNumber: 2 } } as never; } } as never,
  });
  assert.ok(session);
  const surface = createToolSurface(session.tools);
  for (const name of ["inspect_fields", "insert_fields", "insert_toc"]) assert.equal(surface.initialTools[`document.${name}`], undefined);
  assert.equal(surface.session.load(["document.fields"]).ok, true);
  const tools = surface.projectTools();
  const call = { toolCallId: "fields", messages: [], context: undefined as never };
  const inspect = async () => (await tools["document.inspect_fields"]!.execute!({}, call) as { fields: DocxFieldInspection }).fields;
  assert.equal((await inspect()).total, 0);
  await session.flush();
  assert.equal(appends, 0);
  assert.equal((await tools["document.insert_toc"]!.execute!({ placement: { kind: "start" }, title: "Contents" }, call) as { ok: boolean }).ok, true);
  assert.equal((await tools["document.insert_fields"]!.execute!({ location: "footer", content: [{ kind: "page" }, { kind: "text", text: " of " }, { kind: "numPages" }] }, call) as { ok: boolean }).ok, true);
  assert.equal((await inspect()).total, 3);
  await session.flush();
  assert.equal(appends, 1);
  assert.equal((await binding.inspectDocxFields!(stored)).fields[0]!.kind, "toc");
});
