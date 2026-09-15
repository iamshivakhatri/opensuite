import assert from "node:assert/strict";
import { test } from "node:test";

import { asSchema } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import {
  createDocumentTools,
  HIDDEN_BINARY_MUTATION_CAPABILITIES,
  MODEL_MUTATION_CAPABILITIES,
  type BoundDocumentHost,
} from "./document-tools.js";
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

function fakeDocument(options?: {
  readonly caps?: readonly string[];
  readonly withMutate?: boolean;
}): BoundDocumentHost & {
  calls: string[];
  states: string[];
  lastInspect: unknown;
  lastFind: unknown;
  mutateOps: Array<{ capability: string; operation: unknown }>;
  failNextMutate?: boolean;
} {
  let state = "v0";
  const state_obj = {
    calls: [] as string[],
    states: [] as string[],
    lastInspect: undefined as unknown,
    lastFind: undefined as unknown,
    mutateOps: [] as Array<{ capability: string; operation: unknown }>,
    failNextMutate: false,
    capabilities() {
      // Called at tool-build time for gating — not part of run call history.
      return {
        ok: true,
        protocolVersion: 1,
        engineVersion: "test",
        formats: [
          {
            format: "docx",
            capabilities: options?.caps ?? [
              "inspect",
              "find_text",
              "replace_text",
              "insert_paragraph",
              "set_text_formatting",
            ],
          },
        ],
      };
    },
    async inspect(request: { focus: unknown }) {
      state_obj.calls.push("inspect");
      state_obj.states.push(state);
      state_obj.lastInspect = request;
      return { ok: true, focus: "overview", overview: { paragraphCount: 2 }, state };
    },
    async find(request: { text: string }) {
      state_obj.calls.push("find");
      state_obj.states.push(state);
      state_obj.lastFind = request;
      return { ok: true, query: request.text, matchCount: 1, matches: [], state };
    },
    ...(options?.withMutate === false
      ? {}
      : {
          async mutate(capability: string, operation: Record<string, unknown>) {
            state_obj.calls.push(`mutate:${capability}`);
            state_obj.mutateOps.push({ capability, operation });
            if (state_obj.failNextMutate) {
              state_obj.failNextMutate = false;
              return {
                ok: false,
                capability,
                status: "error",
                reasonCode: "EXPECTED_TEXT_MISMATCH",
                diagnostics: [
                  {
                    code: "EXPECTED_TEXT_MISMATCH",
                    severity: "error",
                    message: "expected text mismatch",
                    reasonCode: "EXPECTED_TEXT_MISMATCH",
                  },
                ],
              };
            }
            const before = state;
            state = `${before}->${capability}`;
            state_obj.states.push(state);
            return {
              ok: true,
              capability,
              status: "success",
              diagnostics: [],
              changes: [],
              versionId: state,
              stateFrom: before,
            };
          },
        }),
  };
  return state_obj;
}

test("document tools expose reads + gated mutations without document IDs", async () => {
  const doc = fakeDocument();
  const tools = createDocumentTools(doc);

  assert.deepEqual(Object.keys(tools).sort(), [
    "document.capabilities",
    "document.find",
    "document.insert_paragraph",
    "document.inspect",
    "document.replace_text",
    "document.set_text_formatting",
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

test("mutations are omitted when host has no mutate or engine omits caps", async () => {
  const noMutate = fakeDocument({ withMutate: false });
  assert.deepEqual(Object.keys(createDocumentTools(noMutate)).sort(), [
    "document.capabilities",
    "document.find",
    "document.inspect",
  ]);

  const readOnlyCaps = fakeDocument({
    caps: ["inspect", "find_text"],
    withMutate: true,
  });
  assert.deepEqual(Object.keys(createDocumentTools(readOnlyCaps)).sort(), [
    "document.capabilities",
    "document.find",
    "document.inspect",
  ]);
});

test("every exposed mutation tool has execute and a closed schema", async () => {
  const doc = fakeDocument({
    caps: ["inspect", "find_text", ...MODEL_MUTATION_CAPABILITIES],
  });
  const tools = createDocumentTools(doc);
  const mutationTools = Object.keys(tools).filter(
    (name) =>
      name.startsWith("document.") &&
      name !== "document.capabilities" &&
      name !== "document.inspect" &&
      name !== "document.find",
  );

  assert.equal(mutationTools.length, MODEL_MUTATION_CAPABILITIES.length);

  for (const name of mutationTools) {
    const capability = name.slice("document.".length);
    assert.ok(
      (MODEL_MUTATION_CAPABILITIES as readonly string[]).includes(capability),
      `${name} is exposed without a model contract`,
    );
    assert.equal(typeof tools[name]!.execute, "function");
    const schema = await asSchema(tools[name]!.inputSchema).jsonSchema;
    assert.equal(
      schema.additionalProperties,
      false,
      `${name} must not use additionalProperties: true`,
    );
    const schemaText = JSON.stringify(schema);
    if (schemaText.includes("occurrence")) {
      assert.match(
        schemaText,
        /[Zz]ero-based/,
        `${name} occurrence field must document zero-based semantics`,
      );
    }
  }

  for (const hidden of HIDDEN_BINARY_MUTATION_CAPABILITIES) {
    assert.equal(tools[`document.${hidden}`], undefined);
  }
});

test("inspect + find in one model turn both run before next turn", async () => {
  const doc = fakeDocument({ withMutate: false });
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

test("multi-mutation siblings evolve state sequentially with exactly two model turns", async () => {
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
                id: "a",
                name: "document.replace_text",
                input: {
                  target: { text: "A" },
                  expectedCurrentText: "A",
                  replacement: "B",
                },
              },
              {
                id: "b",
                name: "document.insert_paragraph",
                input: { text: "P", placement: { kind: "end" } },
              },
              {
                id: "c",
                name: "document.set_text_formatting",
                input: { target: { text: "B" }, bold: true },
              },
            ]),
          }),
        };
      }
      assert.equal(invocations, 2);
      assert.deepEqual(doc.calls, [
        "mutate:replace_text",
        "mutate:insert_paragraph",
        "mutate:set_text_formatting",
      ]);
      assert.deepEqual(doc.states, [
        "v0->replace_text",
        "v0->replace_text->insert_paragraph",
        "v0->replace_text->insert_paragraph->set_text_formatting",
      ]);
      return {
        stream: simulateReadableStream({ chunks: textFinish("edited") }),
      };
    },
  });

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "edit three" }],
    tools,
    runId: "test-multi",
  });

  assert.equal(invocations, 2);
  assert.equal(result.turns, 2);
  assert.equal(result.toolCalls, 3);
  assert.equal(result.text, "edited");
});

