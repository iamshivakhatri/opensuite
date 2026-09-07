import assert from "node:assert/strict";
import { test } from "node:test";

import { Capabilities, type DocumentRef } from "@opensuite/agent-core";

import { createMemoryArtifactLoader } from "../document-artifact-loader.js";
import {
  createOpenSuiteEngineAdapter,
  mapDeleteParagraphOperation,
  mapInsertParagraphsOperation,
  mapRustCapabilitiesToRuntime,
  mapSetParagraphFormattingOperation,
  mapSetParagraphStyleOperation,
  mapSetTextFormattingOperation,
} from "../opensuite-engine-adapter.js";
import { createFakeDocxEngineBinding } from "./fake-docx-binding.js";

const docRef: DocumentRef = {
  documentId: "doc-1",
  versionId: "ver-1",
  format: "docx",
};

test("mapInsertParagraphsOperation preserves ordered texts and placement", () => {
  const mapped = mapInsertParagraphsOperation({
    type: "document.insert_paragraphs",
    baseVersionId: "ver-1",
    payload: {
      texts: ["Title", "P1", "P2"],
      placement: { kind: "before", handle: "b3" },
    },
  });
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  assert.deepEqual(mapped.operation, {
    texts: ["Title", "P1", "P2"],
    placement: { kind: "before", handle: "b3" },
    baseRevision: "ver-1",
  });
});

test("style / paragraph-format / text-format / delete map to native shapes", () => {
  const style = mapSetParagraphStyleOperation({
    type: "document.set_paragraph_style",
    baseVersionId: "ver-1",
    payload: { target: { text: "Title" }, style: "Heading 1" },
  });
  assert.equal(style.ok, true);
  if (style.ok) {
    assert.deepEqual(style.operation, {
      target: { text: "Title" },
      style: "Heading 1",
      baseRevision: "ver-1",
    });
  }

  const fmt = mapSetParagraphFormattingOperation({
    type: "document.set_paragraph_formatting",
    baseVersionId: "ver-1",
    payload: {
      target: { text: "Title", occurrence: 1 },
      alignment: "center",
      spacingAfterTwips: 120,
    },
  });
  assert.equal(fmt.ok, true);
  if (fmt.ok) {
    assert.deepEqual(fmt.operation, {
      target: { text: "Title", occurrence: 1 },
      alignment: "center",
      spacingAfterTwips: 120,
      baseRevision: "ver-1",
    });
  }

  const text = mapSetTextFormattingOperation({
    type: "document.set_text_formatting",
    baseVersionId: "ver-1",
    payload: { target: { text: "quiet glory" }, bold: true },
  });
  assert.equal(text.ok, true);
  if (text.ok) {
    assert.deepEqual(text.operation, {
      target: { text: "quiet glory" },
      bold: true,
      baseRevision: "ver-1",
    });
  }

  const del = mapDeleteParagraphOperation({
    type: "document.delete_paragraph",
    baseVersionId: "ver-1",
    payload: { target: { text: "Conclusion" } },
  });
  assert.equal(del.ok, true);
  if (del.ok) {
    assert.deepEqual(del.operation, {
      target: { text: "Conclusion" },
      baseRevision: "ver-1",
    });
  }
});

test("insert_paragraphs adapter calls binding once with verified bytes", async () => {
  const binding = createFakeDocxEngineBinding({
    executeDocxInsertParagraphs: async (_input, operation) => ({
      result: {
        ok: true,
        status: "ok",
        diagnostics: [],
        changes: [
          {
            kind: "insert_paragraphs",
            before: "",
            after: operation.texts.join("|"),
          },
        ],
      },
      output: new Uint8Array([7, 7, 7]),
    }),
  });
  const loader = createMemoryArtifactLoader(
    new Map([["ver-1", new Uint8Array([1, 1, 1])]]),
  );
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: loader,
    binding,
  });

  const result = await runtime.execute!(docRef, {
    type: "document.insert_paragraphs",
    baseVersionId: "ver-1",
    payload: {
      texts: ["a", "b", "c"],
      placement: { kind: "end" },
    },
  });

  assert.equal(result.status, "success");
  assert.deepEqual(result.artifactBytes, new Uint8Array([7, 7, 7]));
  assert.equal(binding.insertParagraphsCalls.length, 1);
  assert.deepEqual(binding.insertParagraphsCalls[0]?.operation, {
    texts: ["a", "b", "c"],
    placement: { kind: "end" },
    baseRevision: "ver-1",
  });
});

test("failed delete preserves structured diagnostics and no artifact", async () => {
  const binding = createFakeDocxEngineBinding({
    executeDocxDeleteParagraph: async () => ({
      result: {
        ok: false,
        status: "failed",
        diagnostics: [
          {
            code: "TARGET_NOT_FOUND",
            severity: "error",
            message: "paragraph not found",
            reasonCode: "NO_MATCH",
            operation: "delete_paragraph",
          },
        ],
        changes: [],
      },
    }),
  });
  const loader = createMemoryArtifactLoader(
    new Map([["ver-1", new Uint8Array([1])]]),
  );
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: loader,
    binding,
  });

  const result = await runtime.execute!(docRef, {
    type: "document.delete_paragraph",
    baseVersionId: "ver-1",
    payload: { target: { text: "Nope" } },
  });

  assert.equal(result.status, "error");
  if (result.status !== "error") return;
  assert.equal(result.code, "TARGET_NOT_FOUND");
  assert.equal(result.diagnostics[0]?.reasonCode, "NO_MATCH");
  assert.equal(result.diagnostics[0]?.operation, "delete_paragraph");
  assert.equal(binding.deleteParagraphCalls.length, 1);
});

test("Rust paragraph caps synthesize document.mutate", () => {
  const caps = mapRustCapabilitiesToRuntime({
    ok: true,
    protocolVersion: 1,
    engineVersion: "test",
    formats: [
      {
        format: "docx",
        capabilities: [
          "inspect",
          "insert_paragraphs",
          "delete_paragraph",
          "set_paragraph_style",
          "set_paragraph_formatting",
          "set_text_formatting",
        ],
      },
    ],
  });
  assert.ok(caps.ids.has(Capabilities.DocumentMutate));
  assert.ok(caps.ids.has("insert_paragraphs"));
  assert.ok(caps.ids.has("delete_paragraph"));
});
