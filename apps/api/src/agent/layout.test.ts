import assert from "node:assert/strict";
import { test } from "node:test";
import { createNapiDocxEngineBinding } from "@opensuite/engine-client";
import { createPrimaryDocxTools } from "./docx-tools.js";
import { createToolSurface } from "./capabilities/runtime/tool-surface.js";

const call = { toolCallId: "e1", messages: [], context: undefined as never };

test("Layout loads dynamically and reads without saving a version", async (t) => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("layout_snapshot")) return t.skip("local E1 engine required");
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
  assert.equal(surface.initialTools["document.inspect_layout"], undefined);
  assert.equal(surface.initialTools["document.render_layout"], undefined);
  assert.equal(surface.session.load(["document.layout"]).ok, true);
  const tools = surface.projectTools();
  const inspected = await tools["document.inspect_layout"]!.execute!({ blockLimit: 10 }, call) as { ok: boolean; layout: { kind: string; sectionCount: number; sections: { usableWidthTwips: number }[] } };
  assert.equal(inspected.ok, true); assert.equal(inspected.layout.kind, "structural");
  assert.equal(inspected.layout.sectionCount, 1); assert.equal(inspected.layout.sections[0]!.usableWidthTwips, 9360);
  assert.equal(tools["document.inspect_layout"]!.kind, "read");
  assert.equal(session.getWorkingMutationCount(), 0);
  await session.flush(); assert.equal(appends, 0);
});
