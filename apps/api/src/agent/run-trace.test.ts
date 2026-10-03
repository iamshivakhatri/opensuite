import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { createOpenRouterModel, defineTool, runAgent, type AgentEvent, type ModelMessage } from "@opensuite/agent-core-v3";
import { jsonSchema } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { composeProjectMessages } from "./agent-context.js";
import { projectInRunObservations } from "./in-run-observation-projection.js";
import { createToolSurface } from "./tool-groups.js";
import { createRunTrace, traceModelSettings, type RunTrace } from "./run-trace.js";

const usage = { inputTokens: { total: 100, noCache: 80, cacheRead: 20, cacheWrite: 0 }, outputTokens: { total: 12, text: 7, reasoning: 5 } };
const schema = jsonSchema({ type: "object", properties: { kind: { type: "string" } } });
const rawResult = { ok: true, focus: "tables", tables: { items: [{ handle: "table-1", rowCount: 40, columns: [], rows: [{ cells: ["full original cell content".repeat(100)], cellHandles: ["cell-1"] }] }] }, diagnostics: [] };

function sections(content: string) {
  return [...content.matchAll(/(^#{2,3} [^\n]+)\n\n```json\n([\s\S]*?)\n```/gm)].map((match) => ({ heading: match[1]!, value: JSON.parse(match[2]!) }));
}

async function mockRun(trace?: RunTrace) {
  const executions: unknown[] = [];
  const events: AgentEvent[] = [];
  const requests: unknown[] = [];
  const tools = {
    "document.inspect": defineTool({ kind: "read", description: "Inspect current tables", inputSchema: schema, execute: (args) => { executions.push(args); return rawResult; } }),
    "document.set_text_formatting": defineTool({ kind: "mutate", description: "Format text", inputSchema: schema, execute: (args) => { executions.push(args); return { ok: true, changed: 1 }; } }),
  };
  const surface = createToolSurface(tools);
  const projectMessages = composeProjectMessages({ retrievalMessage: "CURRENT RETRIEVAL EVIDENCE", safeToolResultNames: true });
  let turn = 0;
  let clock = 0;
  const model = new MockLanguageModelV4({
    modelId: "mock-trace-model",
    doStream: async (request) => {
      requests.push(request);
      turn++;
      const calls = turn === 1 ? [{ id: "inspect-1", name: "document_inspect", input: { kind: "tables" } }, { id: "load-1", name: "capabilities_load", input: { ids: ["document.text"] } }]
        : turn === 2 ? [{ id: "format-1", name: "document_set_text_formatting", input: { kind: "bold" } }]
          : turn === 3 ? [{ id: "inspect-2", name: "document_inspect", input: { kind: "context" } }] : [];
      return { stream: simulateReadableStream({ chunks: [
        { type: "stream-start", warnings: [] },
        { type: "reasoning-start", id: "r" }, { type: "reasoning-delta", id: "r", delta: "provider reasoning" }, { type: "reasoning-end", id: "r" },
        { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: turn === 4 ? "finished text" : "working text" }, { type: "text-end", id: "t" },
        ...calls.flatMap((call) => [
          { type: "tool-input-start", id: call.id, toolName: call.name }, { type: "tool-input-delta", id: call.id, delta: JSON.stringify(call.input) },
          { type: "tool-input-end", id: call.id }, { type: "tool-call", toolCallId: call.id, toolName: call.name, input: JSON.stringify(call.input) },
        ]),
        { type: "finish", finishReason: { unified: calls.length ? "tool-calls" : "stop", raw: "stop" }, usage,
          providerMetadata: { openrouter: { usage: { cost: 0.01 } } } },
      ] as never[] }) };
    },
  });
  const result = await runAgent({ model, system: "EXACT SYSTEM", messages: [{ role: "user", content: "EXACT USER REQUEST" }], tools: surface.tools,
    projectMessages, projectTools: surface.projectTools, now: () => ++clock,
    ...(trace ? { onDiagnostic: (event, data) => trace.diagnostic(event, data, surface.summary().groupsLoaded) } : {}),
    onEvent: (event) => { events.push(event); trace?.event(event); },
  });
  return { result, events, executions, requests };
}

test("disabled or off tracing does not create directories or serialize payloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "opensuite-trace-off-"));
  try {
    for (const setting of [undefined, "off", "0", "FULL"]) {
      const trace = createRunTrace({ runId: "run-1", threadId: "thread-1", metadata: { toJSON() { throw new Error("must not serialize"); } } }, { AGENT_RUN_TRACE: setting, AGENT_RUN_TRACE_DIR: join(dir, "absent") });
      assert.equal(trace, undefined);
    }
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true }); }
});

