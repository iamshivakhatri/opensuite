import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bindDocxDocument,
  buildMinimalDocx,
  createNapiDocxEngineBinding,
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
