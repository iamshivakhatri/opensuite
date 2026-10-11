import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
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

test("read definitions validate inputs, decode JSON, and use the bound bytes without saving", async () => {
  const binding = await createNapiDocxEngineBinding();
  const bytes = new Uint8Array(buildMinimalDocx(["Read this report"]));
  let saves = 0;
  const doc = bindDocxDocument({ binding, bytes, versionId: "v1", persist: async () => { saves++; return { versionId: "v2" }; } });
  assert.equal((await doc.readOperation!("find_text", { text: "report" }) as { matchCount: number }).matchCount, 1);
  assert.equal((await doc.readOperation!("inspect_notes", {}) as { ok: boolean }).ok, true);
  await assert.rejects(doc.readOperation!("inspect_notes", { limit: 0.5 }), /inspect_notes/);
  await assert.rejects(doc.readOperation!("replace_text", {}), /Unsupported read/);
  assert.equal(saves, 0);
  assert.equal(doc.currentVersionId(), "v1");
  assert.deepEqual(doc.currentBytes(), bytes);
});

test("a new advertised read needs no named client adapter", async () => {
  const folder = mkdtempSync(join(tmpdir(), "opensuite-new-read-"));
  const modulePath = join(folder, "engine.cjs");
  const nativePath = process.env.OPENSUITE_ENGINE_PATH ?? createRequire(import.meta.url).resolve("@opensuitehq/engine");
  writeFileSync(modulePath, `
    const native = require(${JSON.stringify(nativePath)});
    module.exports = { ...native,
      getDocxCapabilities() {
        const caps = native.getDocxCapabilities();
        const docx = caps.formats.find(format => format.format === 'docx');
        docx.capabilities.push('read_business_summary');
        docx.operations = [...(docx.operations || []), {
          id: 'read_business_summary', kind: 'read', nodeExport: 'readBusinessSummary',
          description: 'Read a business summary', jsonInput: true, jsonOutput: true,
          inputSchema: JSON.stringify({ type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false })
        }];
        return caps;
      },
      async readBusinessSummary(bytes, input) {
        return JSON.stringify({ label: input.label, byteLength: bytes.length });
      }
    };
  `);
  const previousPath = process.env.OPENSUITE_ENGINE_PATH;
  try {
    process.env.OPENSUITE_ENGINE_PATH = modulePath;
    const binding = await createNapiDocxEngineBinding();
    const bytes = new Uint8Array(buildMinimalDocx(["Report"]));
    const doc = bindDocxDocument({ binding, bytes });
    assert.deepEqual(await doc.readOperation!("read_business_summary", { label: "Sales" }), { label: "Sales", byteLength: bytes.length });
    await assert.rejects(doc.readOperation!("read_business_summary", { label: 42 }), /must be string/);
  } finally {
    if (previousPath === undefined) delete process.env.OPENSUITE_ENGINE_PATH;
    else process.env.OPENSUITE_ENGINE_PATH = previousPath;
    rmSync(folder, { recursive: true, force: true });
  }
});