test("mutation failure returns diagnostic, skips later writes, no hidden model turn", async () => {
  const doc = fakeDocument();
  doc.failNextMutate = true;
  const tools = createDocumentTools(doc);
  let invocations = 0;
  let sawFailurePayload = false;

  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      invocations += 1;
      if (invocations === 1) {
        return {
          stream: simulateReadableStream({
            chunks: toolCallChunks([
              {
                id: "bad",
                name: "document.replace_text",
                input: {
                  target: { text: "x" },
                  expectedCurrentText: "x",
                  replacement: "y",
                },
              },
              {
                id: "skip",
                name: "document.insert_paragraph",
                input: { text: "nope", placement: { kind: "end" } },
              },
            ]),
          }),
        };
      }
      const toolMsg = options.prompt.find((m) => m.role === "tool") as
        | {
            content: Array<{
              output: { type: string; value: unknown };
            }>;
          }
        | undefined;
      assert.ok(toolMsg);
      assert.equal(toolMsg.content.length, 2);
      const first = toolMsg.content[0]?.output.value as {
        ok: boolean;
        reasonCode?: string;
      };
      assert.equal(first.ok, false);
      assert.equal(first.reasonCode, "EXPECTED_TEXT_MISMATCH");
      const second = toolMsg.content[1]?.output.value as {
        ok: boolean;
        reasonCode?: string;
      };
      assert.equal(second.ok, false);
      assert.equal(second.reasonCode, "PRIOR_WRITE_FAILED");
      sawFailurePayload = true;
      return {
        stream: simulateReadableStream({ chunks: textFinish("failed ok") }),
      };
    },
  });

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "fail write" }],
    tools,
  });

  assert.equal(invocations, 2);
  assert.equal(result.turns, 2);
  assert.equal(sawFailurePayload, true);
  assert.deepEqual(doc.calls, ["mutate:replace_text"]);
  assert.equal(doc.states.length, 0);
});

test("read after write in same run uses mutated state", async () => {
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
                id: "w",
                name: "document.replace_text",
                input: {
                  target: { text: "A" },
                  expectedCurrentText: "A",
                  replacement: "B",
                },
              },
            ]),
          }),
        };
      }
      if (invocations === 2) {
        assert.deepEqual(doc.states, ["v0->replace_text"]);
        return {
          stream: simulateReadableStream({
            chunks: toolCallChunks([
              {
                id: "r",
                name: "document.inspect",
                input: { kind: "overview" },
              },
            ]),
          }),
        };
      }
      assert.deepEqual(doc.calls, ["mutate:replace_text", "inspect"]);
      assert.deepEqual(doc.states, ["v0->replace_text", "v0->replace_text"]);
      return {
        stream: simulateReadableStream({ chunks: textFinish("read ok") }),
      };
    },
  });

  const result = await runAgent({
    model,
    messages: [{ role: "user", content: "write then read" }],
    tools,
  });

  assert.equal(invocations, 3);
  assert.equal(result.turns, 3);
  assert.equal(result.toolCalls, 2);
  assert.equal(result.text, "read ok");
});
