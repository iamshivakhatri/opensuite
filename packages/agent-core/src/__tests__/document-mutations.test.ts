import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentRunner,
  Capabilities,
  DOCUMENT_TOOL_NAMES,
  createCapabilities,
  createDocumentRunState,
  createDocumentToolContext,
  createDocumentToolRegistry,
  createInMemoryDocumentMutationExecutor,
  createMockDocumentRuntime,
  createScriptedAgentModel,
  mockBaseHeadingText,
  mutableDocumentCapabilities,
  mockCapabilitiesForFormat,
  toolExecutionMode,
  assistantOnlyResponse,
  toolCallResponse,
  type DocumentRef,
} from "../index.js";

const docxRef: DocumentRef = {
  documentId: "doc-docx",
  versionId: "ver-1",
  format: "docx",
};

const pptxRef: DocumentRef = {
  documentId: "doc-pptx",
  versionId: "ver-1",
  format: "pptx",
};

const xlsxRef: DocumentRef = {
  documentId: "doc-xlsx",
  versionId: "ver-1",
  format: "xlsx",
};

test("DOCX replace then inspect sees changed text; base fixture stays immutable", async () => {
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const runId = "run-docx-1";

  const replaced = await runtime.execute!(
    docxRef,
    {
      type: "document.replace_text",
      baseVersionId: docxRef.versionId,
      payload: { find: "Revenue Analysis", replace: "Sales Analysis" },
    },
    { runId },
  );
  assert.equal(replaced.status, "success");
  if (replaced.status === "success") {
    assert.equal(replaced.change?.operation, "document.replace_text");
    assert.match(replaced.change?.after ?? "", /Sales Analysis/);
  }

  const inspected = await runtime.inspect(docxRef, {
    focus: { kind: "headings" },
    runId,
  });
  assert.equal(inspected.status, "success");
  if (inspected.status === "success") {
    assert.ok(
      inspected.payload.format === "docx" &&
        inspected.payload.headings?.some((h) => h.text === "Sales Analysis"),
    );
    assert.ok(
      !(
        inspected.payload.format === "docx" &&
        inspected.payload.headings?.some((h) => h.text === "Revenue Analysis")
      ),
    );
  }

  assert.equal(mockBaseHeadingText("docx:h:revenue"), "Revenue Analysis");

  // Independent run still sees the immutable base.
  const other = await runtime.inspect(docxRef, {
    focus: { kind: "headings" },
    runId: "run-docx-other",
  });
  assert.equal(other.status, "success");
  if (other.status === "success" && other.payload.format === "docx") {
    assert.ok(
      other.payload.headings?.some((h) => h.text === "Revenue Analysis"),
    );
  }
});

test("PPTX update then inspect sees changed slide", async () => {
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const runId = "run-pptx-1";

  const updated = await runtime.execute!(
    pptxRef,
    {
      type: "slides.update_text",
      baseVersionId: pptxRef.versionId,
      payload: { slideIndex: 1, title: "Growth Highlights" },
    },
    { runId },
  );
  assert.equal(updated.status, "success");

  const inspected = await runtime.inspect(pptxRef, {
    focus: { kind: "slide", index: 1 },
    runId,
  });
  assert.equal(inspected.status, "success");
  if (inspected.status === "success" && inspected.payload.format === "pptx") {
    assert.equal(inspected.payload.slides?.[0]?.title, "Growth Highlights");
  }
});

test("XLSX set cells then inspect sees changed range", async () => {
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const runId = "run-xlsx-1";

  const set = await runtime.execute!(
    xlsxRef,
    {
      type: "workbook.set_cells",
      baseVersionId: xlsxRef.versionId,
      payload: {
        sheet: "Revenue",
        cells: [{ address: "B2", value: 99_000_000 }],
      },
    },
    { runId },
  );
  assert.equal(set.status, "success");

  const inspected = await runtime.inspect(xlsxRef, {
    focus: { kind: "range", sheet: "Revenue", address: "B2" },
    runId,
  });
  assert.equal(inspected.status, "success");
  if (inspected.status === "success" && inspected.payload.format === "xlsx") {
    assert.equal(inspected.payload.cells?.[0]?.value, 99_000_000);
  }
});

test("write tools are sequential and capability-gated in the registry", () => {
  const docxTools = createDocumentToolRegistry(mutableDocumentCapabilities());
  assert.ok(docxTools.get(DOCUMENT_TOOL_NAMES.replaceText));
  assert.equal(docxTools.get(DOCUMENT_TOOL_NAMES.updateSlideText), undefined);
  assert.equal(docxTools.get(DOCUMENT_TOOL_NAMES.setCells), undefined);
  assert.equal(
    toolExecutionMode(docxTools.require(DOCUMENT_TOOL_NAMES.replaceText)),
    "sequential",
  );

  const pptxTools = createDocumentToolRegistry(mockCapabilitiesForFormat("pptx"));
  assert.ok(pptxTools.get(DOCUMENT_TOOL_NAMES.updateSlideText));
  assert.equal(pptxTools.get(DOCUMENT_TOOL_NAMES.replaceText), undefined);

  const xlsxTools = createDocumentToolRegistry(mockCapabilitiesForFormat("xlsx"));
  assert.ok(xlsxTools.get(DOCUMENT_TOOL_NAMES.setCells));
  assert.equal(xlsxTools.get(DOCUMENT_TOOL_NAMES.replaceText), undefined);
});

