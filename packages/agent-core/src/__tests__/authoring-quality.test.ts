/**
 * Deterministic authoring-quality checks: generic guidance + scripted plans
 * across materially different document shapes (not genre-specific product logic).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AgentRunner,
  DOCUMENT_TOOL_NAMES,
  ToolRegistry,
  buildDocumentAgentSystemPrompt,
  createDocumentAgentRunnerOptions,
  createFakeTool,
  createInMemoryDocumentMutationExecutor,
  createScriptedAgentModel,
  listDocumentToolDescriptors,
  mutableDocumentCapabilities,
  toolCallResponse,
  type DocumentRuntime,
} from "../index.js";

function createGreenfieldRuntime(): DocumentRuntime {
  return {
    async capabilities() {
      return mutableDocumentCapabilities();
    },
    async inspect() {
      throw new Error("must not ritual-inspect during greenfield authoring");
    },
    async find() {
      throw new Error("must not find during greenfield authoring");
    },
    async execute() {
      return {
        status: "success",
        diagnostics: [],
        artifactBytes: new Uint8Array([1]),
      };
    },
  };
}

function createBlankTool() {
  return createFakeTool({
    name: "workspace.create_blank_docx",
    effect: "write",
    executionMode: "sequential",
    execute: async (_input, ctx) => {
      const document = {
        documentId: "new-doc",
        versionId: "v1",
        format: "docx" as const,
      };
      ctx.advancePrimaryDocument?.(document);
      return {
        document: { ...document, name: "Authored.docx", versionNumber: 1 },
      };
    },
  });
}

function assertAuthoringQuality(
  toolNames: readonly string[],
  texts: readonly string[],
) {
  assert.ok(
    !toolNames.includes(DOCUMENT_TOOL_NAMES.inspect),
    "author-first: no ritual inspect",
  );
  assert.ok(
    toolNames.includes(DOCUMENT_TOOL_NAMES.insertParagraphs) ||
      toolNames.includes(DOCUMENT_TOOL_NAMES.insertParagraph),
    "expected structural insert",
  );
  assert.ok(
    toolNames.includes(DOCUMENT_TOOL_NAMES.setParagraphStyle),
    "expected hierarchy via paragraph styles",
  );
  const formatCalls = toolNames.filter(
    (n) =>
      n === DOCUMENT_TOOL_NAMES.setParagraphFormatting ||
      n === DOCUMENT_TOOL_NAMES.setTextFormatting ||
      n === DOCUMENT_TOOL_NAMES.setParagraphStyle ||
      n === DOCUMENT_TOOL_NAMES.setParagraphsList,
  ).length;
  assert.ok(formatCalls <= 12, `too many formatting calls: ${formatCalls}`);
  for (const text of texts) {
    assert.doesNotMatch(
      text,
      /^-{3,}$|^\s*\/\s*$|^\s*\|\s*$/,
      `fake textual layout separator: ${JSON.stringify(text)}`,
    );
  }
}

async function runScriptedAuthoring(plan: {
  readonly runId: string;
  readonly instruction: string;
  readonly createName: string;
  readonly tools: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: Record<string, unknown>;
  }[];
  readonly done: string;
  readonly texts: readonly string[];
}) {
  const runtime = createGreenfieldRuntime();
  const runner = new AgentRunner({
    model: createScriptedAgentModel([
      toolCallResponse("", [
        {
          id: "c1",
          name: "workspace.create_blank_docx",
          input: { name: plan.createName },
        },
      ]),
      toolCallResponse(plan.done, plan.tools),
    ]),
    ...createDocumentAgentRunnerOptions({
      tools: ToolRegistry.create([createBlankTool()]),
      documentToolCatalog: listDocumentToolDescriptors(),
      runtime,
      mutations: createInMemoryDocumentMutationExecutor(runtime),
    }),
  });
  const result = await runner.run({
    runId: plan.runId,
    threadId: "authoring-thread",
    instruction: plan.instruction,
  });
  assert.equal(result.status, "completed");
  const toolNames = result.toolOutcomes.map((o) => o.toolName);
  assertAuthoringQuality(toolNames, plan.texts);
  assert.equal(
    result.toolOutcomes.filter((o) => o.status !== "succeeded").length,
    0,
  );
  return toolNames;
}

test("tool descriptions teach semantic units and spacing semantics", () => {
  const tools = Object.fromEntries(
    listDocumentToolDescriptors().map((t) => [t.name, t]),
  );
  assert.match(
    tools[DOCUMENT_TOOL_NAMES.insertParagraphs]!.description,
    /semantic units/i,
  );
  assert.match(
    tools[DOCUMENT_TOOL_NAMES.insertParagraphs]!.description,
    /no embedded newline/i,
  );
  assert.match(
    tools[DOCUMENT_TOOL_NAMES.insertParagraphs]!.description,
    /multiple entries/i,
  );
  assert.match(
    tools[DOCUMENT_TOOL_NAMES.insertParagraphs]!.description,
    /punctuation layout|layout hacks/i,
  );
  assert.match(
    tools[DOCUMENT_TOOL_NAMES.setParagraphFormatting]!.description,
    /group|spacing/i,
  );
  assert.match(
    tools[DOCUMENT_TOOL_NAMES.setParagraphFormatting]!.description,
    /240≈12pt|twips/i,
  );
  assert.match(
    tools[DOCUMENT_TOOL_NAMES.createTable]!.description,
    /semantically tabular/i,
  );
  assert.match(
    tools[DOCUMENT_TOOL_NAMES.setParagraphsList]!.description,
    /genuine itemization|enumeration|steps/i,
  );
  assert.match(
    tools[DOCUMENT_TOOL_NAMES.setParagraphsList]!.description,
    /not to group|grouping hack/i,
  );
  assert.match(
    tools[DOCUMENT_TOOL_NAMES.setParagraphStyle]!.description,
    /hierarchy/i,
  );
});

test("authoring guidance distinguishes true lists from related short-form grouping", () => {
  const prompt = buildDocumentAgentSystemPrompt(mutableDocumentCapabilities());
  const listTool = listDocumentToolDescriptors().find(
    (t) => t.name === DOCUMENT_TOOL_NAMES.setParagraphsList,
  );
  assert.ok(listTool);

  // True list content → list is appropriate
  assert.match(prompt, /Bullet\/numbered lists only for genuine itemization/i);
  assert.match(prompt, /enumeration, or steps/i);
  assert.match(listTool!.description, /genuine itemization|enumeration|steps/i);

  // Related short-form → list is not the default grouping choice
  assert.match(prompt, /never as a grouping hack/i);
  assert.match(
    prompt,
    /related short lines, quotations, metadata, or compact prose/i,
  );
  assert.match(
    prompt,
    /paragraphs \+ spacing\/style\/alignment instead/i,
  );
  assert.match(listTool!.description, /not to group related short lines/i);
  assert.match(prompt, /meaning first, appearance second/i);

  // Still genre-agnostic
  assert.doesNotMatch(prompt, /\bpoem\b/i);
  assert.doesNotMatch(listTool!.description, /\bpoem\b/i);
});

test("authoring guidance is genre-agnostic", () => {
  const prompt = buildDocumentAgentSystemPrompt(mutableDocumentCapabilities());
  assert.match(prompt, /AUTHORING:/);
  assert.doesNotMatch(prompt, /\bpoem\b|\bresume\b|\bmemo template\b/i);
  assert.doesNotMatch(prompt, /if \(.*contentType|genre ===/i);
});

test("scripted short creative document: hierarchy + grouping, no inspect loop", async () => {
  const texts = [
    "Evening Notes",
    "Harbor Light",
    "A short line.",
    "Another short line.",
    "Window Rain",
    "Soft drumming.",
    "Closing thought.",
  ];
  const toolNames = await runScriptedAuthoring({
    runId: "authoring-creative",
    instruction:
      "Create a short document with a title and two titled pieces of a few related lines each.",
    createName: "Evening Notes.docx",
    done: "Done — evening notes are ready.",
    texts,
    tools: [
      {
        id: "body",
        name: DOCUMENT_TOOL_NAMES.insertParagraphs,
        input: { texts, placement: { kind: "end" } },
      },
      {
        id: "title",
        name: DOCUMENT_TOOL_NAMES.setParagraphStyle,
        input: { target: { text: "Evening Notes" }, style: "Heading 1" },
      },
      {
        id: "h-a",
        name: DOCUMENT_TOOL_NAMES.setParagraphStyle,
        input: { target: { text: "Harbor Light" }, style: "Heading 2" },
      },
      {
        id: "h-b",
        name: DOCUMENT_TOOL_NAMES.setParagraphStyle,
        input: { target: { text: "Window Rain" }, style: "Heading 2" },
      },
      {
        id: "space-a",
        name: DOCUMENT_TOOL_NAMES.setParagraphFormatting,
        input: { target: { text: "A short line." }, spacingAfterTwips: 60 },
      },
      {
        id: "space-b",
        name: DOCUMENT_TOOL_NAMES.setParagraphFormatting,
        input: { target: { text: "Soft drumming." }, spacingAfterTwips: 60 },
      },
    ],
  });
  assert.ok(toolNames.includes(DOCUMENT_TOOL_NAMES.setParagraphFormatting));
  assert.ok(
    !toolNames.includes(DOCUMENT_TOOL_NAMES.setParagraphsList),
    "related short lines must not default to list grouping",
  );
  assert.ok(!toolNames.includes(DOCUMENT_TOOL_NAMES.createTable));
});

test("scripted professional memo: hierarchy without table layout", async () => {
  const texts = [
    "Weekly Status Memo",
    "To: Product Team",
    "From: OpenSuite Agent",
    "Subject: Sprint progress",
    "We closed the inspect targeting work and batched safe formatting mutations.",
    "Next week focuses on authoring quality and visual validation.",
    "Please reply with blockers by Thursday.",
  ];
  const toolNames = await runScriptedAuthoring({
    runId: "authoring-memo",
    instruction:
      "Create a short business memo with title, To/From/Subject lines, and two body paragraphs.",
    createName: "Weekly Status Memo.docx",
    done: "Done — memo drafted.",
    texts,
    tools: [
      {
        id: "body",
        name: DOCUMENT_TOOL_NAMES.insertParagraphs,
        input: { texts, placement: { kind: "end" } },
      },
      {
        id: "title",
        name: DOCUMENT_TOOL_NAMES.setParagraphStyle,
        input: { target: { text: "Weekly Status Memo" }, style: "Heading 1" },
      },
      {
        id: "meta-space",
        name: DOCUMENT_TOOL_NAMES.setParagraphFormatting,
        input: {
          target: { text: "Subject: Sprint progress" },
          spacingAfterTwips: 200,
        },
      },
    ],
  });
  assert.ok(!toolNames.includes(DOCUMENT_TOOL_NAMES.createTable));
});

test("scripted hierarchical guide: headings + list, no fake separators", async () => {
  const texts = [
    "Onboarding Guide",
    "Overview",
    "This guide covers account setup and first document creation.",
    "Setup steps",
    "Create a workspace",
    "Invite teammates",
    "Open Casual Docs",
    "Tips",
    "Prefer structured authoring over decorative formatting.",
  ];
  const toolNames = await runScriptedAuthoring({
    runId: "authoring-guide",
    instruction:
      "Create an onboarding guide with a title, Overview, Setup steps as a short bullet list, and Tips.",
    createName: "Onboarding Guide.docx",
    done: "Done — onboarding guide is ready.",
    texts,
    tools: [
      {
        id: "body",
        name: DOCUMENT_TOOL_NAMES.insertParagraphs,
        input: { texts, placement: { kind: "end" } },
      },
      {
        id: "title",
        name: DOCUMENT_TOOL_NAMES.setParagraphStyle,
        input: { target: { text: "Onboarding Guide" }, style: "Heading 1" },
      },
      {
        id: "h1",
        name: DOCUMENT_TOOL_NAMES.setParagraphStyle,
        input: { target: { text: "Overview" }, style: "Heading 2" },
      },
      {
        id: "h2",
        name: DOCUMENT_TOOL_NAMES.setParagraphStyle,
        input: { target: { text: "Setup steps" }, style: "Heading 2" },
      },
      {
        id: "h3",
        name: DOCUMENT_TOOL_NAMES.setParagraphStyle,
        input: { target: { text: "Tips" }, style: "Heading 2" },
      },
      {
        id: "list",
        name: DOCUMENT_TOOL_NAMES.setParagraphsList,
        input: {
          targets: [
            { text: "Create a workspace" },
            { text: "Invite teammates" },
            { text: "Open Casual Docs" },
          ],
          kind: "bullet",
          level: 0,
        },
      },
    ],
  });
  assert.ok(toolNames.includes(DOCUMENT_TOOL_NAMES.setParagraphsList));
  assert.ok(!toolNames.includes(DOCUMENT_TOOL_NAMES.createTable));
});
