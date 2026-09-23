import assert from "node:assert/strict";
import { test } from "node:test";

import type { DocxEngineBinding } from "@opensuite/engine-client";

import {
  formatRetrievedDocumentContext,
  formatDocumentMap,
  formatWorkspaceRetrievedContext,
  buildDocumentMap,
  rankWorkspaceArtifacts,
  retrieveWorkspaceContext,
  formatTableRowDetail,
  retrieveRelevantDocumentContext,
  selectTableRowDetail,
  SlimDocumentStructureCache,
  type SlimDocumentStructure,
} from "./document-retrieval.js";
import { firstTurnContextProjection } from "./execution.js";

const structure: SlimDocumentStructure = {
  versionId: "v1",
  blocks: [
    { kind: "paragraph", handle: "b0", text: "Project Objective", styleName: "Heading 1", headingLevel: 1 },
    { kind: "paragraph", handle: "b1", text: "Deliver the launch plan with owners and dates." },
    { kind: "table", handle: "b2", tableHandle: "t0", rowCount: 14, columnCount: 3, headerTexts: ["Milestone", "Target", "Owner"] },
  ],
};

function bodyBlocks(blocks = structure.blocks) {
  return blocks.map((block) => block.kind === "paragraph"
    ? { handle: block.handle, kind: block.kind, text: block.text, styleName: block.styleName, headingLevel: block.headingLevel }
    : block.kind === "table"
      ? { handle: block.handle, kind: block.kind, tableHandle: block.tableHandle, rowCount: block.rowCount, columnCount: block.columnCount, headerTexts: block.headerTexts }
      : { handle: block.handle, kind: block.kind });
}

test("structure cache pages all blocks and isolates immutable versions", async () => {
  const blocks = Array.from({ length: 25 }, (_, index) => ({ kind: "paragraph" as const, handle: `b${index}`, text: `Paragraph ${index}` }));
  let calls = 0;
  const binding = {
    inspectDocx: async (_bytes: Uint8Array, request: { focus: { offset?: number; limit?: number } }) => {
      calls += 1;
      const offset = request.focus.offset ?? 0;
      const items = bodyBlocks(blocks.slice(offset, offset + 20));
      return { ok: true, diagnostics: [], bodyBlocks: { page: { total: blocks.length, offset, returned: items.length, hasMore: offset + items.length < blocks.length }, items } };
    },
  } as unknown as DocxEngineBinding;
  const cache = new SlimDocumentStructureCache();

  const first = await cache.get({ versionId: "v1", bytes: new Uint8Array(), binding });
  const second = await cache.get({ versionId: "v1", bytes: new Uint8Array(), binding });
  const next = await cache.get({ versionId: "v2", bytes: new Uint8Array(), binding });

  assert.equal(first.cache, "miss");
  assert.equal(first.structure.blocks.length, 25);
  assert.equal(second.cache, "hit");
  assert.equal(next.cache, "miss");
  assert.equal(calls, 4);
});

test("retrieval returns only high-confidence small structure", () => {
  const table = retrieveRelevantDocumentContext("Add a few milestones to the table.", structure);
  assert.equal(table?.reason, "single_table");
  assert.equal(table?.blocks[0]?.kind, "table");

  const heading = retrieveRelevantDocumentContext("Tell me the first heading.", structure);
  assert.equal(heading?.reason, "first_heading");
  assert.equal(heading?.blocks.length, 2);

  const paragraph = retrieveRelevantDocumentContext("What is the launch plan?", structure);
  assert.equal(paragraph?.reason, "paragraph_match");
  assert.equal(paragraph?.blocks.length, 1);

  assert.equal(retrieveRelevantDocumentContext("Make this look better.", structure), undefined);
  assert.equal(retrieveRelevantDocumentContext("Change Key HighStone to Key Milestones.", structure), undefined);
});

