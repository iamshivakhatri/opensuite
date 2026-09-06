import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Capabilities,
  createDocumentReplaceTextTool,
  createFakeToolExecutionContext,
  hasCapability,
  listCapabilities,
  type DocumentRef,
} from "@opensuite/agent-core";

import { createMemoryArtifactLoader } from "../document-artifact-loader.js";
import {
  assertNoEngineSourceIdentities,
  createOpenSuiteEngineAdapter,
  mapReplaceTextOperation,
  mapRustCapabilitiesToRuntime,
} from "../opensuite-engine-adapter.js";
import { buildMinimalDocx } from "../__fixtures__/minimal-docx.js";
import { createFakeDocxEngineBinding } from "./fake-docx-binding.js";

const docRef: DocumentRef = {
  documentId: "doc-1",
  versionId: "ver-1",
  format: "docx",
};

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

test("capabilities come from binding / Rust, not a hardcoded duplicate list", async () => {
  const binding = createFakeDocxEngineBinding({
    getDocxCapabilities: () => ({
      ok: true,
      protocolVersion: 1,
      engineVersion: "9.9.9",
      formats: [
        {
          format: "docx",
          capabilities: [
            "find_text",
            "inspect_context",
            "replace_text",
            "set_table_cell_text",
          ],
        },
      ],
    }),
  });

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({ "ver-1": buildMinimalDocx(["x"]) }),
    binding,
  });

  const caps = await runtime.capabilities(docRef);
  const ids = listCapabilities(caps);
  assert.ok(ids.includes("find_text"));
  assert.ok(ids.includes("inspect_context"));
  assert.ok(ids.includes("replace_text"));
  assert.ok(ids.includes("set_table_cell_text"));
  assert.ok(hasCapability(caps, Capabilities.DocumentFind));
  assert.ok(hasCapability(caps, Capabilities.DocumentInspect));
  assert.ok(hasCapability(caps, Capabilities.DocumentMutate));

  const mapped = mapRustCapabilitiesToRuntime(binding.getDocxCapabilities());
  assert.deepEqual(listCapabilities(caps), listCapabilities(mapped));
});

test("adapter success: exact bytes reach binding and verified artifact returns", async () => {
  const inputBytes = buildMinimalDocx(["old text"]);
  const outputBytes = buildMinimalDocx(["OpenSuite replacement"]);
  const binding = createFakeDocxEngineBinding({
    executeDocxReplaceText: () => ({
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
    }),
  });

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
  assert.equal(binding.replaceCalls.length, 1);
  assert.deepEqual(
    Buffer.from(binding.replaceCalls[0]!.input),
    Buffer.from(inputBytes),
  );
  if (result.status === "success") {
    assert.ok(result.artifactBytes);
    assert.deepEqual(
      Buffer.from(result.artifactBytes!),
      Buffer.from(outputBytes),
    );
    assertNoEngineSourceIdentities(result);
  }
});

test("find loads exact version bytes and maps matches", async () => {
  const v1 = buildMinimalDocx(["hello Date:"]);
  const v2 = buildMinimalDocx(["other"]);
  const binding = createFakeDocxEngineBinding({
    findDocxText: (input, request) => {
      assert.deepEqual(Buffer.from(input), v1);
      assert.equal(request.text, "Date:");
      return {
        ok: true,
        query: "Date:",
        matchCount: 2,
        matches: [
          {
            occurrence: 1,
            text: "Date:",
            before: "hello ",
            after: "",
            container: "paragraph",
          },
          {
            occurrence: 2,
            text: "Date:",
            before: "",
            after: " end",
            container: "paragraph",
          },
        ],
        diagnostics: [],
      };
    },
  });

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": v1,
      "ver-2": v2,
    }),
    binding,
  });

  const found = await runtime.find!(docRef, { query: "Date:", mode: "text" });
  assert.equal(found.status, "success");
  if (found.status === "success") {
    assert.equal(found.matches.length, 2);
    assert.equal(found.matches[0]!.handle, "docx:find:1");
    assert.match(found.matches[0]!.location, /paragraph #1/);
    assertNoEngineSourceIdentities(found);
  }

  // Exact version: still ver-1 even when ver-2 exists in the loader map.
  assert.equal(binding.findCalls.length, 1);
  assert.deepEqual(Buffer.from(binding.findCalls[0]!.input), v1);
});

