import assert from "node:assert/strict";
import { test } from "node:test";

import { buildAgentOperatingInstruction } from "./operating-instruction.js";

test("operating instruction embeds general policy and only exposed tools", () => {
  const system = buildAgentOperatingInstruction([
    "document.find",
    "document.inspect",
    "document.replace_text",
    "finish",
  ]);

  assert.match(system, /You are OpenSuite's document agent/);
  assert.match(system, /AVAILABLE CAPABILITIES/);
  assert.match(system, /OPERATING PRINCIPLES/);
  assert.match(system, /- document\.find/);
  assert.match(system, /- document\.inspect/);
  assert.match(system, /- document\.replace_text/);
  assert.match(system, /- finish/);
  assert.match(system, /Use the finish operation when the requested work is complete/);
  assert.equal(system.includes("document.capabilities"), false);
  assert.equal(system.includes("insert_picture"), false);
  assert.equal(system.includes("replace_picture"), false);
  // No request-specific or find→mutate workflow prescriptions.
  assert.equal(system.includes("change X to Y"), false);
  assert.equal(/Always call/i.test(system), false);
  assert.equal(system.includes("Prefer document.find"), false);
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

test("empty toolset lists none under AVAILABLE CAPABILITIES", () => {
  const system = buildAgentOperatingInstruction([]);
  assert.match(system, /AVAILABLE CAPABILITIES\n- \(none\)/);
});
