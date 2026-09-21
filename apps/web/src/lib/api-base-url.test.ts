import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveApiBaseUrl } from "./api-base-url.ts";

test("resolveApiBaseUrl strips trailing slashes", () => {
  assert.equal(
    resolveApiBaseUrl("https://api.opensuite.tech/"),
    "https://api.opensuite.tech",
  );
  assert.equal(
    resolveApiBaseUrl("https://api.opensuite.tech///"),
    "https://api.opensuite.tech",
  );
  assert.equal(
    resolveApiBaseUrl("http://localhost:3000"),
    "http://localhost:3000",
  );
});

test("resolveApiBaseUrl treats blank as unset", () => {
  assert.equal(resolveApiBaseUrl(undefined), undefined);
  assert.equal(resolveApiBaseUrl(""), undefined);
  assert.equal(resolveApiBaseUrl("   "), undefined);
});
