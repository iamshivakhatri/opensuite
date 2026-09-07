import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentCoreError,
  shapeDiagnosticForToolResult,
  type Diagnostic,
} from "@opensuite/agent-core";

import { formatToolResultContent } from "../agent/model/shared.js";

const structured: Diagnostic = {
  code: "UNSUPPORTED_OPERATION",
  severity: "error",
  reasonCode: "MULTIPLE_PARAGRAPHS",
  operation: "set_table_cells_text",
  targetHandle: "t0:r1:c1",
  message: "multi-paragraph cell",
};

test("formatToolResultContent exposes structured diagnostic fields to the model", () => {
  const content = formatToolResultContent({
    role: "tool",
    toolCallId: "c1",
    toolName: "document.set_table_cells_text",
    status: "failed",
    summary: structured.message,
    diagnostic: structured,
  });

  assert.match(content, /status=failed/);
  assert.match(content, /"reasonCode":"MULTIPLE_PARAGRAPHS"/);
  assert.match(content, /"operation":"set_table_cells_text"/);
  assert.match(content, /"targetHandle":"t0:r1:c1"/);
  assert.match(content, /"code":"UNSUPPORTED_OPERATION"/);
  assert.doesNotMatch(content, /multiple paragraphs/i);
});

test("tool-failed step output shape retains structured fields", () => {
  // Mirrors apps/api agent event bridge projection for tool.failed.
  const output = {
    ...shapeDiagnosticForToolResult(structured),
    message: structured.message,
  };
  assert.deepEqual(output, {
    code: "UNSUPPORTED_OPERATION",
    message: "multi-paragraph cell",
    reasonCode: "MULTIPLE_PARAGRAPHS",
    operation: "set_table_cells_text",
    targetHandle: "t0:r1:c1",
  });
});

test("application STALE_HANDLE projection stays separate from engine reasonCode", () => {
  const diagnostic: Diagnostic = {
    code: "STALE_HANDLE",
    severity: "error",
    message: "Structural handle is stale for the current document version",
    details: { handle: "t0:r1:c1" },
  };
  const error = new AgentCoreError("STALE_HANDLE", diagnostic.message, {
    diagnostic,
  });
  const output = shapeDiagnosticForToolResult(error.diagnostic!);
  assert.equal(output.code, "STALE_HANDLE");
  assert.equal(output.reasonCode, undefined);
  assert.deepEqual(output.details, { handle: "t0:r1:c1" });
});
