import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAgentOperatingInstruction } from "./operating-instruction.js";

test("operating instruction lists only exposed document tools", () => {
  const system = buildAgentOperatingInstruction([
    "document.find",
    "document.inspect",
    "document.replace_text",
    "finish",
  ]);

  assert.match(system, /Available document operations:/);
  assert.match(system, /- document\.find/);
  assert.match(system, /- document\.inspect/);
  assert.match(system, /- document\.replace_text/);
  assert.match(system, /Use finish when the requested work is complete/);
  assert.equal(system.includes("document.capabilities"), false);
  assert.equal(system.includes("insert_picture"), false);
  assert.equal(system.includes("replace_picture"), false);
  // finish is not a document.* op — listed in policy text, not the ops block as document.finish
  assert.equal(system.includes("- finish"), false);
});

test("hidden picture ops are not advertised when absent from the toolset", () => {
  const system = buildAgentOperatingInstruction([
    "document.find",
    "document.set_paragraph_style",
    "finish",
  ]);
  assert.equal(system.includes("document.insert_picture"), false);
  assert.equal(system.includes("document.replace_picture"), false);
  assert.equal(system.includes("- document.set_paragraph_style"), true);
  assert.equal(system.includes("- document.find"), true);
  assert.equal(system.includes("- document.inspect"), false);
});

test("empty document toolset states that no document ops are available", () => {
  const system = buildAgentOperatingInstruction(["finish"]);
  assert.match(system, /No document operations are available in this run/);
  assert.equal(system.includes("Available document operations:"), false);
});
