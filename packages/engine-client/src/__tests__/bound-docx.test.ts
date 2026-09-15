import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bindDocxDocument,
  buildMinimalDocx,
  buildNameRoleTableDocx,
  createNapiDocxEngineBinding,
  DISPATCHABLE_MUTATION_CAPABILITIES,
} from "../index.js";

test("bindDocxDocument exposes real engine capabilities/inspect/find", async () => {
  const binding = await createNapiDocxEngineBinding();
  const bytes = new Uint8Array(buildMinimalDocx(["Hello OpenSuite find-me"]));
  const doc = bindDocxDocument({ binding, bytes });

  const caps = doc.capabilities();
  assert.equal(caps.ok, true);
  assert.ok(caps.formats.some((f) => f.format === "docx"));
  assert.ok(
    caps.formats
      .find((f) => f.format === "docx")
      ?.capabilities.includes("inspect"),
  );

  const overview = await doc.inspect({ focus: { kind: "overview" } });
  assert.equal(overview.ok, true);
  assert.equal(overview.focus, "overview");
  assert.ok((overview.overview?.paragraphCount ?? 0) >= 1);

  const found = await doc.find({ text: "find-me" });
  assert.equal(found.ok, true);
  assert.ok(found.matchCount >= 1);
  assert.equal(found.matches[0]?.text.includes("find-me"), true);
});

test("sequential mutations evolve bytes; persist advances versionId", async () => {
  const binding = await createNapiDocxEngineBinding();
  const bytes = new Uint8Array(buildMinimalDocx(["Alpha"]));
  const persisted: Array<{ base: string; size: number }> = [];
  let nextVersion = 1;

  const doc = bindDocxDocument({
    binding,
    bytes,
    versionId: "v1",
    persist: async ({ bytes: next, baseVersionId }) => {
      persisted.push({ base: baseVersionId, size: next.byteLength });
      nextVersion += 1;
      return { versionId: `v${nextVersion}`, versionNumber: nextVersion };
    },
  });

  const a = await doc.mutate("replace_text", {
    target: { text: "Alpha" },
    expectedCurrentText: "Alpha",
    replacement: "Beta",
  });
  assert.equal(a.ok, true);
  assert.equal(a.versionId, "v2");
  assert.equal(doc.currentVersionId(), "v2");

  const b = await doc.mutate("insert_paragraph", {
    text: "Gamma",
    placement: { kind: "end" },
  });
  assert.equal(b.ok, true);
  assert.equal(b.versionId, "v3");
  assert.equal(doc.currentVersionId(), "v3");

  const found = await doc.find({ text: "Beta" });
  assert.equal(found.ok, true);
  assert.ok(found.matchCount >= 1);

  const gamma = await doc.find({ text: "Gamma" });
  assert.equal(gamma.ok, true);
  assert.ok(gamma.matchCount >= 1);

  assert.deepEqual(
    persisted.map((p) => p.base),
    ["v1", "v2"],
  );
});

test("failed mutation does not advance version and returns reasonCode", async () => {
  const binding = await createNapiDocxEngineBinding();
  const bytes = new Uint8Array(buildMinimalDocx(["KeepMe"]));
  let persistCalls = 0;

  const doc = bindDocxDocument({
    binding,
    bytes,
    versionId: "v1",
    persist: async () => {
      persistCalls += 1;
      return { versionId: "v2", versionNumber: 2 };
    },
  });

  const failed = await doc.mutate("replace_text", {
    target: { text: "KeepMe" },
    expectedCurrentText: "WrongExpected",
    replacement: "Changed",
  });
  assert.equal(failed.ok, false);
  assert.ok(failed.reasonCode || failed.diagnostics.length > 0);
  assert.equal(doc.currentVersionId(), "v1");
  assert.equal(persistCalls, 0);

  const stillThere = await doc.find({ text: "KeepMe" });
  assert.equal(stillThere.ok, true);
  assert.ok(stillThere.matchCount >= 1);
});