test("full mode names private files with run ID and readable Eastern time in summer and winter", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-01T13:05:06Z") });
  const dir = mkdtempSync(join(tmpdir(), "opensuite-trace-files-"));
  try {
    const env = { AGENT_RUN_TRACE: "full", AGENT_RUN_TRACE_DIR: dir };
    const one = createRunTrace({ runId: "run:one/with spaces", threadId: "thread-1", metadata: { startingVersionId: "version-1" } }, env)!;
    assert.equal(basename(one.path), "run-one-with-spaces_10-01-2026_09-05-06-AM-EDT.md");
    one.write("## Retrieval", { context: "document content" });
    assert.match(readFileSync(one.path, "utf8"), /document content/); // Before settlement.
    one.write("## Settlement", { outcome: "success" });
    t.mock.timers.setTime(new Date("2026-01-15T22:05:06Z").getTime());
    const two = createRunTrace({ runId: "run-2", threadId: "thread-2" }, env)!;
    assert.equal(basename(two.path), "run-2_01-15-2026_05-05-06-PM-EST.md");
    assert.notEqual(one.path, two.path);
    assert.equal(readdirSync(dir).length, 2);
    assert.ok(readdirSync(dir).every((file) => /^[a-zA-Z0-9_-]+\.md$/.test(file)));
    assert.equal(statSync(one.path).mode & 0o777, 0o600);
    const content = readFileSync(one.path, "utf8");
    assert.match(content, /LOCAL DEBUG TRACE — MAY CONTAIN FULL USER\/DOCUMENT\/MODEL CONTENT/);
    assert.match(content, /"runId": "run:one\/with spaces"/);
    assert.match(content, /"threadId": "thread-1"/);
    assert.match(content, /"startingVersionId": "version-1"/);
    assert.match(content, /traceFormatVersion/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("mocked real loop traces final requests, dynamic schemas, reasoning, raw results and projected observations without changing behavior", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensuite-trace-loop-"));
  try {
    const trace = createRunTrace({ runId: "mock-run", threadId: "mock-thread", metadata: { model: "mock-trace-model" } }, { AGENT_RUN_TRACE: "full", AGENT_RUN_TRACE_DIR: dir })!;
    const traced = await mockRun(trace);
    const plain = await mockRun();
    assert.deepEqual(traced, plain); // Includes requests, events, execution and deterministic metrics.
    assert.equal(readdirSync(dir).length, 1);
    const content = readFileSync(trace.path, "utf8");
    const entries = sections(content);
    const requests = entries.filter((entry) => /— Request$/.test(entry.heading));
    assert.equal(requests.length, 4);
    assert.deepEqual(requests[0]!.value.activeGroups, []);
    assert.deepEqual(requests[1]!.value.activeGroups, ["document.text"]);
    assert.equal(requests[0]!.value.exposedToolCount, 4);
    assert.equal(requests[1]!.value.exposedToolCount, 5);
    assert.equal(entries.find((entry) => entry.heading === "### System")!.value, "EXACT SYSTEM");
    const messages = entries.filter((entry) => entry.heading === "### Messages");
    assert.deepEqual(messages[0]!.value, [{ role: "user", content: "CURRENT RETRIEVAL EVIDENCE" }, { role: "user", content: "EXACT USER REQUEST" }]);
    const schemas = entries.filter((entry) => entry.heading === "### Tools");
    assert.ok(schemas[0]!.value.document_inspect.inputSchema.jsonSchema);
    assert.equal(schemas[0]!.value.document_set_text_formatting, undefined);
    assert.ok(schemas[1]!.value.document_set_text_formatting);
    assert.equal(requests[0]!.value.exposedToolSchemaChars, JSON.stringify(schemas[0]!.value).length);
    assert.match(content, /### Reasoning\n\n```text\nprovider reasoning\n```/);
    assert.match(content, /### Assistant Text\n\n```text\nfinished text\n```/);
    assert.equal((content.match(/^### Reasoning$/gm) ?? []).length, 4);
    assert.doesNotMatch(content, /reasoning-delta|text-delta|tool-input-start|tool-input-delta|tool-input-end/);
    assert.doesNotMatch(content, /responseMessages/);
    for (const field of ["finishReason", "inputTokens", "cachedInputTokens", "outputTokens", "reasoningTokens", "firstReasoningMs", "firstTextMs", "firstToolMs", "durationMs", "providerReportedCostUsd"]) assert.match(content, new RegExp(field));
    const execution = entries.find((entry) => entry.heading === "### Tool Result — document.inspect — inspect-1")!.value;
    assert.equal(execution.toolName, "document.inspect");
    assert.equal(execution.modelFacingName, "document_inspect");
    assert.deepEqual(execution.arguments, { kind: "tables" });
    assert.deepEqual(execution.rawResult, rawResult);
    assert.equal(execution.outcome, "success");
    const observation = entries.find((entry) => entry.heading === "### Model-Facing Observation — Turn 4 — inspect-1")!.value;
    assert.deepEqual(observation.output.value, rawResult); // Current C7 leaves aliased observations unchanged.
    const turnFour = messages[3]!.value as ModelMessage[];
    assert.ok(turnFour.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "tool-result" && part.toolCallId === "inspect-1" && JSON.stringify(part) === JSON.stringify(observation))));
  } finally { rmSync(dir, { recursive: true }); }
});

test("request capture follows C7 compaction and provider-safe name projection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensuite-trace-c7-"));
  try {
    const trace = createRunTrace({ runId: "c7", threadId: "thread" }, { AGENT_RUN_TRACE: "full", AGENT_RUN_TRACE_DIR: dir })!;
    const history: ModelMessage[] = [];
    for (const id of ["old", "recent-1", "recent-2"]) history.push(
      { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "document.inspect", input: { kind: id } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: id, toolName: "document.inspect", output: { type: "json", value: rawResult as never } }] },
    );
    const original = JSON.stringify(history);
    const aliasNames = composeProjectMessages({ safeToolResultNames: true });
    // C7 must run before provider-safe renaming (it matches dotted tool names).
    const projectMessages = (messages: readonly ModelMessage[]) =>
      aliasNames(projectInRunObservations(messages).messages);
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "done" }, { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ] as never[] }) }) });
    await runAgent({ model, messages: history, projectMessages, onEvent: trace.event, onDiagnostic: trace.diagnostic });
    const observation = sections(readFileSync(trace.path, "utf8")).find((entry) => entry.heading === "### Model-Facing Observation — Turn 1 — old")!.value;
    assert.equal(observation.toolName, "document_inspect");
    assert.equal(observation.output.value.compacted, true);
    assert.notDeepEqual(observation.output.value, rawResult);
    assert.equal(JSON.stringify(history), original);
  } finally { rmSync(dir, { recursive: true }); }
});

