import assert from "node:assert/strict";
import { test } from "node:test";

import { parseBlocks } from "./agent-markdown-parse.ts";

test("parseBlocks renders GFM pipe tables", () => {
  const blocks = parseBlocks(`Based on the document:

| Name | Year |
|---|---|
| OpenSuite | 2027 |

Looks like a placeholder.`);

  assert.equal(blocks[0]?.kind, "p");
  assert.equal(blocks[1]?.kind, "table");
  if (blocks[1]?.kind === "table") {
    assert.deepEqual(blocks[1].headers, ["Name", "Year"]);
    assert.deepEqual(blocks[1].rows, [["OpenSuite", "2027"]]);
  }
  assert.equal(blocks[2]?.kind, "p");
});

test("parseBlocks keeps bold headings and lists", () => {
  const blocks = parseBlocks(`## Title

- one
- two`);
  assert.equal(blocks[0]?.kind, "h");
  assert.equal(blocks[1]?.kind, "ul");
});
