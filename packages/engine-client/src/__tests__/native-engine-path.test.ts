import assert from "node:assert/strict";
import test from "node:test";

import { resolveNativeEngineModuleId } from "../docx-engine-binding.js";

test("resolveNativeEngineModuleId defaults to the published package", () => {
  const resolved = resolveNativeEngineModuleId({}, "/tmp/cwd");
  assert.deepEqual(resolved, {
    moduleId: "@opensuitehq/engine",
    fromEnv: false,
  });
});

test("resolveNativeEngineModuleId keeps absolute OPENSUITE_ENGINE_PATH", () => {
  const absolute =
    "/Users/example/opensuite-engine/crates/opensuite-node/index.js";
  const resolved = resolveNativeEngineModuleId(
    { OPENSUITE_ENGINE_PATH: absolute },
    "/tmp/cwd",
  );
  assert.deepEqual(resolved, { moduleId: absolute, fromEnv: true });
});

test("resolveNativeEngineModuleId resolves relative paths against cwd", () => {
  const resolved = resolveNativeEngineModuleId(
    { OPENSUITE_ENGINE_PATH: "../opensuite-engine/crates/opensuite-node/index.js" },
    "/Users/example/opensuite",
  );
  assert.equal(resolved.fromEnv, true);
  assert.equal(
    resolved.moduleId,
    "/Users/example/opensuite-engine/crates/opensuite-node/index.js",
  );
});
