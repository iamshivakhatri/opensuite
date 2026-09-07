import assert from "node:assert/strict";
import { test } from "node:test";

import { mockCapabilitiesForFormat } from "@opensuite/agent-core";
import type { DocxEngineBinding } from "@opensuite/engine-client";

import { createDocumentRuntimeResolver } from "../documents/runtime.js";

function unusedTableMutations(): Pick<
  DocxEngineBinding,
  | "executeDocxSetTableCellsText"
  | "executeDocxInsertTableRows"
  | "executeDocxInsertTableColumn"
  | "executeDocxInsertParagraph"
  | "executeDocxInsertParagraphs"
  | "executeDocxDeleteParagraph"
  | "executeDocxSetParagraphStyle"
  | "executeDocxSetParagraphFormatting"
  | "executeDocxSetTextFormatting"
  | "executeDocxCreateTable"
  | "executeDocxDeleteTable"
  | "executeDocxDeleteTableRow"
  | "executeDocxDeleteTableColumn"
  | "executeDocxSetTableFormatting"
> {
  const fail = async () => ({
    result: {
      ok: false as const,
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
  });
  return {
    executeDocxSetTableCellsText: fail,
    executeDocxInsertTableRows: fail,
    executeDocxInsertTableColumn: fail,
    executeDocxInsertParagraph: fail,
    executeDocxInsertParagraphs: fail,
    executeDocxDeleteParagraph: fail,
    executeDocxSetParagraphStyle: fail,
    executeDocxSetParagraphFormatting: fail,
    executeDocxSetTextFormatting: fail,
    executeDocxCreateTable: fail,
    executeDocxDeleteTable: fail,
    executeDocxDeleteTableRow: fail,
    executeDocxDeleteTableColumn: fail,
    executeDocxSetTableFormatting: fail,
  };
}

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
    createBlankDocx() {
      return new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
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
      if (request.focus.kind !== "context") {
        return {
          ok: false,
          focus: request.focus.kind,
          diagnostics: [
            {
              code: "UNSUPPORTED_OPERATION",
              severity: "error",
              message: `stub does not implement ${request.focus.kind}`,
            },
          ],
        };
      }
      return {
        ok: true,
        focus: "context",
        context: {
          target: { text: request.focus.text },
          nearby: [],
        },
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
    ...unusedTableMutations(),
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
  });

  const docxRuntime = resolve({ format: "docx", ownerUserId: "user-1" });
  const pptxRuntime = resolve({ format: "pptx", ownerUserId: "user-1" });
  const xlsxRuntime = resolve({ format: "xlsx", ownerUserId: "user-1" });

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

  const pptxCaps = await pptxRuntime.capabilities({
    documentId: "d",
    versionId: "v",
    format: "pptx",
  });
  assert.deepEqual(
    [...pptxCaps.ids].sort(),
    [...mockCapabilitiesForFormat("pptx").ids].sort(),
  );
  assert.ok(!pptxCaps.ids.has("replace_text"));

  const xlsxCaps = await xlsxRuntime.capabilities({
    documentId: "d",
    versionId: "v",
    format: "xlsx",
  });
  assert.ok(xlsxCaps.ids.has("workbook.set_cells"));
  assert.ok(!xlsxCaps.ids.has("replace_text"));
});
