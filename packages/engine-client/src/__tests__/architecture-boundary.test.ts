import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../../..");

test("agent-core does not depend on @opensuite/engine N-API package", () => {
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "packages/agent-core/package.json"), "utf8"),
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
    assert.equal(bag?.["@opensuite/engine"], undefined);
  }
});

test("engine-client is the only package that optionally depends on the binding", () => {
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "packages/engine-client/package.json"), "utf8"),
  ) as {
    optionalDependencies?: Record<string, string>;
  };
  const spec = pkg.optionalDependencies?.["@opensuite/engine"];
  assert.ok(spec);
  // link: (not file:) so pnpm symlinks the sibling package — rebuilds are live.
  assert.match(spec, /^link:/);
});