test("table detail is limited to recent rows for clear table continuations", () => {
  const context = retrieveRelevantDocumentContext("Add a few milestones to the table.", structure);
  assert.ok(context);
  assert.deepEqual(selectTableRowDetail("Add a few milestones to the table.", context!), { tableHandle: "t0", rowOffset: 11, rowLimit: 3 });
  assert.equal(selectTableRowDetail("How many rows are in the milestone table?", context!), undefined);
  assert.equal(selectTableRowDetail("Make the table better.", context!), undefined);
  assert.equal(selectTableRowDetail("Add more to the table.", context!), undefined);

  const detail = formatTableRowDetail({ tableHandle: "t0", rowCount: 14, columnCount: 3, headerTexts: ["Milestone"], rows: [{ index: 11, cells: ["x".repeat(161)] }] });
  assert.match(detail, /Relevant recent rows/);
  assert.ok(detail.length <= 2000);
  assert.match(detail, /…/);
});

test("retrieval bounds long text and never injects a whole document", () => {
  const long = "x".repeat(300);
  const many: SlimDocumentStructure = {
    versionId: "v-many",
    blocks: [{ kind: "paragraph", handle: "b0", text: "Launch plan " + long }, ...Array.from({ length: 20 }, (_, index) => ({ kind: "paragraph" as const, handle: `b${index + 1}`, text: "other content" }))],
  };
  const context = retrieveRelevantDocumentContext("Tell me about the launch plan", many);
  assert.ok(context);
  assert.ok(context!.blocks.length < many.blocks.length);
  assert.ok((context!.blocks[0] as { text: string }).text.length <= 240);
  assert.match(formatRetrievedDocumentContext(context!), /Relevant document structure/);
});

test("workspace ranking keeps primary and tagged artifacts visible", () => {
  const artifacts = [
    { documentId: "deck", versionId: "v1", name: "Board Deck.pptx", format: "pptx" },
    { documentId: "numbers", versionId: "v2", name: "Enterprise Numbers.xlsx", format: "xlsx" },
    { documentId: "notes", versionId: "v3", name: "Vacation Notes.docx", format: "docx" },
  ];
  const candidates = rankWorkspaceArtifacts({
    instruction: "Update enterprise numbers in the board deck",
    primaryDocumentId: "deck",
    taggedDocumentIds: ["numbers"],
    artifacts,
  });
  assert.deepEqual(new Set(candidates.map((candidate) => candidate.documentId)), new Set(["deck", "numbers"]));
  assert.equal(candidates.find((candidate) => candidate.documentId === "deck")?.reason, "name_match");
  assert.equal(candidates.find((candidate) => candidate.documentId === "numbers")?.versionId, "v2");
  assert.match(formatWorkspaceRetrievedContext(artifacts, candidates, [], "deck", ["numbers"]), /semantic inspection unavailable/);
});

test("workspace catalog remains separate from selected DOCX evidence", () => {
  const artifacts = [
    { documentId: "a", versionId: "v1", name: "A.docx", format: "docx" },
    { documentId: "b", versionId: "v2", name: "B.xlsx", format: "xlsx" },
    { documentId: "c", versionId: "v3", name: "C.pptx", format: "pptx" },
  ];
  const message = formatWorkspaceRetrievedContext(
    artifacts,
    [{ ...artifacts[0]!, reason: "primary" }],
    [{ artifact: artifacts[0]!, context: { blocks: [structure.blocks[0]!], reason: "heading_match" } }],
    "a",
    [],
  );
  assert.match(message, /WORKSPACE CATALOG\n3 documents/);
  assert.match(message, /A\.docx \(docx\) \[active\]/);
  assert.match(message, /B\.xlsx \(xlsx\)/);
  assert.match(message, /C\.pptx \(pptx\)/);
  assert.match(message, /RELEVANT ARTIFACTS\n- A\.docx/);
  assert.match(message, /Document: A\.docx/);
  assert.match(message, /Project Objective/);
  assert.equal((message.match(/Relevant document structure/g) ?? []).length, 1);
});

