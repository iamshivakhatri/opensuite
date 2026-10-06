import assert from "node:assert/strict";
import { test } from "node:test";
import {
  refreshDocxFields,
  resetDocxFieldRefreshAvailabilityForTests,
} from "../docx-field-refresh.js";
import { bindDocxDocument, createNapiDocxEngineBinding } from "../index.js";

test("field refresh reports unavailable without soffice", async () => {
  resetDocxFieldRefreshAvailabilityForTests();
  const result = await refreshDocxFields(new Uint8Array([1, 2, 3, 4]), {
    sofficePath: "/missing/opensuite-soffice",
    availability: "unavailable",
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.bytes, undefined);
  assert.match(result.warnings.join(" "), /unavailable/i);
});

test("optional LibreOffice refreshes dirty TOC and PAGE fields", {
  skip: !process.env.OPENSUITE_FIELD_REFRESH_SMOKE,
}, async () => {
  resetDocxFieldRefreshAvailabilityForTests();
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("insert_toc")) {
    return;
  }
  const doc = bindDocxDocument({ binding, bytes: binding.createBlankDocx() });
  const texts = [
    "Monthly Operating Report",
    "Introduction",
    `Body 1. ${"Content sentence for pagination. ".repeat(40)}`,
    "Background",
    "Prior Work",
    `Body 2. ${"Content sentence for pagination. ".repeat(40)}`,
    "Goals",
    "Primary Goal",
    `Body 3. ${"Content sentence for pagination. ".repeat(40)}`,
    "Secondary Goal",
    `Body 4. ${"Content sentence for pagination. ".repeat(50)}`,
    "Results",
    "Metrics",
    `Body 5. ${"Content sentence for pagination. ".repeat(60)}`,
    "Conclusion",
    `Body 6. ${"Content sentence for pagination. ".repeat(40)}`,
  ];
  assert.equal((await doc.mutate("insert_paragraphs", { placement: { kind: "end" }, texts })).ok, true);
  for (const [text, style] of [
    ["Monthly Operating Report", "Title"],
    ["Introduction", "Heading 1"],
    ["Background", "Heading 1"],
    ["Prior Work", "Heading 2"],
    ["Goals", "Heading 2"],
    ["Primary Goal", "Heading 3"],
    ["Secondary Goal", "Heading 3"],
    ["Results", "Heading 1"],
    ["Metrics", "Heading 2"],
    ["Conclusion", "Heading 1"],
  ] as const) {
    assert.equal((await doc.mutate("set_paragraph_style", { target: { text, occurrence: 0 }, style })).ok, true);
  }
  assert.equal((await doc.mutate("insert_toc", { placement: { kind: "start" }, title: "Table of Contents", maxHeadingLevel: 3 })).ok, true);
  assert.equal((await doc.mutate("insert_fields", {
    location: "footer",
    content: [{ kind: "text", text: "Page " }, { kind: "page" }, { kind: "text", text: " of " }, { kind: "numPages" }],
  })).ok, true);

  const before = await binding.inspectDocxFields!(doc.currentBytes());
  assert.equal(before.fields.find((field) => field.kind === "toc")?.dirty, true);

  const refreshed = await refreshDocxFields(doc.currentBytes());
  assert.equal(refreshed.status, "refreshed", JSON.stringify(refreshed));
  assert.ok(refreshed.bytes);

  const after = await binding.inspectDocxFields!(refreshed.bytes!);
  const toc = after.fields.find((field) => field.kind === "toc");
  assert.ok(toc);
  assert.notEqual(toc!.dirty, true);
  assert.match(toc!.cachedResult ?? "", /Introduction/);
  assert.match(toc!.cachedResult ?? "", /Primary Goal/);
  assert.match(toc!.cachedResult ?? "", /\d/);
  const page = after.fields.find((field) => field.kind === "page");
  assert.ok(page);
  assert.notEqual(page!.cachedResult, "?");
  assert.match(page!.cachedResult ?? "", /^\d+$/);
});
