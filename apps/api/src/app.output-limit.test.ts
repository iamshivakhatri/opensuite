import assert from "node:assert/strict";
import { test } from "node:test";

import { agentOutputTokenLimit } from "./app.js";

test("DeepSeek has no forced output cap; the catalog maximum remains only a ceiling", () => {
  assert.equal(agentOutputTokenLimit(), undefined);
  assert.equal(agentOutputTokenLimit(undefined, 943_718), undefined);
});

test("explicit agent output limit wins and respects the provider ceiling", () => {
  assert.equal(agentOutputTokenLimit(12_288, 16_384), 12_288);
  assert.equal(agentOutputTokenLimit(12_288, 10_000), 10_000);
  assert.equal(agentOutputTokenLimit(12_288), 12_288);
});
