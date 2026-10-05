import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocxEngineBinding, DocxField } from "@opensuite/engine-client";
import {
  acceptRefreshedDocxFields,
  fieldsNeedExternalRefresh,
  formatFieldRefreshLog,
  listDocxPartNames,
  tocNeedsExternalRefresh,
} from "./field-refresh.js";
import { createNapiDocxEngineBinding } from "@opensuite/engine-client";

const toc = (overrides: Partial<DocxField> = {}): DocxField => ({
  index: 0,
  kind: "toc",
  representation: "complex",
  instruction: ' TOC \\o "1-3" ',
  cachedResult: "Update this table of contents in Word.",
  partName: "/word/document.xml",
  paragraphIndex: 0,
  structure: "complete",
  dirty: true,
  locked: false,
  headingLevels: [1, 3],
  truncated: false,
  diagnostics: [],
  ...overrides,
});

test("tocNeedsExternalRefresh detects dirty and placeholder TOC only", () => {
  assert.equal(tocNeedsExternalRefresh(toc()), true);
  assert.equal(tocNeedsExternalRefresh(toc({ dirty: null, cachedResult: "" })), true);
  assert.equal(tocNeedsExternalRefresh(toc({ dirty: null, cachedResult: "Introduction1Background1" })), false);
  assert.equal(tocNeedsExternalRefresh(toc({ dirty: false, cachedResult: "Introduction\t1" })), false);
  assert.equal(fieldsNeedExternalRefresh([toc({ kind: "page", dirty: true, cachedResult: "?", headingLevels: null })]), true);
});

test("acceptRefreshedDocxFields rejects lost TOC and keeps reason compact", async () => {
  const binding = {
    async inspectDocxFields(bytes: Uint8Array) {
      const original = bytes[0] === 1;
      return {
        ok: true,
        total: original ? 1 : 0,
        offset: 0,
        hasMore: false,
        fields: original ? [toc()] : [],
        diagnostics: [],
      };
    },
    async inspectDocx() {
      return { ok: true, overview: { sectionCount: 1, bodyBlockCount: 2, paragraphCount: 2, tableCount: 0 } };
    },
    async findDocxText() {
      return { ok: true, query: "", matchCount: 1, matches: [], diagnostics: [] };
    },
  } as unknown as DocxEngineBinding;

  const rejected = await acceptRefreshedDocxFields(binding, new Uint8Array([1]), new Uint8Array([2]));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "TOC field lost");
});

test("acceptRefreshedDocxFields rejects lost customXml parts", async () => {
  const binding = await createNapiDocxEngineBinding();
  if (!binding.getDocxCapabilities().formats[0]?.capabilities.includes("insert_toc")) return;
  const original = binding.createBlankDocx();
  // Inject a protected customXml part into a copy of the blank package.
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "opensuite-part-gate-"));
  try {
    writeFileSync(join(dir, "in.docx"), original);
    execFileSync("unzip", ["-qo", join(dir, "in.docx"), "-d", join(dir, "pkg")]);
    mkdirSync(join(dir, "pkg", "customXml"), { recursive: true });
    writeFileSync(join(dir, "pkg", "customXml", "probe.xml"), "<probe/>");
    execFileSync("bash", ["-lc", `cd "${join(dir, "pkg")}" && zip -qr "${join(dir, "with-part.docx")}" .`]);
    const withPart = new Uint8Array(readFileSync(join(dir, "with-part.docx")));
    assert.ok(listDocxPartNames(withPart).some((name) => name.startsWith("customXml/")));
    const rejected = await acceptRefreshedDocxFields(binding, withPart, original);
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason ?? "", /package part lost/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatFieldRefreshLog stays compact", () => {
  assert.equal(
    formatFieldRefreshLog({
      status: "unavailable",
      provider: "libreoffice-macro",
      durationMs: 12,
      warnings: ["LibreOffice field refresh is unavailable"],
    }),
    "field refresh unavailable",
  );
  assert.match(
    formatFieldRefreshLog(
      { status: "refreshed", provider: "libreoffice-macro", durationMs: 420, warnings: [] },
      { ok: true, tocPopulated: true, pageFields: 2 },
    ),
    /field refresh libreoffice ✓ 420ms toc=1 pageFields=2/,
  );
  assert.match(
    formatFieldRefreshLog(
      { status: "refreshed", provider: "libreoffice-macro", durationMs: 10, warnings: [] },
      { ok: false, reason: "revisions changed" },
    ),
    /preservation check: revisions changed/,
  );
});
