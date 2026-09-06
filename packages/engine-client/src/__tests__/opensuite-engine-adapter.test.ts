import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDocumentReplaceTextTool,
  createFakeToolExecutionContext,
  type DocumentRef,
} from "@opensuite/agent-core";

import { createMemoryArtifactLoader } from "../document-artifact-loader.js";
import type {
  DocxEngineBinding,
  DocxReplaceTextBindingResult,
  DocxReplaceTextOperation,
} from "../docx-engine-binding.js";
import {
  assertNoEngineSourceIdentities,
  createOpenSuiteEngineAdapter,
  mapReplaceTextOperation,
} from "../opensuite-engine-adapter.js";
import { buildMinimalDocx } from "../__fixtures__/minimal-docx.js";

const docRef: DocumentRef = {
  documentId: "doc-1",
  versionId: "ver-1",
  format: "docx",
};

function createRecordingBinding(
  respond: (
    input: Uint8Array,
    operation: DocxReplaceTextOperation,
  ) => DocxReplaceTextBindingResult | Promise<DocxReplaceTextBindingResult>,
): DocxEngineBinding & {
  readonly calls: Array<{
    input: Uint8Array;
    operation: DocxReplaceTextOperation;
  }>;
} {
  const calls: Array<{
    input: Uint8Array;
    operation: DocxReplaceTextOperation;
  }> = [];
  return {
    calls,
    async executeDocxReplaceText(input, operation) {
      calls.push({ input, operation });
      return respond(input, operation);
    },
  };
}

test("maps document.replace_text payload to engine ReplaceText DTO", () => {
  const mapped = mapReplaceTextOperation({
    type: "document.replace_text",
    baseVersionId: "ver-1",
    payload: {
      find: "old text",
      replace: "new text",
      occurrence: 1,
    },
  });
  assert.equal(mapped.ok, true);
  if (!mapped.ok) return;
  assert.deepEqual(mapped.operation, {
    target: { text: "old text", occurrence: 1 },
    expectedCurrentText: "old text",
    replacement: "new text",
    baseRevision: "ver-1",
  });
});

test("adapter success: exact bytes reach binding and verified artifact returns", async () => {
  const inputBytes = buildMinimalDocx(["old text"]);
  const outputBytes = buildMinimalDocx(["OpenSuite replacement"]);
  const binding = createRecordingBinding(() => ({
    result: {
      ok: true,
      status: "applied",
      diagnostics: [],
      changes: [
        {
          kind: "text_replaced",
          before: "old text",
          after: "OpenSuite replacement",
        },
      ],
    },
    output: outputBytes,
  }));

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": inputBytes,
    }),
    binding,
  });

  const result = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "ver-1",
    payload: { find: "old text", replace: "OpenSuite replacement" },
  });

  assert.equal(result.status, "success");
  assert.equal(binding.calls.length, 1);
  assert.deepEqual(
    Buffer.from(binding.calls[0]!.input),
    Buffer.from(inputBytes),
  );
  assert.deepEqual(binding.calls[0]!.operation, {
    target: { text: "old text" },
    expectedCurrentText: "old text",
    replacement: "OpenSuite replacement",
    baseRevision: "ver-1",
  });

  if (result.status === "success") {
    assert.ok(result.artifactBytes);
    assert.deepEqual(
      Buffer.from(result.artifactBytes!),
      Buffer.from(outputBytes),
    );
    assert.equal(result.change?.before, "old text");
    assert.equal(result.change?.after, "OpenSuite replacement");
    assertNoEngineSourceIdentities(result);
  }
});

test("TARGET_NOT_FOUND maps to runtime error with no artifact bytes", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["hello"]),
    }),
    binding: createRecordingBinding(() => ({
      result: {
        ok: false,
        status: "failed",
        diagnostics: [
          {
            code: "TARGET_NOT_FOUND",
            severity: "error",
            message: "missing",
          },
        ],
        changes: [],
      },
    })),
  });

  const result = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "ver-1",
    payload: { find: "missing", replace: "x" },
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "TARGET_NOT_FOUND");
    assert.equal("artifactBytes" in result, false);
  }
});

test("TARGET_AMBIGUOUS maps to runtime error with no artifact bytes", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["Date:", "Date:"]),
    }),
    binding: createRecordingBinding(() => ({
      result: {
        ok: false,
        status: "failed",
        diagnostics: [
          {
            code: "TARGET_AMBIGUOUS",
            severity: "error",
            message: "ambiguous",
          },
        ],
        changes: [],
      },
    })),
  });

  const result = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "ver-1",
    payload: { find: "Date:", replace: "x" },
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "TARGET_AMBIGUOUS");
  }
});

test("PRECONDITION_FAILED maps to runtime error with no artifact bytes", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["old text"]),
    }),
    binding: createRecordingBinding(() => ({
      result: {
        ok: false,
        status: "failed",
        diagnostics: [
          {
            code: "PRECONDITION_FAILED",
            severity: "error",
            message: "stale expected text",
          },
        ],
        changes: [],
      },
    })),
  });

  const result = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "ver-1",
    payload: {
      find: "old text",
      replace: "x",
      expectedCurrentText: "different",
    },
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "PRECONDITION_FAILED");
  }
});

test("INVALID_ZIP from engine normalizes to DOCUMENT_INVALID", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": Buffer.from("not a docx"),
    }),
    binding: createRecordingBinding(() => ({
      result: {
        ok: false,
        status: "failed",
        diagnostics: [
          {
            code: "INVALID_ZIP",
            severity: "error",
            message: "bad package",
          },
        ],
        changes: [],
      },
    })),
  });

  const result = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "ver-1",
    payload: { find: "x", replace: "y" },
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "DOCUMENT_INVALID");
    assert.equal(result.diagnostics[0]?.code, "DOCUMENT_INVALID");
  }
});

test("baseVersionId mismatch is application CONFLICT before binding", async () => {
  const binding = createRecordingBinding(() => {
    throw new Error("should not call binding");
  });
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["old text"]),
    }),
    binding,
  });

  const result = await runtime.execute!(docRef, {
    type: "document.replace_text",
    baseVersionId: "ver-stale",
    payload: { find: "old text", replace: "x" },
  });

  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.code, "CONFLICT");
  }
  assert.equal(binding.calls.length, 0);
});

test("AgentTool depends only on DocumentRuntime, not N-API package", async () => {
  const outputBytes = buildMinimalDocx(["replaced"]);
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["old text"]),
    }),
    binding: createRecordingBinding(() => ({
      result: {
        ok: true,
        status: "applied",
        diagnostics: [],
        changes: [
          { kind: "text_replaced", before: "old text", after: "replaced" },
        ],
      },
      output: outputBytes,
    })),
  });

  const tool = createDocumentReplaceTextTool();
  const ctx = createFakeToolExecutionContext({
    primaryDocument: docRef,
    runtime,
  });

  const result = await tool.execute(
    { find: "old text", replace: "replaced" },
    ctx,
  );
  assert.equal(result.status, "success");
  // Tool module must not statically import the native package.
  assert.equal(
    Object.hasOwn(
      await import("@opensuite/agent-core"),
      "executeDocxReplaceText",
    ),
    false,
  );
});