test("set_paragraph_style uses zero-based occurrence matching inspect", async () => {
  const binding = await createNapiDocxEngineBinding();
  const bytes = new Uint8Array(buildMinimalDocx(["Hello", "Hello"]));
  let version = "v1";
  let persistCalls = 0;
  const doc = bindDocxDocument({
    binding,
    bytes,
    versionId: version,
    persist: async () => {
      persistCalls += 1;
      version = "v2";
      return { versionId: version, versionNumber: 2 };
    },
  });

  const paras = await doc.inspect({ focus: { kind: "paragraphs" } });
  assert.equal(paras.paragraphs?.items?.[0]?.targetOccurrence, 0);
  assert.equal(paras.paragraphs?.items?.[1]?.targetOccurrence, 1);

  const miss = await doc.mutate("set_paragraph_style", {
    target: { text: "Hello", occurrence: 2 },
    style: "Heading 1",
  });
  assert.equal(miss.ok, false);
  assert.equal(miss.reasonCode, "TARGET_NOT_FOUND");
  assert.equal(doc.currentVersionId(), "v1");
  assert.equal(persistCalls, 0);

  const ok = await doc.mutate("set_paragraph_style", {
    target: { text: "Hello", occurrence: 0 },
    style: "Heading 1",
  });
  assert.equal(ok.ok, true);
  assert.equal(doc.currentVersionId(), "v2");
  assert.equal(persistCalls, 1);

  const after = await doc.inspect({ focus: { kind: "paragraphs" } });
  assert.equal(after.paragraphs?.items?.[0]?.text, "Hello");
  assert.equal(after.paragraphs?.items?.[0]?.styleName, "Heading 1");
  assert.equal(after.paragraphs?.items?.[1]?.text, "Hello");
});

test("set_text_formatting occurrence + failed mutate leaves version", async () => {
  const binding = await createNapiDocxEngineBinding();
  const bytes = new Uint8Array(buildMinimalDocx(["FormatMe", "FormatMe"]));
  let persistCalls = 0;
  const doc = bindDocxDocument({
    binding,
    bytes,
    versionId: "v1",
    persist: async () => {
      persistCalls += 1;
      return { versionId: "v2", versionNumber: 2 };
    },
  });

  const bad = await doc.mutate("set_text_formatting", {
    target: { text: "FormatMe", occurrence: 5 },
    bold: true,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reasonCode, "TARGET_NOT_FOUND");
  assert.equal(doc.currentVersionId(), "v1");
  assert.equal(persistCalls, 0);

  const ok = await doc.mutate("set_text_formatting", {
    target: { text: "FormatMe", occurrence: 0 },
    bold: true,
  });
  assert.equal(ok.ok, true);
  assert.equal(persistCalls, 1);
  assert.ok((ok.changes?.length ?? 0) >= 1);
});

test("set_table_cells_text handle path succeeds; bad shape is VALIDATION_FAILED", async () => {
  const binding = await createNapiDocxEngineBinding();
  const bytes = new Uint8Array(buildNameRoleTableDocx());
  let persistCalls = 0;
  const doc = bindDocxDocument({
    binding,
    bytes,
    versionId: "v1",
    persist: async () => {
      persistCalls += 1;
      return { versionId: "v2", versionNumber: 2 };
    },
  });

  const tables = await doc.inspect({ focus: { kind: "tables" } });
  const table = tables.tables?.items?.[0];
  assert.ok(table);
  const cellHandle = table.rows[1]?.cellHandles[1];
  assert.ok(cellHandle);

  const malformed = await doc.mutate("set_table_cells_text", {
    table: { handle: table.handle },
    updates: [{ row: 1, col: 1, text: "x" }],
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reasonCode, "VALIDATION_FAILED");
  assert.equal(doc.currentVersionId(), "v1");
  assert.equal(persistCalls, 0);

  const missing = await doc.mutate("set_table_cells_text", {
    table: { handle: table.handle },
    updates: [
      {
        target: { handle: "t0:r9:c9" },
        expectedCurrentText: "CEO",
        replacement: "Chief",
      },
    ],
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.reasonCode, "TARGET_NOT_FOUND");
  assert.equal(persistCalls, 0);

  const ok = await doc.mutate("set_table_cells_text", {
    table: { handle: table.handle },
    updates: [
      {
        target: { handle: cellHandle },
        expectedCurrentText: "CEO",
        replacement: "Chief",
      },
    ],
  });
  assert.equal(ok.ok, true);
  assert.equal(persistCalls, 1);

  const after = await doc.inspect({ focus: { kind: "tables" } });
  assert.equal(after.tables?.items?.[0]?.rows[1]?.cells[1], "Chief");
});

test("every engine mutation capability is either dispatchable or intentionally hidden", async () => {
  const binding = await createNapiDocxEngineBinding();
  const caps =
    binding
      .getDocxCapabilities()
      .formats.find((f) => f.format === "docx")
      ?.capabilities ?? [];

  const nonMutation = new Set([
    "inspect",
    "inspect_context",
    "find_text",
    "body_blocks",
    "create_blank_docx",
  ]);

  for (const cap of caps) {
    if (nonMutation.has(cap)) continue;
    assert.ok(
      DISPATCHABLE_MUTATION_CAPABILITIES.includes(cap),
      `engine advertises ${cap} but bound dispatch has no executor`,
    );
  }
});
