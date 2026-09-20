import assert from "node:assert/strict";
import { test } from "node:test";

import type { DocxEngineBinding } from "@opensuite/engine-client";

import {
  formatRetrievedDocumentContext,
  formatTableRowDetail,
  retrieveRelevantDocumentContext,
  selectTableRowDetail,
  SlimDocumentStructureCache,
  type SlimDocumentStructure,
} from "./document-retrieval.js";
import { firstTurnContextProjection } from "./execution.js";

const structure: SlimDocumentStructure = {
  versionId: "v1",
  blocks: [
    { kind: "paragraph", handle: "b0", text: "Project Objective", styleName: "Heading 1", headingLevel: 1 },
    { kind: "paragraph", handle: "b1", text: "Deliver the launch plan with owners and dates." },
    { kind: "table", handle: "b2", tableHandle: "t0", rowCount: 14, columnCount: 3, headerTexts: ["Milestone", "Target", "Owner"] },
  ],
};

function bodyBlocks(blocks = structure.blocks) {
  return blocks.map((block) => block.kind === "paragraph"
    ? { handle: block.handle, kind: block.kind, text: block.text, styleName: block.styleName, headingLevel: block.headingLevel }
    : block.kind === "table"
      ? { handle: block.handle, kind: block.kind, tableHandle: block.tableHandle, rowCount: block.rowCount, columnCount: block.columnCount, headerTexts: block.headerTexts }
      : { handle: block.handle, kind: block.kind });
}

test("structure cache pages all blocks and isolates immutable versions", async () => {
  const blocks = Array.from({ length: 25 }, (_, index) => ({ kind: "paragraph" as const, handle: `b${index}`, text: `Paragraph ${index}` }));
  let calls = 0;
  const binding = {
    inspectDocx: async (_bytes: Uint8Array, request: { focus: { offset?: number; limit?: number } }) => {
      calls += 1;
      const offset = request.focus.offset ?? 0;
      const items = bodyBlocks(blocks.slice(offset, offset + 20));
      return { ok: true, diagnostics: [], bodyBlocks: { page: { total: blocks.length, offset, returned: items.length, hasMore: offset + items.length < blocks.length }, items } };
    },
  } as unknown as DocxEngineBinding;
  const cache = new SlimDocumentStructureCache();

  const first = await cache.get({ versionId: "v1", bytes: new Uint8Array(), binding });
  const second = await cache.get({ versionId: "v1", bytes: new Uint8Array(), binding });
  const next = await cache.get({ versionId: "v2", bytes: new Uint8Array(), binding });

  assert.equal(first.cache, "miss");
  assert.equal(first.structure.blocks.length, 25);
  assert.equal(second.cache, "hit");
  assert.equal(next.cache, "miss");
  assert.equal(calls, 4);
});

test("retrieval returns only high-confidence small structure", () => {
  const table = retrieveRelevantDocumentContext("Add a few milestones to the table.", structure);
  assert.equal(table?.reason, "single_table");
  assert.equal(table?.blocks[0]?.kind, "table");

  const heading = retrieveRelevantDocumentContext("Tell me the first heading.", structure);
  assert.equal(heading?.reason, "first_heading");
  assert.equal(heading?.blocks.length, 2);

  const paragraph = retrieveRelevantDocumentContext("What is the launch plan?", structure);
  assert.equal(paragraph?.reason, "paragraph_match");
  assert.equal(paragraph?.blocks.length, 1);

  assert.equal(retrieveRelevantDocumentContext("Make this look better.", structure), undefined);
  assert.equal(retrieveRelevantDocumentContext("Change Key HighStone to Key Milestones.", structure), undefined);
});

test("table detail is limited to recent rows for clear table continuations", () => {
  const context = retrieveRelevantDocumentContext("Add a few milestones to the table.", structure);
  assert.ok(context);
  assert.deepEqual(selectTableRowDetail("Add a few milestones to the table.", context!), { tableHandle: "t0", rowOffset: 11, rowLimit: 3 });
  assert.equal(selectTableRowDetail("How many rows are in the milestone table?", context!), undefined);
  assert.equal(selectTableRowDetail("Make the table better.", context!), undefined);
  assert.equal(selectTableRowDetail("Add more to the table.", context!), undefined);

  const detail = formatTableRowDetail({ tableHandle: "t0", rowCount: 14, columnCount: 3, headerTexts: ["Milestone"], rows: [{ index: 11, cells: ["x".repeat(161)] }] });
  assert.match(detail, /Relevant recent rows/);
  assert.ok(detail.length <= 2000);
  assert.match(detail, /…/);
});

test("retrieval bounds long text and never injects a whole document", () => {
  const long = "x".repeat(300);
  const many: SlimDocumentStructure = {
    versionId: "v-many",
    blocks: [{ kind: "paragraph", handle: "b0", text: "Launch plan " + long }, ...Array.from({ length: 20 }, (_, index) => ({ kind: "paragraph" as const, handle: `b${index + 1}`, text: "other content" }))],
  };
  const context = retrieveRelevantDocumentContext("Tell me about the launch plan", many);
  assert.ok(context);
  assert.ok(context!.blocks.length < many.blocks.length);
  assert.ok((context!.blocks[0] as { text: string }).text.length <= 240);
  assert.match(formatRetrievedDocumentContext(context!), /Relevant document structure/);
});

test("first-turn projection appends context once without changing the system prompt", () => {
  const project = firstTurnContextProjection("Relevant document structure:\n- Table t0");
  const messages = [{ role: "user" as const, content: "Add milestones" }];
  assert.equal(project(messages).length, 2);
  assert.deepEqual(project(messages), messages);
});
