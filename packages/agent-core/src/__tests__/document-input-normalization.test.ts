import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentCoreError,
  createDocumentInspectTool,
  createDocumentInsertTableRowTool,
  createDocumentFindTool,
  createDocumentSetHyperlinkTool,
  createDocumentSetContentControlTextTool,
  createDocumentSetParagraphsListTool,
  createDocumentSetTableCellShadingTool,
} from "../index.js";

function rejectsInput(action: () => unknown): void {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof AgentCoreError && error.code === "INVALID_TOOL_INPUT",
  );
}

test("inspect accepts exact simple focus strings and preserves object input", () => {
  const tool = createDocumentInspectTool();
  assert.deepEqual(tool.parseInput({ focus: "tables" }), {
    focus: { kind: "tables" },
  });
  assert.deepEqual(tool.parseInput({ focus: "paragraphs" }), {
    focus: { kind: "paragraphs" },
  });
  assert.deepEqual(tool.parseInput({ focus: { kind: "tables", limit: 10 } }), {
    focus: { kind: "tables", limit: 10 },
  });
  rejectsInput(() => tool.parseInput({ focus: "table" }));
  rejectsInput(() => tool.parseInput({ focus: "context" }));
});

test("table cell shading accepts one leading hash and rejects other color syntax", () => {
  const tool = createDocumentSetTableCellShadingTool();
  const parse = (fill: string) => tool.parseInput({
    table: { headerCells: ["Name"] },
    updates: [{ target: { rowLabel: "Ada", columnHeader: "Name" }, fill }],
  });

  assert.equal(parse("AABBCC").updates[0]!.fill, "AABBCC");
  assert.equal(parse("#aabbcc").updates[0]!.fill, "AABBCC");
  assert.deepEqual(tool.parseInput({
    table: { handle: "t0" },
    updates: [{ target: { handle: "t0:r1:c0" }, fill: "AABBCC" }],
  }).updates[0]?.target, { handle: "t0:r1:c0" });
  rejectsInput(() => parse("#abc"));
  rejectsInput(() => parse("red"));
  rejectsInput(() => parse("##AABBCC"));
  rejectsInput(() => tool.parseInput({
    table: { headerCells: ["Name"] },
    updates: [{ rowLabel: "Ada", columnHeader: "Name", fill: "AABBCC" }],
  }));
  rejectsInput(() => tool.parseInput({
    table: { headerCells: ["Name"] },
    updates: [{ target: { handle: "t0:r1:c0", rowLabel: "Ada" }, fill: "AABBCC" }],
  }));
});

test("extended tools reuse selector occurrence normalization without inventing targets", () => {
  const row = createDocumentInsertTableRowTool().parseInput({
    table: { headerCells: ["Name"], occurrence: 0 },
    after: { firstCellText: "Ada", occurrence: null },
    cells: ["Grace"],
  });
  assert.deepEqual(row, {
    table: { headerCells: ["Name"] },
    after: { firstCellText: "Ada" },
    cells: ["Grace"],
  });

  const link = createDocumentSetHyperlinkTool().parseInput({
    target: { text: "OpenSuite", occurrence: "" },
    url: "https://example.com",
  });
  assert.deepEqual(link.target, { text: "OpenSuite" });

  const control = createDocumentSetContentControlTextTool().parseInput({
    target: { tag: "customer-name", occurrence: 0 },
    expectedCurrentText: "Ada",
    replacement: "Grace",
  });
  assert.deepEqual(control.target, { tag: "customer-name" });

  rejectsInput(() => createDocumentSetHyperlinkTool().parseInput({ url: "https://example.com" }));
  rejectsInput(() => createDocumentInsertTableRowTool().parseInput({
    table: { headerCells: ["Invented"] },
    after: {},
    cells: ["Grace"],
  }));
});

test("extended list parser preserves valid input and rejects invalid levels", () => {
  const tool = createDocumentSetParagraphsListTool();
  assert.deepEqual(tool.parseInput({
    targets: [{ text: "First", occurrence: 1 }],
    kind: "bullet",
    level: 2,
  }), {
    targets: [{ text: "First", occurrence: 1 }],
    kind: "bullet",
    level: 2,
  });
  rejectsInput(() => tool.parseInput({
    targets: [{ text: "First" }],
    kind: "bullet",
    level: 3,
  }));
});

test("find keeps semantic mode explicit", () => {
  assert.deepEqual(createDocumentFindTool().parseInput({
    query: "revenue forecast",
    mode: "semantic",
  }), {
    query: "revenue forecast",
    mode: "semantic",
  });
  rejectsInput(() => createDocumentFindTool().parseInput({
    query: "revenue forecast",
    mode: "semantic text",
  }));
});
