import assert from "node:assert/strict";
import { test } from "node:test";
import { createNapiDocxEngineBinding } from "@opensuite/engine-client";
import { createPrimaryDocxTools } from "./docx-tools.js";
import { createToolSurface } from "./capabilities/runtime/tool-surface.js";

const call = { toolCallId: "e1", messages: [], context: undefined as never };

test("Word styles load dynamically, edit existing styles, and save once", async (t) => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("create_style")) return t.skip("local E1 engine required");
  let stored = Buffer.from(binding.createBlankDocx());
  let appends = 0;
  const session = await createPrimaryDocxTools({
    binding, ownerUserId: "user", workspaceId: "workspace", documentId: "document", versionId: "v1",
    documents: {
      getOwnedDocument: async () => ({ format: "docx" }) as never,
      readExactVersionBytes: async () => stored,
      appendDocumentVersion: async ({ bytes, baseVersionId }) => {
        assert.equal(baseVersionId, "v1"); stored=Buffer.from(bytes); appends++;
        return { version: { id: "v2", versionNumber: 2 } } as never;
      },
      createBlankDocxDocument: async () => { throw new Error("unused"); },
      createOfficeDocumentFromBytes: async () => { throw new Error("unused"); },
    },
  });
  assert.ok(session);
  const surface = createToolSurface(session.tools);
  for (const name of ["create_style", "update_style"]) assert.equal(surface.initialTools[`document.${name}`], undefined);
  assert.equal(surface.session.load(["document.styles"]).ok, true);
  const tools = surface.projectTools();
  const created = await tools["document.create_style"]!.execute!({ styleId: "AppHeading", styleType: "paragraph", name: "App Heading", basedOn: "Heading1", color: "124733" }, call) as { ok: boolean };
  assert.equal(created.ok, true);
  assert.equal((await session.tools["document.insert_paragraphs"]!.execute!({ texts: ["Style test heading"], placement: { kind: "end" } }, call) as { ok: boolean }).ok, true);
  assert.equal((await session.tools["document.set_paragraph_style"]!.execute!({ target: { text: "Style test heading" }, style: "App Heading" }, call) as { ok: boolean }).ok, true);
  const updated = await tools["document.update_style"]!.execute!({ styleId: "AppHeading", styleType: "paragraph", color: "235744", next: "Normal" }, call) as { ok: boolean };
  assert.equal(updated.ok, true);
  assert.equal(appends,0);
  await session.flush(); await session.flush();assert.equal(appends,1);
  const snapshot = await binding.inspectDocxStyleSnapshot(stored);
  const style = snapshot.styles.find(s => s.styleId === "AppHeading")!;
  assert.equal(style.paragraphUsageCount, 1);
  assert.equal(style.effectiveRunFormatting?.color, "235744");
  assert.equal(style.nextStyleId, "Normal");
});
