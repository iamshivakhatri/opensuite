import assert from "node:assert/strict";
import { test } from "node:test";
import { createNapiDocxEngineBinding, buildMinimalDocx, bindDocxDocument, docxOperationDefinitions, docxAgentInputSchema } from "../index.js";

test("engine inputs keep defaults, byte policy, and reject unsafe argument shapes", async () => {
  const binding = await createNapiDocxEngineBinding();
  const definitions = docxOperationDefinitions(binding.getDocxCapabilities());
  const replacement = definitions.find(op => op.id === "replace_text")!;
  assert.deepEqual(docxAgentInputSchema(replacement).required, ["target", "expectedCurrentText", "replacement"]);
  assert.equal(definitions.find(op => op.id === "insert_picture")!.jsonInput, false);
  const comment = definitions.find(op => op.id === "add_comment")!;
  assert.ok(!(docxAgentInputSchema(comment).required as string[]).includes("date"));
  const doc = bindDocxDocument({ binding, bytes: new Uint8Array(buildMinimalDocx(["Keep this text"])) });
  const before = doc.currentBytes();
  for (const operation of [
    { target: { text: "Keep", occurrence: -1 }, expectedCurrentText: "Keep", replacement: "Bad" },
    { target: { text: "Keep", occurrence: 0.5 }, expectedCurrentText: "Keep", replacement: "Bad" },
    { target: { text: "Keep" }, expectedCurrentText: "Keep", replacement: "Bad", unexpected: true },
  ]) {
    const result = await doc.mutate("replace_text", operation);
    assert.equal(result.ok, false);
    assert.equal(result.reasonCode, "VALIDATION_FAILED");
    assert.deepEqual(doc.currentBytes(), before);
  }
  assert.equal((await doc.mutate("add_comment", { target: { text: "Keep" }, text: "Review", author: "Test" })).ok, true);
});
