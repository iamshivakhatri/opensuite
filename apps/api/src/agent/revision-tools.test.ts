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
