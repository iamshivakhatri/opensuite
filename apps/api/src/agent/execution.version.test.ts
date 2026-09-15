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

test("createPrimaryDocxTools emits document.version.advanced after mutate", async () => {
  const binding = await createNapiDocxEngineBinding();
  const initial = Buffer.from(buildMinimalDocx(["Primary"]));
  let stored = initial;
  let versionId = "ver-1";
  let versionNumber = 1;
  const advanced: Array<{ versionId: string; versionNumber: number }> = [];

  const tools = await createPrimaryDocxTools({
    binding,
    ownerUserId: "user-1",
    documentId: "doc-1",
    versionId,
    documents: {
      getOwnedDocument: async () =>
        ({
          id: "doc-1",
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
    },
    onVersionAdvanced: async (event) => {
      advanced.push({
        versionId: event.versionId,
        versionNumber: event.versionNumber,
      });
    },
  });

  assert.ok(tools);
  assert.equal(tools.tools["document.capabilities"], undefined);
  const mutate = tools.tools["document.insert_paragraph"];
  assert.ok(mutate?.execute);
  await mutate.execute(
    { text: "Inserted", placement: { kind: "end" } },
    { toolCallId: "t1", messages: [], context: undefined as never },
  );

  assert.equal(advanced.length, 1);
  assert.equal(advanced[0]!.versionNumber, 2);
  assert.equal(tools.tools["document.inspect"]?.kind, "read");
  assert.equal(tools.tools["document.insert_paragraph"]?.kind, "mutate");
});