test("unsupported format/capability and invalid targets fail without corrupting working state", async () => {
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const runId = "run-safe-fail";

  const wrongFormat = await runtime.execute!(
    pptxRef,
    {
      type: "document.replace_text",
      baseVersionId: pptxRef.versionId,
      payload: { find: "Agenda", replace: "Plan" },
    },
    { runId },
  );
  assert.equal(wrongFormat.status, "error");

  const missing = await runtime.execute!(
    docxRef,
    {
      type: "document.replace_text",
      baseVersionId: docxRef.versionId,
      payload: { find: "DOES_NOT_EXIST_XYZ", replace: "Nope" },
    },
    { runId },
  );
  assert.equal(missing.status, "error");

  const after = await runtime.inspect(docxRef, {
    focus: { kind: "headings" },
    runId,
  });
  assert.equal(after.status, "success");
  if (after.status === "success" && after.payload.format === "docx") {
    assert.ok(
      after.payload.headings?.some((h) => h.text === "Revenue Analysis"),
    );
  }

  const readOnly = createMockDocumentRuntime({
    capabilities: createCapabilities(
      Capabilities.DocumentInspect,
      Capabilities.DocumentFind,
    ),
  });
  const blocked = await readOnly.execute!(docxRef, {
    type: "document.replace_text",
    baseVersionId: docxRef.versionId,
    payload: { find: "Revenue Analysis", replace: "X" },
  });
  assert.equal(blocked.status, "error");
  if (blocked.status === "error") {
    assert.equal(blocked.code, "UNSUPPORTED_CAPABILITY");
  }
});

test("partial success preserves prior successful mutations in the same run", async () => {
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const runId = "run-partial";

  const first = await runtime.execute!(
    docxRef,
    {
      type: "document.replace_text",
      baseVersionId: docxRef.versionId,
      payload: { find: "Revenue Analysis", replace: "Sales Analysis" },
    },
    { runId },
  );
  assert.equal(first.status, "success");

  const second = await runtime.execute!(
    docxRef,
    {
      type: "document.replace_text",
      baseVersionId: docxRef.versionId,
      payload: { find: "DOES_NOT_EXIST", replace: "X" },
    },
    { runId },
  );
  assert.equal(second.status, "error");

  const third = await runtime.execute!(
    docxRef,
    {
      type: "document.replace_text",
      baseVersionId: docxRef.versionId,
      payload: { find: "Outlook", replace: "Forward Look" },
    },
    { runId },
  );
  assert.equal(third.status, "success");

  const inspected = await runtime.inspect(docxRef, {
    focus: { kind: "headings" },
    runId,
  });
  assert.equal(inspected.status, "success");
  if (inspected.status === "success" && inspected.payload.format === "docx") {
    const texts = inspected.payload.headings?.map((h) => h.text) ?? [];
    assert.ok(texts.includes("Sales Analysis"));
    assert.ok(texts.includes("Forward Look"));
    assert.ok(!texts.includes("Revenue Analysis"));
  }
});

test("AgentRunner can mutate then inspect then finish", async () => {
  const runtime = createMockDocumentRuntime({
    capabilities: mutableDocumentCapabilities(),
  });
  const tools = createDocumentToolRegistry(mutableDocumentCapabilities());
  const model = createScriptedAgentModel([
    toolCallResponse("ok", [
      {
        id: "c1",
        name: DOCUMENT_TOOL_NAMES.replaceText,
        input: { find: "Revenue Analysis", replace: "Sales Analysis" },
      },
    ]),
    toolCallResponse("ok", [
      {
        id: "c2",
        name: DOCUMENT_TOOL_NAMES.inspect,
        input: { focus: { kind: "headings" } },
      },
    ]),
    assistantOnlyResponse(
      "The resulting heading is Sales Analysis.",
    ),
  ]);

  const runner = new AgentRunner({
    model,
    tools,
    createToolContext: createDocumentToolContext({
      state: createDocumentRunState(docxRef),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
    }),
    capabilities: mutableDocumentCapabilities(),
  });

  const result = await runner.run({
    instruction:
      "Replace 'Revenue Analysis' with 'Sales Analysis', then inspect headings.",
    threadId: "thread-1",
    runId: "run-agent-mutate",
    primaryDocument: docxRef,
  });

  assert.equal(result.status, "completed");
  assert.match(result.summary ?? "", /Sales Analysis/);
  assert.ok(
    result.toolOutcomes.some(
      (o) => o.toolName === DOCUMENT_TOOL_NAMES.replaceText && o.status === "succeeded",
    ),
  );
  assert.ok(
    result.toolOutcomes.some(
      (o) => o.toolName === DOCUMENT_TOOL_NAMES.inspect && o.status === "succeeded",
    ),
  );
});
