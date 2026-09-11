import assert from "node:assert/strict";
import test from "node:test";

import { upsertOpenTab, type OpenTabMeta } from "./open-tabs.ts";

function tab(
  id: string,
  name = id,
  format: OpenTabMeta["format"] = "docx",
): OpenTabMeta {
  return { id, name, format };
}

test("upsertOpenTab appends a new tab at the end", () => {
  const next = upsertOpenTab([tab("a"), tab("b")], tab("c", "C"));
  assert.deepEqual(
    next.map((item) => item.id),
    ["a", "b", "c"],
  );
});

test("upsertOpenTab keeps existing tab position", () => {
  const next = upsertOpenTab(
    [tab("a"), tab("b"), tab("c")],
    tab("a", "A renamed"),
  );
  assert.deepEqual(
    next.map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.equal(next[0]?.name, "A renamed");
});

test("upsertOpenTab selecting middle tab does not move it to the end", () => {
  const list = [tab("a"), tab("b"), tab("c")];
  const next = upsertOpenTab(list, tab("b"));
  assert.deepEqual(
    next.map((item) => item.id),
    ["a", "b", "c"],
  );
  assert.equal(next, list);
});
