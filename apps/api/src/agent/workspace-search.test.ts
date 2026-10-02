import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMinimalDocx, createNapiDocxEngineBinding } from "@opensuite/engine-client";

import { createWorkspaceSearchTool } from "./workspace-search.js";

test("workspace search finds untagged names and DOCX text with compact bounded results", async () => {
  const binding = await createNapiDocxEngineBinding();
  const documents = [
    ...Array.from({ length: 10 }, (_, index) => ({ id: `report-${index}`, name: `Revenue Pulse Report ${index}.docx`, text: "Routine update" })),
    { id: "text-only", name: "Quiet Notes.docx", text: `The revenue pulse is ${"strong ".repeat(50)}` },
    { id: "active", name: "Active.docx", text: "Unrelated" },
  ];
  const bytes = new Map(documents.map((document) => [document.id, Buffer.from(buildMinimalDocx([document.text]))]));
  const tool = createWorkspaceSearchTool({
    documents: {
      listInWorkspace: async (workspaceId: string, ownerUserId: string) => {
        assert.equal(workspaceId, "ws-1");
        assert.equal(ownerUserId, "user-1");
        return documents.map((document) => ({ ...document, format: "docx", latestVersion: { id: `v-${document.id}` } })) as never;
      },
      readExactVersionBytes: async ({ documentId, versionId, ownerUserId }) => {
        assert.equal(versionId, `v-${documentId}`);
        assert.equal(ownerUserId, "user-1");
        return bytes.get(documentId)!;
      },
    },
    binding, ownerUserId: "user-1", workspaceId: "ws-1",
  });
  const call = { toolCallId: "search", messages: [], context: undefined as never };
  const result = await tool.execute!({ query: "revenue pulse" }, call);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.matchCount, 11);
  assert.equal(result.matches.length, 8);
  assert.equal(result.matches[0]?.documentId, "report-0");
  assert.equal(result.skippedDocuments, 0);
  assert.equal(JSON.stringify(result).includes("strong ".repeat(30)), false);

  const filename = await tool.execute!({ query: "Revenue Pulse Report 3.docx" }, call);
  assert.equal(filename.ok, true);
  if (!filename.ok) return;
  assert.equal(filename.matches[0]?.documentId, "report-3");

  const content = await tool.execute!({ query: "is strong" }, call);
  assert.equal(content.ok, true);
  if (!content.ok) return;
  assert.deepEqual(content.matches.map((match: { documentId: string }) => match.documentId), ["text-only"]);
  assert.equal(content.matches[0]?.reason, "text");
  assert.ok((content.matches[0]?.snippet?.length ?? 0) <= 120);
});
