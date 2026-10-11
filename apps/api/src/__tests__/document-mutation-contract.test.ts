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
import { buildAgentOperatingInstruction } from "../agent/operating-instruction.js";
import { createToolSurface } from "../agent/capabilities/runtime/tool-surface.js";

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

test("real bound DOCX exposes only executable mutation tools with agent-core kinds", async () => {
  const binding = await createNapiDocxEngineBinding();
  const bytes = new Uint8Array(buildMinimalDocx(["Contract proof"]));
  const bound = bindDocxDocument({ binding, bytes, versionId: "v1" });
  const tools = createDocumentTools(bound);

  assert.equal(tools["document.capabilities"], undefined);
  assert.equal(tools["document.inspect"]?.kind, "read");
  assert.equal(tools["document.find"]?.kind, "read");

  const mutationNames = Object.keys(tools)
    .filter((name) => name.startsWith("document.") && tools[name]?.kind !== "read" && !name.startsWith("document.batch_"))
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

  // Reads, feature flags, and document creation have separate product paths.
  const otherCapabilities = new Set([
    "inspect", "style_snapshot", "inspect_notes", "inspect_comments", "inspect_fields",
    "inspect_tracked_changes", "create_blank_docx", "body_blocks", "inspect_sections",
    "layout_snapshot", "find_text", "inspect_context", "semantic_table_cell_targets",
    "semantic_table_row_deletion",
  ]);
  const surface = createToolSurface(tools);
  const engineCaps =
    bound
      .capabilities()
      .formats.find((f) => f.format === "docx")
      ?.capabilities ?? [];
  for (const cap of engineCaps) {
    if ((HIDDEN_BINARY_MUTATION_CAPABILITIES as readonly string[]).includes(cap)) {
      continue;
    }
    if (otherCapabilities.has(cap)) {
      continue;
    }
    assert.ok((MODEL_MUTATION_CAPABILITIES as readonly string[]).includes(cap),
      `Engine capability ${cap} needs an agent schema or an explicit product policy`);
    assert.ok(tools[`document.${cap}`], `missing model tool for ${cap}`);
    assert.equal(surface.session.load([`document.${cap}`]).ok, true,
      `${cap} is missing from dynamic discovery`);
    assert.ok(surface.projectTools()[`document.${cap}`], `${cap} cannot be loaded`);
  }

  const operations = bound.capabilities().formats.find((f) => f.format === "docx")?.operations;
  if (operations) {
    assert.deepEqual(operations.filter((op) => op.kind === "mutate").map((op) => op.id).sort(),
      [...DISPATCHABLE_MUTATION_CAPABILITIES].sort(), "engine operations and client dispatch must agree");
  }
});

test("operating instruction mirrors gated toolset; no capabilities or hidden pictures", async () => {
  const binding = await createNapiDocxEngineBinding();
  const bytes = new Uint8Array(buildMinimalDocx(["Ops list"]));
  const bound = bindDocxDocument({ binding, bytes, versionId: "v1" });
  const tools = createDocumentTools(bound);
  const system = buildAgentOperatingInstruction([
    ...Object.keys(tools),
    "finish",
  ]);

  assert.equal(tools["document.capabilities"], undefined);
  assert.equal(system.includes("document.capabilities"), false);
  for (const hidden of HIDDEN_BINARY_MUTATION_CAPABILITIES) {
    assert.equal(tools[`document.${hidden}`], undefined);
    assert.equal(system.includes(`document.${hidden}`), false);
  }
  assert.match(system, /- document\.find/);
  assert.match(system, /- document\.inspect/);
  assert.match(system, /- document\.replace_text/);
});
