import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, Module } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createNapiDocxEngineBinding,
  describeNativeEngine,
  formatNativeEngineIdentity,
  nativeLoaderOverrides,
  resolveNativeEngineModuleId,
} from "../docx-engine-binding.js";

test("nativeLoaderOverrides lists only set NAPI-RS loader overrides", () => {
  assert.deepEqual(nativeLoaderOverrides({}), []);
  assert.deepEqual(
    nativeLoaderOverrides({
      NAPI_RS_NATIVE_LIBRARY_PATH: " /tmp/x.node ",
      NAPI_RS_FORCE_WASI: "",
    }),
    ["NAPI_RS_NATIVE_LIBRARY_PATH=/tmp/x.node"],
  );
});

test("describeNativeEngine reports the loaded binary", async () => {
  const binding = await createNapiDocxEngineBinding();
  const identity = await describeNativeEngine(binding);
  assert.match(identity.modulePath, /index\.js$/);
  assert.match(identity.binaryPath ?? "", /opensuite_node\..+\.node$/);
  assert.match(identity.binarySha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(identity.engineVersion, binding.getDocxCapabilities().engineVersion);
  assert.ok(formatNativeEngineIdentity(identity).includes(`sha256=${identity.binarySha256}`));
});

test("identity follows the selected loader, including renamed and nested binaries", async () => {
  const require = createRequire(import.meta.url);
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "engine-identity-")));
  const oldPath = join(folder, "old.node");
  const selectedPath = join(folder, "renamed.node");
  const loaderPath = join(folder, "index.cjs");
  const nestedPath = join(folder, "nested.cjs");
  // Cached native modules let this regression run without installing an old release.
  for (const [path, version] of [[oldPath, "0.1.4"], [selectedPath, "0.1.5"]]) {
    writeFileSync(path!, version!);
    const module = new Module(path!);
    module.filename = path!;
    module.loaded = true;
    module.exports = { getDocxCapabilities: () => ({ engineVersion: version, protocolVersion: 1 }) };
    require.cache[path!] = module;
  }
  writeFileSync(nestedPath, 'module.exports = require("./renamed.node");');
  writeFileSync(loaderPath, 'require("./old.node"); module.exports = require("./nested.cjs");');
  try {
    const identity = await describeNativeEngine({ OPENSUITE_ENGINE_PATH: loaderPath });
    assert.equal(identity.engineVersion, "0.1.5");
    assert.equal(identity.binaryPath, selectedPath);
    assert.equal(identity.binarySha256, createHash("sha256").update("0.1.5").digest("hex"));
    const direct = await describeNativeEngine({ OPENSUITE_ENGINE_PATH: selectedPath });
    assert.equal(direct.binaryPath, selectedPath);
  } finally {
    for (const path of [oldPath, selectedPath, loaderPath, nestedPath]) delete require.cache[path];
    rmSync(folder, { recursive: true, force: true });
  }
});

test("binding identity does not change when the environment changes", async () => {
  const binding = await createNapiDocxEngineBinding();
  const identity = await describeNativeEngine(binding);
  const previous = process.env.OPENSUITE_ENGINE_PATH;
  process.env.OPENSUITE_ENGINE_PATH = "/missing/other-engine.node";
  try {
    assert.deepEqual(await describeNativeEngine(binding), identity);
  } finally {
    if (previous === undefined) delete process.env.OPENSUITE_ENGINE_PATH;
    else process.env.OPENSUITE_ENGINE_PATH = previous;
  }
});

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
