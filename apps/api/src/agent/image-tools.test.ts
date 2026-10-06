import assert from "node:assert/strict";
import { test } from "node:test";
import { createNapiDocxEngineBinding, type DocxLayoutSnapshot } from "@opensuite/engine-client";
import { createPrimaryDocxTools } from "./docx-tools.js";
import { createToolSurface } from "./capabilities/runtime/tool-surface.js";
const call = { toolCallId: "image-layout", messages: [], context: undefined as never };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL7WQAAAABJRU5ErkJggg==", "base64");
test("image tools load lazily, require inspected handles, and save one verified version", async t => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("set_picture_layout")) return t.skip("local image layout engine required");
  const inserted = await binding.executeDocxInsertPicture!(binding.createBlankDocx(), { imageBytes: png, placement: { kind: "end" }, widthEmu: 914400,
    layout: { horizontal: { reference: "margin", alignment: "end" }, vertical: { reference: "paragraph", offsetEmu: 0 }, wrap: "square" } });
  assert.equal(inserted.result.ok, true);
  let stored = Buffer.from(inserted.output!); let appends = 0;
  const session = await createPrimaryDocxTools({ binding, ownerUserId: "user", workspaceId: "workspace", documentId: "doc", versionId: "v1",
    documents: { getOwnedDocument: async () => ({ format: "docx" }) as never, readExactVersionBytes: async () => stored,
      appendDocumentVersion: async ({ bytes }: { bytes: Uint8Array }) => { stored = Buffer.from(bytes); appends++; return { version: { id: "v2", versionNumber: 2 } } as never; } } as never,
  });
  assert.ok(session);
  const surface = createToolSurface(session.tools);
  assert.equal(surface.initialTools["document.set_picture_layout"], undefined);
  assert.equal(surface.initialTools["document.inspect_layout"], undefined);
  assert.equal(surface.session.load(["document.rich_content", "document.layout"]).ok, true);
  const tools = surface.projectTools(); const patch = tools["document.set_picture_layout"]!;
  const old = (await binding.inspectDocxLayout!(stored)).images[0]!.handle!;
  const denied = await patch.execute!({ handle: old, layout: { wrap: "topAndBottom" } }, call) as { ok: boolean };
  assert.equal(denied.ok, false); // bytes inspected outside session do not register handles
  const inspection = await tools["document.inspect_layout"]!.execute!({}, call) as { layout: DocxLayoutSnapshot };
  const handle = inspection.layout.images[0]!.handle!;
  const changed = await patch.execute!({ handle, layout: { wrap: "topAndBottom" } }, call) as { ok: boolean };
  assert.equal(changed.ok, true);
  const stale = await patch.execute!({ handle, layout: { wrap: "behindText" } }, call) as { ok: boolean };
  assert.equal(stale.ok, false);
  assert.equal(appends, 0); await session.flush(); assert.equal(appends, 1);
  assert.equal((await binding.inspectDocxLayout!(stored)).images[0]!.anchor?.wrap, "topAndBottom");
});
