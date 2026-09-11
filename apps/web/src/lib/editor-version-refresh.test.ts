import assert from "node:assert/strict";
import test from "node:test";

import { decideEditorVersionRefresh } from "./editor-version-refresh.ts";

const base = {
  documentChanged: false,
  hasReadyEditor: true,
  loadedVersionId: "v1",
  targetVersionId: "v2",
  dirty: false,
  suppressDirtyNoise: false,
  conflict: false,
  saving: false,
};

test("clean same-document version advance reloads in place", () => {
  assert.equal(decideEditorVersionRefresh(base), "reload_inplace");
});

test("dirty human edits defer reload", () => {
  assert.equal(
    decideEditorVersionRefresh({ ...base, dirty: true }),
    "defer_dirty",
  );
});

test("suppress-dirty noise still allows in-place adopt", () => {
  assert.equal(
    decideEditorVersionRefresh({
      ...base,
      dirty: true,
      suppressDirtyNoise: true,
    }),
    "reload_inplace",
  );
});

test("document switch initializes", () => {
  assert.equal(
    decideEditorVersionRefresh({ ...base, documentChanged: true }),
    "initialize",
  );
});

test("no ready editor initializes", () => {
  assert.equal(
    decideEditorVersionRefresh({ ...base, hasReadyEditor: false }),
    "initialize",
  );
});

test("already on target skips", () => {
  assert.equal(
    decideEditorVersionRefresh({
      ...base,
      targetVersionId: "v1",
    }),
    "skip",
  );
});

test("conflict or saving skips auto refresh", () => {
  assert.equal(
    decideEditorVersionRefresh({ ...base, conflict: true }),
    "skip",
  );
  assert.equal(decideEditorVersionRefresh({ ...base, saving: true }), "skip");
});

test("missing target skips", () => {
  assert.equal(
    decideEditorVersionRefresh({ ...base, targetVersionId: null }),
    "skip",
  );
});
