import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

test("agent-core packages do not depend on @opensuitehq/engine N-API package", () => {
  for (const pkgName of ["agent-core-v2", "agent-core-v3"] as const) {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, `packages/${pkgName}/package.json`), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    for (const bag of [
      pkg.dependencies,
      pkg.optionalDependencies,
      pkg.peerDependencies,
    ]) {
      assert.equal(bag?.["@opensuitehq/engine"], undefined);
      assert.equal(bag?.["@opensuite/engine"], undefined);
    }
  }
});

test("engine-client is the only package that depends on the native binding", () => {
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "packages/engine-client/package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  assert.equal(pkg.dependencies?.["@opensuitehq/engine"], "0.1.1");
  assert.equal(pkg.optionalDependencies?.["@opensuitehq/engine"], undefined);
  assert.equal(pkg.optionalDependencies?.["@opensuite/engine"], undefined);
  assert.equal(pkg.dependencies?.["@opensuite/engine"], undefined);
});
