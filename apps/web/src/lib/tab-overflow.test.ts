import assert from "node:assert/strict";
import test from "node:test";

import {
  estimateDocumentTabWidth,
  partitionTabsForOverflow,
} from "./tab-overflow.ts";

type Tab = { readonly id: string; readonly name: string };

function tabs(count: number): Tab[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `d${index}`,
    name: `Doc ${index}`,
  }));
}

const base = {
  openButtonWidth: 32,
  overflowButtonWidth: 32,
  minTabWidth: 120,
  maxTabWidth: 180,
  estimateTabWidth: () => 140,
};

test("partition: all tabs visible when they fit", () => {
  const list = tabs(3);
  const result = partitionTabsForOverflow(list, {
    ...base,
    activeId: "d1",
    availableWidth: 32 + 140 * 3,
  });
  assert.deepEqual(
    result.visible.map((tab) => tab.id),
    ["d0", "d1", "d2"],
  );
  assert.deepEqual(result.overflow, []);
});

test("partition: keeps active tab visible and overflows the rest", () => {
  const list = tabs(6);
  // Budget fits ~2 tabs after reserving open + overflow controls.
  const result = partitionTabsForOverflow(list, {
    ...base,
    activeId: "d4",
    availableWidth: 32 + 32 + 140 * 2,
  });
  assert.ok(result.visible.some((tab) => tab.id === "d4"));
  assert.ok(result.overflow.length > 0);
  assert.equal(
    result.visible.length + result.overflow.length,
    list.length,
  );
  const visibleIds = new Set(result.visible.map((tab) => tab.id));
  for (const tab of result.overflow) {
    assert.ok(!visibleIds.has(tab.id));
  }
});

test("partition: contiguous window around active", () => {
  const list = tabs(8);
  const result = partitionTabsForOverflow(list, {
    ...base,
    activeId: "d3",
    availableWidth: 32 + 32 + 140 * 3,
  });
  const ids = result.visible.map((tab) => tab.id);
  assert.ok(ids.includes("d3"));
  // Contiguous: no gaps in indices.
  const indexes = ids.map((id) => Number(id.slice(1)));
  for (let i = 1; i < indexes.length; i += 1) {
    assert.equal(indexes[i], (indexes[i - 1] ?? 0) + 1);
  }
});

test("partition: empty input", () => {
  const result = partitionTabsForOverflow([], {
    ...base,
    activeId: null,
    availableWidth: 400,
  });
  assert.deepEqual(result, { visible: [], overflow: [] });
});

test("estimateDocumentTabWidth grows with name and dirty chrome", () => {
  const short = estimateDocumentTabWidth({ name: "A" });
  const long = estimateDocumentTabWidth({ name: "Quarterly Board Narrative" });
  const dirty = estimateDocumentTabWidth({
    name: "Quarterly Board Narrative",
    dirty: true,
  });
  assert.ok(long > short);
  assert.ok(dirty > long);
});
