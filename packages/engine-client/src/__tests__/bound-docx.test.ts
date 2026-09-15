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
