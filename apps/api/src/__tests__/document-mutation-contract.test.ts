import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bindDocxDocument,
  buildMinimalDocx,
  createNapiDocxEngineBinding,
  DISPATCHABLE_MUTATION_CAPABILITIES,
} from "@opensuite/engine-client";

import {
  createDocumentTools,
  HIDDEN_BINARY_MUTATION_CAPABILITIES,
  MODEL_MUTATION_CAPABILITIES,
} from "../agent/document-tools.js";

/**
 * Cross-package invariant: every model-exposed mutation has a real dispatcher,
 * and binary-only ops stay hidden.
 */
test("model mutation contracts ⊆ dispatchable; binary ops stay hidden", () => {
  for (const cap of MODEL_MUTATION_CAPABILITIES) {
    assert.ok(
      (DISPATCHABLE_MUTATION_CAPABILITIES as readonly string[]).includes(cap),
      `model exposes ${cap} but bound dispatch has no executor`,
    );
  }
  for (const hidden of HIDDEN_BINARY_MUTATION_CAPABILITIES) {
    assert.ok(
      (DISPATCHABLE_MUTATION_CAPABILITIES as readonly string[]).includes(hidden),
      `${hidden} should remain dispatchable programmatically`,
    );
    assert.equal(
      (MODEL_MUTATION_CAPABILITIES as readonly string[]).includes(hidden),
      false,
    );
  }
});

test("real bound DOCX exposes only executable mutation tools with V3 kinds", async () => {
  const binding = await createNapiDocxEngineBinding();
  const bytes = new Uint8Array(buildMinimalDocx(["Contract proof"]));
  const bound = bindDocxDocument({ binding, bytes, versionId: "v1" });
  const tools = createDocumentTools(bound);

  assert.equal(tools["document.capabilities"]?.kind, "read");
  assert.equal(tools["document.inspect"]?.kind, "read");
  assert.equal(tools["document.find"]?.kind, "read");

  const mutationNames = Object.keys(tools)
    .filter(
      (name) =>
        name.startsWith("document.") &&
        name !== "document.capabilities" &&
        name !== "document.inspect" &&
        name !== "document.find",
    )
    .sort();

  for (const name of mutationNames) {
    const capability = name.slice("document.".length);
    assert.ok(
      (MODEL_MUTATION_CAPABILITIES as readonly string[]).includes(capability),
      `${name} exposed without model contract`,
    );
    assert.ok(
      (DISPATCHABLE_MUTATION_CAPABILITIES as readonly string[]).includes(
        capability,
      ),
      `${name} exposed without dispatcher`,
    );
    assert.equal(typeof tools[name]?.execute, "function");
    assert.equal(tools[name]?.kind, "mutate");
  }

  for (const hidden of HIDDEN_BINARY_MUTATION_CAPABILITIES) {
    assert.equal(tools[`document.${hidden}`], undefined);
  }

  // Engine may advertise more caps than we model-expose; that is intentional.
  const engineCaps =
    bound
      .capabilities()
      .formats.find((f) => f.format === "docx")
      ?.capabilities ?? [];
  for (const cap of engineCaps) {
    if ((HIDDEN_BINARY_MUTATION_CAPABILITIES as readonly string[]).includes(cap)) {
      continue;
    }
    if (!(MODEL_MUTATION_CAPABILITIES as readonly string[]).includes(cap)) {
      continue;
    }
    assert.ok(tools[`document.${cap}`], `missing model tool for ${cap}`);
  }
});