for (const cancelled of [false, true]) test(`${cancelled ? "cancellation" : "provider error"} leaves reasoning and text in a usable partial file`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensuite-trace-partial-"));
  try {
    const trace = createRunTrace({ runId: "partial", threadId: "thread" }, { AGENT_RUN_TRACE: "full", AGENT_RUN_TRACE_DIR: dir })!;
    const controller = new AbortController();
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] }, { type: "reasoning-start", id: "r" }, { type: "reasoning-delta", id: "r", delta: "partial reasoning" },
      { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "partial text" }, { type: "error", error: new Error("mock failure") },
    ] as never[] }) }) });
    await assert.rejects(runAgent({ model, messages: [{ role: "user", content: "go" }], signal: controller.signal,
      onEvent: trace.event,
      onDiagnostic: (event, data) => { trace.diagnostic(event, data); if (cancelled && event === "model_stream" && (data as { type: string }).type === "text-delta") controller.abort(new Error("cancelled")); },
    }));
    const content = readFileSync(trace.path, "utf8");
    assert.match(content, /Turn 1 — Request/);
    assert.match(content, /### Reasoning — Partial\n\n```text\npartial reasoning\n```/);
    assert.match(content, /### Assistant Text — Partial\n\n```text\npartial text\n```/);
    assert.doesNotMatch(content, /reasoning-delta|text-delta/);
    assert.ok(sections(content).length > 3);
    assert.match(content, cancelled ? /cancelled/ : /mock failure/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("model configuration and provider errors do not emit obvious secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "opensuite-trace-secret-"));
  try {
    const model = createOpenRouterModel({ apiKey: "do-not-emit-key", model: "deepseek/deepseek-v4.1-flash" });
    const settings = traceModelSettings(model);
    assert.deepEqual(settings, { reasoning: { effort: "low" }, provider: { sort: "throughput" }, usage: { include: true } });
    const trace = createRunTrace({ runId: "secret-test", threadId: "thread", metadata: { modelSettings: settings } }, { AGENT_RUN_TRACE: "full", AGENT_RUN_TRACE_DIR: dir })!;
    const error = Object.assign(new Error("postgresql://user:db-secret@localhost/db Authorization=auth-secret password=pass-secret Bearer token-secret"), {
      requestHeaders: { authorization: "header-secret", cookie: "cookie-secret" }, requestBody: "body-secret", cause: new Error("cause-secret"),
    });
    trace.diagnostic("model_error", { error });
    trace.diagnostic("model_stream", { type: "error", error: { message: "api_key=plain-secret", headers: { cookie: "plain-cookie-secret" }, code: "MOCK_ERROR" } });
    const content = readFileSync(trace.path, "utf8");
    for (const secret of ["do-not-emit-key", "db-secret", "auth-secret", "pass-secret", "token-secret", "header-secret", "cookie-secret", "body-secret", "cause-secret", "plain-secret", "plain-cookie-secret"]) assert.ok(!content.includes(secret), secret);
    assert.match(content, /omitted/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("tool rejection, thrown error and skipped mutation retain raw failures and next-turn observations", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensuite-trace-tools-"));
  try {
    const trace = createRunTrace({ runId: "tool-errors", threadId: "thread" }, { AGENT_RUN_TRACE: "full", AGENT_RUN_TRACE_DIR: dir })!;
    let turn = 0;
    let skippedExecutions = 0;
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: [
      { type: "stream-start", warnings: [] },
      ...(turn++ === 0 ? ["read_error", "reject", "skipped"].map((name) => ({ type: "tool-call", toolCallId: name, toolName: name, input: JSON.stringify({ kind: name }) })) : []),
      { type: "finish", finishReason: { unified: turn === 1 ? "tool-calls" : "stop", raw: "stop" }, usage },
    ] as never[] }) }) });
    const result = await runAgent({ model, messages: [{ role: "user", content: "go" }], tools: {
      read_error: defineTool({ kind: "read", description: "throws", inputSchema: schema, execute: () => { throw new Error("READ_FAILED"); } }),
      reject: defineTool({ kind: "mutate", description: "rejects", inputSchema: schema, execute: () => ({ ok: false, reasonCode: "REJECTED", detail: "raw failure detail" }) }),
      skipped: defineTool({ kind: "mutate", description: "skipped", inputSchema: schema, execute: () => { skippedExecutions++; return { ok: true }; } }),
    }, onEvent: trace.event, onDiagnostic: trace.diagnostic });
    assert.equal(result.stopReason, "completed");
    assert.equal(skippedExecutions, 0);
    const content = readFileSync(trace.path, "utf8");
    for (const expected of ["READ_FAILED", "REJECTED", "raw failure detail", "PRIOR_MUTATION_FAILED", "startedAtMs", "completedAtMs"]) assert.ok(content.includes(expected), expected);
    const entries = sections(content);
    assert.equal(entries.find((entry) => entry.heading === "### Tool Result — reject — reject")!.value.outcome, "failure");
    assert.equal(entries.find((entry) => entry.heading === "### Tool Skipped — skipped — skipped")!.value.reason, "PRIOR_MUTATION_FAILED");
    assert.equal(entries.find((entry) => entry.heading === "### Model-Facing Observation — Turn 2 — skipped")!.value.output.value.status, "skipped");
  } finally { rmSync(dir, { recursive: true }); }
});

test("an unwritable trace destination does not change the run outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "opensuite-trace-write-failure-"));
  try {
    const file = join(dir, "file");
    writeFileSync(file, "not a directory");
    const trace = createRunTrace({ runId: "run", threadId: "thread" }, { AGENT_RUN_TRACE: "full", AGENT_RUN_TRACE_DIR: file });
    assert.deepEqual(await mockRun(trace), await mockRun());
  } finally { rmSync(dir, { recursive: true }); }
});
