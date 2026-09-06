import assert from "node:assert/strict";
import { test } from "node:test";

import { mutableDocumentCapabilities } from "@opensuite/agent-core";
import type { DocxEngineBinding } from "@opensuite/engine-client";

import { createDocumentRuntimeResolver } from "../documents/runtime.js";

function fakeBinding(): DocxEngineBinding {
  return {
    getDocxCapabilities() {
      return {
        ok: true,
        protocolVersion: 1,
        engineVersion: "test",
        formats: [
          {
            format: "docx",
            capabilities: ["find_text", "inspect_context", "replace_text"],
          },
        ],
      };
    },
    async findDocxText() {
      return {
        ok: true,
        query: "",
        matchCount: 0,
        matches: [],
        diagnostics: [],
      };
    },
    async inspectDocx(_input, request) {
      return {
        ok: true,
        target: request.target,
        nearby: [],
        diagnostics: [],
      };
    },
    async executeDocxReplaceText() {
      return {
        result: {
          ok: false,
          status: "failed",
          diagnostics: [
            {
              code: "UNSUPPORTED_OPERATION",
              severity: "error",
              message: "unused",
            },
          ],
          changes: [],
        },
      };
    },
  };
}

test("resolver uses engine adapter for docx and mock for pptx", async () => {
  const documents = {
    async readExactVersionBytes() {
      return Buffer.from([1, 2, 3]);
    },
  };

  const resolve = createDocumentRuntimeResolver({
    documents,
    binding: fakeBinding(),
    mockCapabilities: mutableDocumentCapabilities(),
  });

  const docxRuntime = resolve({ format: "docx", ownerUserId: "user-1" });
  const pptxRuntime = resolve({ format: "pptx", ownerUserId: "user-1" });

  const docxOverview = await docxRuntime.inspect(
    { documentId: "d", versionId: "v", format: "docx" },
    { focus: { kind: "overview" } },
  );
  assert.equal(docxOverview.status, "error");
  if (docxOverview.status === "error") {
    assert.equal(docxOverview.diagnostics[0]?.code, "UNSUPPORTED_OPERATION");
  }

  const pptxOverview = await pptxRuntime.inspect(
    { documentId: "d", versionId: "v", format: "pptx" },
    { focus: { kind: "overview" } },
  );
  assert.equal(pptxOverview.status, "success");
});