test("document map keeps headings and tables in source order with heading ancestry", () => {
  const map = buildDocumentMap(
    { documentId: "doc", versionId: "v1", name: "Board Report.docx", format: "docx" },
    { versionId: "v1", blocks: [
      { kind: "paragraph", handle: "h1", text: "Financial Results", headingLevel: 1 },
      { kind: "paragraph", handle: "h2", text: "Revenue", headingLevel: 2 },
      { kind: "table", handle: "t1", tableHandle: "table-1", rowCount: 12, columnCount: 4, headerTexts: ["Segment", "Revenue"] },
      { kind: "paragraph", handle: "h3", text: "Costs", headingLevel: 2 },
    ] },
  );
  assert.deepEqual(map.entries.map((entry) => entry.kind), ["heading", "heading", "table", "heading"]);
  assert.deepEqual(map.entries[2], { kind: "table", headingPath: ["Financial Results", "Revenue"], rowCount: 12, columnCount: 4, headerTexts: ["Segment", "Revenue"] });
  assert.match(formatDocumentMap(map), /## Revenue\n- Table under Financial Results > Revenue: 12 rows × 4 columns/);
});

test("map failures leave metadata context available", async () => {
  const retrieved = await retrieveWorkspaceContext({
    artifacts: [{ documentId: "doc", versionId: "v1", name: "Report.docx", format: "docx" }],
    instruction: "Review the report",
    primaryDocumentId: "doc",
    taggedDocumentIds: [],
    binding: { inspectDocx: async () => { throw new Error("engine unavailable"); } } as unknown as DocxEngineBinding,
    cache: new SlimDocumentStructureCache(),
    readBytes: async () => new Uint8Array(),
  });
  assert.equal(retrieved.documentMaps.length, 0);
  assert.equal(retrieved.evidence.length, 0);
  assert.match(retrieved.message ?? "", /WORKSPACE CATALOG/);
});

test("active and tagged documents form the request working set", async () => {
  const retrieved = await retrieveWorkspaceContext({
    artifacts: [
      { documentId: "active", versionId: "v1", name: "Plan.docx", format: "docx" },
      { documentId: "tagged", versionId: "v2", name: "Numbers.xlsx", format: "xlsx" },
    ],
    instruction: "Review the plan",
    primaryDocumentId: "active",
    taggedDocumentIds: ["tagged"],
    binding: { inspectDocx: async () => ({ ok: true, diagnostics: [], bodyBlocks: { page: { total: 0, offset: 0, returned: 0, hasMore: false }, items: [] } }) } as unknown as DocxEngineBinding,
    cache: new SlimDocumentStructureCache(),
    readBytes: async () => new Uint8Array(),
  });
  assert.deepEqual(retrieved.workingSet.map((artifact) => artifact.documentId), ["active", "tagged"]);
  assert.match(retrieved.message ?? "", /WORKING SET\n- Plan\.docx \(docx\)\n- Numbers\.xlsx \(xlsx\)/);
});

test("small single DOCX uses complete direct context, including every table row", async () => {
  const directStructure: SlimDocumentStructure = {
    versionId: "v-direct",
    blocks: [
      { kind: "paragraph", handle: "h1", text: "Project Objective", headingLevel: 1 },
      { kind: "paragraph", handle: "p1", text: "Ship the project." },
      { kind: "table", handle: "t1", tableHandle: "t1", rowCount: 12, columnCount: 2, headerTexts: ["Milestone", "Owner"] },
    ],
  };
  const rows = Array.from({ length: 12 }, (_, index) => ({ handle: `r${index}`, cells: [`Milestone ${index}`, `Owner ${index}`], cellHandles: [] }));
  const binding = {
    inspectDocx: async (_bytes: Uint8Array, request: { focus: { kind: string; offset?: number } }) => {
      if (request.focus.kind === "overview") {
        return { ok: true, diagnostics: [], overview: { bodyBlockCount: directStructure.blocks.length, paragraphCount: 2, tableCount: 1, sectionCount: 1 } };
      }
      if (request.focus.kind === "tables") {
        return { ok: true, diagnostics: [], tables: { page: { total: 1, offset: 0, returned: 1, hasMore: false }, items: [{ occurrence: 0, handle: "t1", rowCount: 12, isRectangular: true, columns: [], rows }] } };
      }
      return { ok: true, diagnostics: [], bodyBlocks: { page: { total: directStructure.blocks.length, offset: 0, returned: directStructure.blocks.length, hasMore: false }, items: bodyBlocks(directStructure.blocks) } };
    },
  } as unknown as DocxEngineBinding;
  const retrieved = await retrieveWorkspaceContext({
    artifacts: [{ documentId: "doc", versionId: "v-direct", name: "Plan.docx", format: "docx" }],
    instruction: "What can you tell me about this document?",
    primaryDocumentId: "doc",
    taggedDocumentIds: [],
    binding,
    cache: new SlimDocumentStructureCache(),
    availableEvidenceTokens: 100_000,
    readBytes: async () => new Uint8Array(),
  });
  assert.equal(retrieved.contextStrategy, "direct");
  assert.equal(retrieved.plannerEvidenceBudgetTokens, 24_000);
  assert.match(retrieved.message ?? "", /COMPLETE WORKING DOCUMENT CONTENT/);
  assert.match(retrieved.message ?? "", /Milestone 11/);
  assert.doesNotMatch(retrieved.message ?? "", /DOCUMENT MAPS/);
});

test("direct context remains bounded under a huge physical budget and multi-document working set", async () => {
  const huge: SlimDocumentStructure = {
    versionId: "v-huge",
    blocks: [{ kind: "paragraph", handle: "p", text: "x".repeat(30_000) }],
  };
  const binding = {
    inspectDocx: async (_bytes: Uint8Array, request: { focus: { kind: string } }) => request.focus.kind === "overview"
      ? { ok: true, diagnostics: [], overview: { bodyBlockCount: 1, paragraphCount: 1, tableCount: 0, sectionCount: 1 } }
      : { ok: true, diagnostics: [], bodyBlocks: { page: { total: 1, offset: 0, returned: 1, hasMore: false }, items: bodyBlocks(huge.blocks) } },
  } as unknown as DocxEngineBinding;
  const retrieved = await retrieveWorkspaceContext({
    artifacts: [{ documentId: "doc", versionId: "v-huge", name: "Huge.docx", format: "docx" }],
    instruction: "Review this document",
    primaryDocumentId: "doc",
    taggedDocumentIds: [],
    binding,
    cache: new SlimDocumentStructureCache(),
    availableEvidenceTokens: 1_000_000,
    readBytes: async () => new Uint8Array(),
  });
  assert.equal(retrieved.contextStrategy, "hierarchical");
  assert.ok(retrieved.fullDocumentEstimatedTokens! > 8_000);
});

function tinyDocumentBinding(): DocxEngineBinding {
  return {
    inspectDocx: async (_bytes: Uint8Array, request: { focus: { kind: string } }) => request.focus.kind === "overview"
      ? { ok: true, diagnostics: [], overview: { bodyBlockCount: 1, paragraphCount: 1, tableCount: 0, sectionCount: 1 } }
      : { ok: true, diagnostics: [], bodyBlocks: { page: { total: 1, offset: 0, returned: 1, hasMore: false }, items: bodyBlocks([{ kind: "paragraph", handle: "p", text: "Tiny document." }]) } },
  } as unknown as DocxEngineBinding;
}

test("ten tiny working documents use one shared direct budget", async () => {
  const artifacts = Array.from({ length: 10 }, (_, index) => ({ documentId: `doc-${index}`, versionId: `v-${index}`, name: `Tiny ${index}.docx`, format: "docx" }));
  const retrieved = await retrieveWorkspaceContext({
    artifacts,
    instruction: "What can you tell me about these documents?",
    primaryDocumentId: "doc-0",
    taggedDocumentIds: artifacts.slice(1).map((artifact) => artifact.documentId),
    workingSetDocumentIds: artifacts.map((artifact) => artifact.documentId),
    binding: tinyDocumentBinding(),
    cache: new SlimDocumentStructureCache(),
    availableEvidenceTokens: 100_000,
    readBytes: async () => new Uint8Array(),
  });
  assert.equal(retrieved.contextStrategy, "direct");
  assert.ok(retrieved.fullDocumentEstimatedTokens! < 12_000);
  assert.match(retrieved.message ?? "", /=== Document: Tiny 0\.docx ===/);
  assert.match(retrieved.message ?? "", /=== Document: Tiny 9\.docx ===/);
  assert.match(retrieved.message ?? "", /bound to the active artifact only/);
});

test("combined direct content falls back when two documents exceed the shared limit", async () => {
  const artifacts = [0, 1].map((index) => ({ documentId: `doc-${index}`, versionId: `v-${index}`, name: `Large ${index}.docx`, format: "docx" }));
  const binding = {
    inspectDocx: async (_bytes: Uint8Array, request: { focus: { kind: string } }) => request.focus.kind === "overview"
      ? { ok: true, diagnostics: [], overview: { bodyBlockCount: 1, paragraphCount: 1, tableCount: 0, sectionCount: 1 } }
      : { ok: true, diagnostics: [], bodyBlocks: { page: { total: 1, offset: 0, returned: 1, hasMore: false }, items: bodyBlocks([{ kind: "paragraph", handle: "p", text: "x".repeat(30_000) }]) } },
  } as unknown as DocxEngineBinding;
  const retrieved = await retrieveWorkspaceContext({
    artifacts,
    instruction: "Review these documents",
    primaryDocumentId: "doc-0",
    taggedDocumentIds: ["doc-1"],
    workingSetDocumentIds: artifacts.map((artifact) => artifact.documentId),
    binding,
    cache: new SlimDocumentStructureCache(),
    availableEvidenceTokens: 100_000,
    readBytes: async () => new Uint8Array(),
  });
  assert.notEqual(retrieved.contextStrategy, "direct");
  assert.ok(retrieved.fullDocumentEstimatedTokens! > 12_000);
});

test("many documents just over the shared limit fall back", async () => {
  const artifacts = Array.from({ length: 4 }, (_, index) => ({ documentId: `doc-${index}`, versionId: `v-${index}`, name: `Near ${index}.docx`, format: "docx" }));
  const binding = {
    inspectDocx: async (_bytes: Uint8Array, request: { focus: { kind: string } }) => request.focus.kind === "overview"
      ? { ok: true, diagnostics: [], overview: { bodyBlockCount: 1, paragraphCount: 1, tableCount: 0, sectionCount: 1 } }
      : { ok: true, diagnostics: [], bodyBlocks: { page: { total: 1, offset: 0, returned: 1, hasMore: false }, items: bodyBlocks([{ kind: "paragraph", handle: "p", text: "x".repeat(13_000) }]) } },
  } as unknown as DocxEngineBinding;
  const retrieved = await retrieveWorkspaceContext({
    artifacts,
    instruction: "Review these documents",
    primaryDocumentId: "doc-0",
    taggedDocumentIds: artifacts.slice(1).map((artifact) => artifact.documentId),
    workingSetDocumentIds: artifacts.map((artifact) => artifact.documentId),
    binding,
    cache: new SlimDocumentStructureCache(),
    availableEvidenceTokens: 100_000,
    readBytes: async () => new Uint8Array(),
  });
  assert.notEqual(retrieved.contextStrategy, "direct");
  assert.ok(retrieved.fullDocumentEstimatedTokens! > 12_000);
});

test("mixed or incomplete working documents fall back from direct context", async () => {
  const artifacts = [
    { documentId: "doc", versionId: "v-doc", name: "Complete.docx", format: "docx" },
    { documentId: "sheet", versionId: "v-sheet", name: "Source.xlsx", format: "xlsx" },
  ];
  const mixed = await retrieveWorkspaceContext({
    artifacts,
    instruction: "Review these documents",
    primaryDocumentId: "doc",
    taggedDocumentIds: ["sheet"],
    workingSetDocumentIds: artifacts.map((artifact) => artifact.documentId),
    binding: tinyDocumentBinding(),
    cache: new SlimDocumentStructureCache(),
    availableEvidenceTokens: 100_000,
    readBytes: async () => new Uint8Array(),
  });
  assert.notEqual(mixed.contextStrategy, "direct");

  const incomplete = await retrieveWorkspaceContext({
    artifacts: artifacts.slice(0, 1),
    instruction: "Review this document",
    primaryDocumentId: "doc",
    taggedDocumentIds: [],
    binding: {
      inspectDocx: async (_bytes: Uint8Array, request: { focus: { kind: string } }) => request.focus.kind === "overview"
        ? { ok: true, diagnostics: [], overview: { bodyBlockCount: 1, paragraphCount: 2, tableCount: 0, sectionCount: 1 } }
        : { ok: true, diagnostics: [], bodyBlocks: { page: { total: 1, offset: 0, returned: 1, hasMore: false }, items: bodyBlocks([{ kind: "paragraph", handle: "p", text: "Partial" }]) } },
    } as unknown as DocxEngineBinding,
    cache: new SlimDocumentStructureCache(),
    availableEvidenceTokens: 100_000,
    readBytes: async () => new Uint8Array(),
  });
  assert.notEqual(incomplete.contextStrategy, "direct");
});

test("direct context falls back when body blocks omit paragraphs", async () => {
  const binding = {
    inspectDocx: async (_bytes: Uint8Array, request: { focus: { kind: string } }) => request.focus.kind === "overview"
      ? { ok: true, diagnostics: [], overview: { bodyBlockCount: 1, paragraphCount: 2, tableCount: 0, sectionCount: 1 } }
      : { ok: true, diagnostics: [], bodyBlocks: { page: { total: 1, offset: 0, returned: 1, hasMore: false }, items: bodyBlocks([{ kind: "paragraph", handle: "p1", text: "Visible body paragraph" }]) } },
  } as unknown as DocxEngineBinding;
  const retrieved = await retrieveWorkspaceContext({
    artifacts: [{ documentId: "doc", versionId: "v1", name: "Wrapped.docx", format: "docx" }],
    instruction: "What can you tell me about this document?",
    primaryDocumentId: "doc",
    taggedDocumentIds: [],
    binding,
    cache: new SlimDocumentStructureCache(),
    availableEvidenceTokens: 100_000,
    readBytes: async () => new Uint8Array(),
  });
  assert.equal(retrieved.contextStrategy, "hierarchical");
  assert.doesNotMatch(retrieved.message ?? "", /COMPLETE ACTIVE DOCUMENT CONTENT/);
});

test("workspace catalog is clean when empty and bounded when large", () => {
  assert.match(formatWorkspaceRetrievedContext([], [], [], null, []), /WORKSPACE CATALOG\n0 documents/);
  const single = [{ documentId: "doc", versionId: "v1", name: "Only.docx", format: "docx" }];
  assert.match(formatWorkspaceRetrievedContext(single, [{ ...single[0]!, reason: "primary" }], [], "doc", []), /1 documents\n- Only\.docx \(docx\) \[active\]/);
  const artifacts = Array.from({ length: 11 }, (_, index) => ({ documentId: `doc-${index}`, versionId: `v${index}`, name: `Document ${index}.docx`, format: "docx" }));
  const message = formatWorkspaceRetrievedContext(artifacts, [{ ...artifacts[0]!, reason: "primary" }], [], "doc-0", []);
  assert.match(message, /11 documents/);
  assert.match(message, /1 additional documents omitted/);
  assert.doesNotMatch(message, /Document 9\.docx/);
});

test("workspace retrieval reads only selected DOCX versions and falls back without evidence", async () => {
  const readVersions: string[] = [];
  const binding = {
    inspectDocx: async (_bytes: Uint8Array, request: { focus: { kind: string; offset?: number } }) => {
      assert.equal(request.focus.kind, "body_blocks");
      return { ok: true, diagnostics: [], bodyBlocks: { page: { total: 1, offset: 0, returned: 1, hasMore: false }, items: bodyBlocks([structure.blocks[1]!]) } };
    },
  } as unknown as DocxEngineBinding;
  const retrieved = await retrieveWorkspaceContext({
    artifacts: [
      { documentId: "doc", versionId: "v-exact", name: "Launch Plan.docx", format: "docx" },
      { documentId: "other", versionId: "v-other", name: "Vacation Notes.docx", format: "docx" },
    ],
    instruction: "Tell me about the launch plan",
    primaryDocumentId: "doc",
    taggedDocumentIds: [],
    binding,
    cache: new SlimDocumentStructureCache(),
    readBytes: async (artifact) => {
      readVersions.push(artifact.versionId);
      return new Uint8Array();
    },
  });
  assert.deepEqual(readVersions, ["v-exact"]);
  assert.equal(retrieved.evidence[0]?.artifact.versionId, "v-exact");
  assert.match(retrieved.message ?? "", /Version: v-exact/);
  assert.match(retrieved.message ?? "", /Vacation Notes\.docx \(docx\)/);
});

test("first-turn projection places retrieval context before the latest user instruction", () => {
  const context = "Relevant document structure:\n- Table t0";
  const project = firstTurnContextProjection(context);
  const messages = [
    { role: "user" as const, content: "Earlier request" },
    { role: "assistant" as const, content: "Earlier answer" },
    { role: "user" as const, content: "Add milestones" },
  ];
  assert.deepEqual(project(messages), [
    messages[0],
    messages[1],
    { role: "user", content: context },
    messages[2],
  ]);
  assert.deepEqual(project(messages), messages);
});
