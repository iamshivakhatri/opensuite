import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentCoreError } from "../errors.js";
import {
  defineDocumentTool,
  executePersistedMutation,
} from "../document-tools/define-tool.js";
import { parseTableTarget, parseCellTarget } from "../document-tools/selectors.js";
import { createInMemoryDocumentMutationExecutor } from "../document-mutation.js";
import { createMockDocumentRuntime } from "../mock-runtime.js";
import { mutableDocumentCapabilities } from "../document-tools/index.js";
import type { ToolExecutionContext } from "../model.js";
import type { DocumentRef } from "../types.js";

describe("document tool shared abstractions", () => {
  it("defineDocumentTool preserves name and parse/execute", async () => {
    const tool = defineDocumentTool({
      name: "document.test",
      description: "test",
      inputSchema: { type: "object", properties: {} },
      parseInput: () => ({ ok: true as const }),
      execute: async () => ({ done: true as const }),
    });
    assert.equal(tool.name, "document.test");
    assert.deepEqual(tool.parseInput({}), { ok: true });
    assert.deepEqual(
      await tool.execute({ ok: true }, {
        runId: "r",
        primaryDocument: null,
        signal: new AbortController().signal,
        events: { emit() {} },
      }),
      { done: true },
    );
  });

  it("parseTableTarget accepts handle or headerCells", () => {
    assert.deepEqual(parseTableTarget({ handle: "t0" }, "t"), { handle: "t0" });
    assert.deepEqual(
      parseTableTarget({ headerCells: ["A", "B"], occurrence: 0 }, "t"),
      { headerCells: ["A", "B"] },
    );
  });

  it("parseCellTarget prefers nested handle", () => {
    assert.deepEqual(
      parseCellTarget({ target: { handle: "t0:r1:c0" } }, "t"),
      { handle: "t0:r1:c0" },
    );
    assert.deepEqual(
      parseCellTarget(
        { target: { rowLabel: "OpenSuite", columnHeader: "Year", occurrence: 0 } },
        "t",
      ),
      { rowLabel: "OpenSuite", columnHeader: "Year" },
    );
  });

  it("executePersistedMutation advances document only on success", async () => {
    const runtime = createMockDocumentRuntime({
      capabilities: mutableDocumentCapabilities(),
    });
    const mutations = createInMemoryDocumentMutationExecutor(runtime);
    const doc: DocumentRef = {
      documentId: "d1",
      versionId: "v1",
      format: "docx",
    };
    let advanced: DocumentRef | undefined;
    const emitted: string[] = [];
    const ctx: ToolExecutionContext = {
      runId: "run",
      primaryDocument: doc,
      signal: new AbortController().signal,
      events: {
        emit(event) {
          emitted.push(event.type);
        },
      },
      runtime,
      mutations,
      advancePrimaryDocument: (next) => {
        advanced = next;
      },
    };

    const ok = await executePersistedMutation(ctx, "document.replace_text", (document, m) =>
      m.replaceText({
        document,
        find: "Revenue Analysis",
        replace: "Sales Analysis",
      }),
    );
    assert.equal(ok.status, "success");
    assert.ok(advanced);
    assert.notEqual(advanced!.versionId, doc.versionId);
    assert.deepEqual(emitted, ["document.version.advanced"]);

    advanced = undefined;
    emitted.length = 0;
    await assert.rejects(
      () =>
        executePersistedMutation(ctx, "document.replace_text", async () => ({
          status: "error",
          code: "PRECONDITION_FAILED",
          diagnostics: [
            {
              code: "PRECONDITION_FAILED",
              severity: "error",
              message: "stale",
            },
          ],
        })),
      (error: unknown) =>
        error instanceof AgentCoreError && error.code === "TOOL_FAILURE",
    );
    assert.equal(advanced, undefined);
    assert.deepEqual(emitted, []);
  });
});
