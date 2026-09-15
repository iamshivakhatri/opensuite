import assert from "node:assert/strict";
import { test } from "node:test";

import { asSchema } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import { createDocumentTools, type BoundDocumentReads } from "./document-tools.js";
import { runAgent } from "./model.js";

const emptyUsage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
} as const;

function textFinish(text: string) {
  return [
    { type: "stream-start" as const, warnings: [] },
    { type: "text-start" as const, id: "text" },
    { type: "text-delta" as const, id: "text", delta: text },
    { type: "text-end" as const, id: "text" },
    {
      type: "finish" as const,
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: emptyUsage,
    },
  ];
}

function toolCallChunks(
  calls: ReadonlyArray<{ id: string; name: string; input: unknown }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] {
  return [
    { type: "stream-start", warnings: [] },
    ...calls.flatMap((call) => [
      { type: "tool-input-start", id: call.id, toolName: call.name },
      {
        type: "tool-input-delta",
        id: call.id,
        delta: JSON.stringify(call.input),
      },
      { type: "tool-input-end", id: call.id },
      {
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.name,
        input: JSON.stringify(call.input),
      },
    ]),
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      usage: emptyUsage,
    },
  ];
}

function fakeDocument(): BoundDocumentReads & {
  calls: string[];
  lastInspect: unknown;
  lastFind: unknown;
} {
  const state = {
    calls: [] as string[],
    lastInspect: undefined as unknown,
    lastFind: undefined as unknown,
    capabilities() {
      state.calls.push("capabilities");
      return {
        ok: true,
        protocolVersion: 1,
        engineVersion: "test",
        formats: [{ format: "docx", capabilities: ["inspect", "find"] }],
      };
    },
    async inspect(request: { focus: unknown }) {
      state.calls.push("inspect");
      state.lastInspect = request;
      return { ok: true, focus: "overview", overview: { paragraphCount: 2 } };
    },
    async find(request: { text: string }) {
      state.calls.push("find");
      state.lastFind = request;
      return { ok: true, query: request.text, matchCount: 1, matches: [] };
    },
  };
  return state;
}

test("document tools expose capabilities/inspect/find without document IDs", async () => {
  const doc = fakeDocument();
  const tools = createDocumentTools(doc);

  assert.deepEqual(Object.keys(tools).sort(), [
    "document.capabilities",
    "document.find",
    "document.inspect",
  ]);

  for (const name of Object.keys(tools)) {
    const schema = await asSchema(tools[name]!.inputSchema).jsonSchema;
    const schemaText = JSON.stringify(schema);
    assert.equal(schemaText.includes("documentId"), false);
    assert.equal(schemaText.includes("versionId"), false);
    assert.equal(schemaText.includes("workspaceId"), false);
  }

  const caps = await tools["document.capabilities"]!.execute!(
    {},
    { toolCallId: "1", messages: [], context: {} },
  );
  assert.equal((caps as { ok: boolean }).ok, true);

  await tools["document.inspect"]!.execute!(
    { kind: "overview" },
    { toolCallId: "2", messages: [], context: {} },
  );
  assert.deepEqual(doc.lastInspect, { focus: { kind: "overview" } });

  await tools["document.find"]!.execute!(
    { text: "hello" },
    { toolCallId: "3", messages: [], context: {} },
  );
  assert.deepEqual(doc.lastFind, { text: "hello" });
});

test("inspect + find in one model turn both run before next turn", async () => {
  const doc = fakeDocument();
  const tools = createDocumentTools(doc);
  let invocations = 0;

  const model = new MockLanguageModelV4({
    doStream: async () => {
      invocations += 1;
      if (invocations === 1) {
        return {
          stream: simulateReadableStream({
            chunks: toolCallChunks([
              {
                id: "i1",
                name: "document.inspect",
                input: { kind: "overview" },
              },
              { id: "f1", name: "document.find", input: { text: "x" } },
            ]),
          }),
        };
      }
      assert.deepEqual(doc.calls, ["inspect", "find"]);
      return {
        stream: simulateReadableStream({ chunks: textFinish("done") }),
      };
    },
  });

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "look" }],
    tools,
  });

  assert.equal(invocations, 2);
  assert.equal(result.turns, 2);
  assert.equal(result.text, "done");
});
