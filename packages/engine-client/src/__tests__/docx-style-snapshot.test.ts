import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMinimalDocx,
  createNapiDocxEngineBinding,
  inspectDocxStyleSnapshot,
  type DocxStyleSnapshot,
} from "../index.js";

test("inspectDocxStyleSnapshot passes bytes to the typed engine method", async () => {
  const expected = {
    ok: true,
    schemaVersion: 1,
    paragraphCount: 0,
    runCount: 0,
    tableCount: 0,
    sectionCount: 0,
    defaults: { runFormatting: {}, paragraphFormatting: {} },
    styles: [],
    typography: {
      fonts: [],
      fontSizesHalfPoints: [],
      textColors: [],
      highlights: [],
      boldRunCount: 0,
      italicRunCount: 0,
      underlineRunCount: 0,
      runPatterns: [],
    },
    paragraphPatterns: [],
    lists: [],
    tables: [],
    sections: [],
    headersFooters: [],
    themeReferences: [],
    truncated: false,
    diagnostics: [],
  } satisfies DocxStyleSnapshot;
  const bytes = new Uint8Array([1, 2, 3]);
  let received: Uint8Array | undefined;

  const actual = await inspectDocxStyleSnapshot(bytes, {
    async inspectDocxStyleSnapshot(input) {
      received = input;
      return expected;
    },
  });

  assert.equal(received, bytes);
  assert.equal(actual, expected);
});

test(
  "local native engine returns a structured style snapshot",
  { skip: !process.env.OPENSUITE_ENGINE_PATH },
  async () => {
    const binding = await createNapiDocxEngineBinding();
    const bytes = new Uint8Array(buildMinimalDocx(["Local style check"]));
    const snapshot = await inspectDocxStyleSnapshot(bytes, binding);

    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.schemaVersion, 1);
    assert.equal(snapshot.paragraphCount, 1);
    assert.equal(snapshot.runCount, 1);
    assert.deepEqual(bytes, new Uint8Array(buildMinimalDocx(["Local style check"])));
  },
);

test('paragraph inspection transports native list facts for preservation decisions', { skip: !process.env.OPENSUITE_ENGINE_PATH }, async () => {
  const binding = await createNapiDocxEngineBinding();
  const input = buildMinimalDocx(['First item']);
  const changed = await binding.executeDocxExtended!(input, 'executeDocxSetParagraphsList', { targets: [{ text: 'First item' }], kind: 'bullet' });
  assert.equal(changed.result.ok, true);
  assert.ok(changed.output);
  const result = await binding.inspectDocx(changed.output, { focus: { kind: 'paragraphs' } });
  assert.deepEqual(result.paragraphs?.items[0]?.list, { kind: 'bullet', level: 0, supported: true });
});
