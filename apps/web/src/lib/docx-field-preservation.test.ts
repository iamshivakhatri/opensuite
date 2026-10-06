import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { test } from "node:test";
import {
  assertEditorFieldsPreserved,
  countFieldMarkersInXml,
  editorSaveLostFields,
  normalizeDocxFieldPrefixes,
  prepareDocxForEditor,
} from "./docx-field-preservation.ts";

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

test("normalizeDocxFieldPrefixes rewrites legacy engine field markup to w:", () => {
  const xml =
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
    `<opensuiteField:p xmlns:opensuiteField="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<opensuiteField:r><opensuiteField:fldChar opensuiteField:fldCharType="begin" opensuiteField:dirty="true"/></opensuiteField:r>` +
    `<opensuiteField:r><opensuiteField:instrText xml:space="preserve"> TOC \\o "1-3" </opensuiteField:instrText></opensuiteField:r>` +
    `</opensuiteField:p></w:body></w:document>`;
  const next = normalizeDocxFieldPrefixes(xml);
  assert.match(next, /w:fldChar/);
  assert.match(next, /w:instrText/);
  assert.equal(next.includes("opensuiteField"), false);
  const markers = countFieldMarkersInXml(next);
  assert.equal(markers.fldChar, 1);
  assert.equal(markers.instrText, 1);
  assert.equal(markers.tocInstructions, 1);
});

test("editorSaveLostFields detects TOC/field marker drops and ignores empty docs", () => {
  assert.equal(
    editorSaveLostFields(
      { fldChar: 0, fldSimple: 0, instrText: 0, tocInstructions: 0 },
      { fldChar: 0, fldSimple: 0, instrText: 0, tocInstructions: 0 },
    ),
    false,
  );
  assert.equal(
    editorSaveLostFields(
      { fldChar: 6, fldSimple: 0, instrText: 2, tocInstructions: 1 },
      { fldChar: 0, fldSimple: 0, instrText: 0, tocInstructions: 0 },
    ),
    true,
  );
  assert.equal(
    editorSaveLostFields(
      { fldChar: 6, fldSimple: 2, instrText: 2, tocInstructions: 1 },
      { fldChar: 6, fldSimple: 2, instrText: 2, tocInstructions: 1 },
    ),
    false,
  );
});

test("prepareDocxForEditor normalizes packaged legacy field prefixes", async () => {
  const dir = "/tmp/opensuite-field-preserv-unit";
  mkdirSync(`${dir}/word`, { recursive: true });
  mkdirSync(`${dir}/_rels`, { recursive: true });
  writeFileSync(
    `${dir}/[Content_Types].xml`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      `</Types>`,
  );
  writeFileSync(
    `${dir}/_rels/.rels`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      `</Relationships>`,
  );
  writeFileSync(
    `${dir}/word/document.xml`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
      `<opensuiteField:p xmlns:opensuiteField="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<opensuiteField:r><opensuiteField:fldChar opensuiteField:fldCharType="begin" opensuiteField:dirty="true"/></opensuiteField:r>` +
      `<opensuiteField:r><opensuiteField:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </opensuiteField:instrText></opensuiteField:r>` +
      `<opensuiteField:r><opensuiteField:fldChar opensuiteField:fldCharType="separate"/></opensuiteField:r>` +
      `<opensuiteField:r><opensuiteField:t>Update</opensuiteField:t></opensuiteField:r>` +
      `<opensuiteField:r><opensuiteField:fldChar opensuiteField:fldCharType="end"/></opensuiteField:r>` +
      `</opensuiteField:p><w:sectPr/></w:body></w:document>`,
  );
  execSync(`cd ${dir} && zip -qr /tmp/opensuite-field-preserv-unit.docx .`);
  const original = toArrayBuffer(readFileSync("/tmp/opensuite-field-preserv-unit.docx"));
  const prepared = await prepareDocxForEditor(original);
  writeFileSync("/tmp/opensuite-field-preserv-unit-prepared.docx", Buffer.from(prepared));
  execSync(
    "rm -rf /tmp/opensuite-field-preserv-unit-out && mkdir -p /tmp/opensuite-field-preserv-unit-out && unzip -qo /tmp/opensuite-field-preserv-unit-prepared.docx -d /tmp/opensuite-field-preserv-unit-out",
  );
  const xml = readFileSync("/tmp/opensuite-field-preserv-unit-out/word/document.xml", "utf8");
  assert.match(xml, /w:fldChar/);
  assert.equal(xml.includes("opensuiteField"), false);
  await assertEditorFieldsPreserved(prepared, prepared);

  const brokenDir = "/tmp/opensuite-field-preserv-unit-broken";
  execSync(`rm -rf ${brokenDir} && cp -R /tmp/opensuite-field-preserv-unit-out ${brokenDir}`);
  writeFileSync(
    `${brokenDir}/word/document.xml`,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
      `<w:body><w:p><w:r><w:t>Table of Contents</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  );
  execSync(`cd ${brokenDir} && zip -qr ${brokenDir}.docx .`);
  const broken = toArrayBuffer(readFileSync(`${brokenDir}.docx`));
  await assert.rejects(
    () => assertEditorFieldsPreserved(prepared, broken),
    /Save refused: Word fields/,
  );
});
