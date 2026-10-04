import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createNapiDocxEngineBinding, renderDocxLayout } from "../index.js";

test("typed structural layout inspection is read-only and bounded", async (t) => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("layout_snapshot")) return t.skip("local Pass 3 required");
  const bytes = binding.createBlankDocx(); const original = Buffer.from(bytes);
  const result = await binding.inspectDocxLayout!(bytes, { blockLimit: 20 });
  assert.equal(result.kind, "structural"); assert.equal(result.sections[0]!.usableWidthTwips, 9360);
  assert.equal(result.renderedPageCount, null); assert.deepEqual(Buffer.from(bytes), original);
  assert.equal((await binding.inspectDocx(bytes, { focus: { kind: "layout" } })).layout?.sectionCount, 1);
});
test("renderer reports missing tools without estimating pagination", async () => {
  const result = await renderDocxLayout(new Uint8Array(), { sofficePath: "/missing/opensuite-soffice" });
  assert.equal(result.ok, false); assert.equal(result.pageCount, null);
  assert.equal(result.diagnostics[0]!.code, "RENDERED_LAYOUT_UNAVAILABLE");
});
test("optional LibreOffice renders A/B/C read-only and matches the resulting PDF", { skip: !process.env.OPENSUITE_RENDER_SMOKE }, async () => {
  for (const name of ["simple", "three-sections", "explicit"]) {
    const bytes = await readFile(`/private/tmp/opensuite-layout-${name}.docx`); const original = Buffer.from(bytes);
    const result = await renderDocxLayout(bytes, { includePdf: true });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics)); assert.equal(result.provider, "libreoffice-pdf");
    assert.equal(result.blockPageMapping, "unavailable"); assert.ok(result.pageCount! > 0);
    const pdf = `/private/tmp/opensuite-layout-${name}.pdf`; await writeFile(pdf, result.pdf!);
    const info = execFileSync("pdfinfo", [pdf], { encoding: "utf8" });
    assert.equal(Number(/^Pages:\s+(\d+)$/m.exec(info)![1]), result.pageCount);
    assert.deepEqual(bytes, original); const { pdf: _, ...facts } = result;
    await writeFile(`/private/tmp/opensuite-layout-${name}-rendered.json`, JSON.stringify(facts, null, 2));
    console.log(`${name}: ${result.pageCount} rendered pages`);
  }
});