test("find mode semantic is honestly unsupported", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["x"]),
    }),
    binding: createFakeDocxEngineBinding(),
  });

  const result = await runtime.find!(docRef, {
    query: "x",
    mode: "semantic",
  });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.diagnostics[0]!.code, "UNSUPPORTED_OPERATION");
  }
});

test("find invalid document maps diagnostics without artifact fallback", async () => {
  const binding = createFakeDocxEngineBinding({
    findDocxText: () => ({
      ok: false,
      query: "x",
      matchCount: 0,
      matches: [],
      diagnostics: [
        {
          code: "INVALID_ZIP",
          severity: "error",
          message: "bad package",
        },
      ],
    }),
  });

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": Buffer.from("not a docx"),
    }),
    binding,
  });

  const result = await runtime.find!(docRef, { query: "x", mode: "text" });
  assert.equal(result.status, "error");
  if (result.status === "error") {
    assert.equal(result.diagnostics[0]!.code, "DOCUMENT_INVALID");
  }
});

test("inspect context works; broad focuses are unsupported without mock fallback", async () => {
  const inputBytes = buildMinimalDocx(["target text", "nearby"]);
  const binding = createFakeDocxEngineBinding({
    inspectDocx: (input, request) => {
      assert.deepEqual(Buffer.from(input), inputBytes);
      assert.equal(request.target.text, "target text");
      assert.equal(request.before, 1);
      assert.equal(request.after, 0);
      return {
        ok: true,
        target: { text: "target text" },
        container: {
          relativePosition: 0,
          text: "target text",
          container: "paragraph",
        },
        nearby: [
          {
            relativePosition: -1,
            text: "nearby",
            container: "paragraph",
          },
        ],
        diagnostics: [],
      };
    },
  });

  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({ "ver-1": inputBytes }),
    binding,
  });

  const context = await runtime.inspect(docRef, {
    focus: { kind: "context", text: "target text", before: 1, after: 0 },
  });
  assert.equal(context.status, "success");
  if (context.status === "success" && context.payload.format === "docx") {
    assert.equal(context.payload.context?.container?.text, "target text");
    assert.equal(context.payload.context?.nearby[0]?.text, "nearby");
    assert.equal(context.payload.headings, undefined);
    assertNoEngineSourceIdentities(context);
  }

  const headings = await runtime.inspect(docRef, {
    focus: { kind: "headings" },
  });
  assert.equal(headings.status, "error");
  if (headings.status === "error") {
    assert.equal(headings.diagnostics[0]!.code, "UNSUPPORTED_OPERATION");
  }
  assert.equal(binding.inspectCalls.length, 1);
});

test("TARGET_NOT_FOUND maps to runtime error with no artifact bytes", async () => {
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["hello"]),
    }),
    binding: createFakeDocxEngineBinding({
      executeDocxReplaceText: () => ({
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
      }),
    }),
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
    binding: createFakeDocxEngineBinding({
      executeDocxReplaceText: () => ({
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
      }),
    }),
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
    binding: createFakeDocxEngineBinding({
      executeDocxReplaceText: () => ({
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
      }),
    }),
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
    binding: createFakeDocxEngineBinding({
      executeDocxReplaceText: () => ({
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
      }),
    }),
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
  const binding = createFakeDocxEngineBinding({
    executeDocxReplaceText: () => {
      throw new Error("should not call binding");
    },
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
  assert.equal(binding.replaceCalls.length, 0);
});

test("AgentTool depends only on DocumentRuntime, not N-API package", async () => {
  const outputBytes = buildMinimalDocx(["replaced"]);
  const runtime = createOpenSuiteEngineAdapter({
    artifactLoader: createMemoryArtifactLoader({
      "ver-1": buildMinimalDocx(["old text"]),
    }),
    binding: createFakeDocxEngineBinding({
      executeDocxReplaceText: () => ({
        result: {
          ok: true,
          status: "applied",
          diagnostics: [],
          changes: [
            { kind: "text_replaced", before: "old text", after: "replaced" },
          ],
        },
        output: outputBytes,
      }),
    }),
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
  assert.equal(
    Object.hasOwn(
      await import("@opensuite/agent-core"),
      "executeDocxReplaceText",
    ),
    false,
  );
});
