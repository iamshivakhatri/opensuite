import assert from "node:assert/strict";
import { test } from "node:test";

import type { AgentToolSet, ModelMessage } from "@opensuite/agent-core";

import { estimateTokens } from "./context-projection.js";
import { composeProjectMessages, firstTurnContextProjection } from "./agent-context.js";
import { guardRepeatedReads } from "./execution.js";
import {
  createInRunObservationStats,
  projectInRunObservations,
  RECENT_TOOL_TURNS_VERBATIM,
} from "./in-run-observation-projection.js";

function toolCall(
  toolCallId: string,
  toolName: string,
  input: unknown = {},
): {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: unknown;
} {
  return { type: "tool-call", toolCallId, toolName, input };
}

function toolResult(
  toolCallId: string,
  toolName: string,
  value: unknown,
): {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "json"; value: never };
} {
  return {
    type: "tool-result",
    toolCallId,
    toolName,
    output: { type: "json", value: value as never },
  };
}

function assistantTurn(
  ...calls: ReturnType<typeof toolCall>[]
): ModelMessage {
  return { role: "assistant", content: calls as never };
}

function toolTurn(
  ...results: ReturnType<typeof toolResult>[]
): ModelMessage {
  return { role: "tool", content: results as never };
}

function largeInspectPayload() {
  return {
    ok: true,
    focus: "tables",
    tables: {
      page: { total: 3, offset: 0, returned: 3, hasMore: false },
      items: [
        {
          occurrence: 0,
          handle: "t0",
          rowCount: 40,
          columns: [{ occurrence: 0, handle: "c0", text: "A" }],
          rows: Array.from({ length: 40 }, (_, i) => ({
            handle: `r${i}`,
            cells: [`cell-${i}-a`.repeat(20), `cell-${i}-b`.repeat(20)],
            cellHandles: [`h${i}a`, `h${i}b`],
          })),
        },
      ],
    },
    diagnostics: [],
  };
}

function largeFindPayload(query: string, matchCount: number) {
  return {
    ok: true,
    query,
    matchCount,
    matches: Array.from({ length: matchCount }, (_, i) => ({
      occurrence: i,
      text: query,
      before: "x".repeat(64),
      after: "y".repeat(64),
      container: "paragraph",
    })),
    diagnostics: [],
  };
}

function resultValue(message: ModelMessage, index = 0): Record<string, unknown> {
  assert.equal(message.role, "tool");
  assert.ok(Array.isArray(message.content));
  const part = message.content[index] as {
    output: { type: string; value: Record<string, unknown> };
  };
  return part.output.value;
}

function resultPart(message: ModelMessage, index = 0) {
  assert.equal(message.role, "tool");
  assert.ok(Array.isArray(message.content));
  return message.content[index] as {
    type: string;
    toolCallId: string;
    toolName: string;
    output: { type: string; value: unknown };
  };
}

// --- Pairing ---

test("C7 pairing: assistant tool-call/result pair preserved with same toolCallId after shrink", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "seed request" },
    assistantTurn(toolCall("c1", "document.inspect", { kind: "tables" })),
    toolTurn(toolResult("c1", "document.inspect", largeInspectPayload())),
    assistantTurn(toolCall("c2", "document.find", { text: "x" })),
    toolTurn(toolResult("c2", "document.find", largeFindPayload("x", 5))),
    assistantTurn(toolCall("c3", "document.replace_text", { text: "a" })),
    toolTurn(
      toolResult("c3", "document.replace_text", {
        ok: true,
        capability: "replace_text",
        status: "ok",
        diagnostics: [],
      }),
    ),
  ];

  const projected = projectInRunObservations(messages, {
    isMutateTool: (name) => name.startsWith("document.") && !name.endsWith("inspect") && !name.endsWith("find"),
  });

  assert.equal(projected.observationsCompacted, 1);
  const oldInspect = projected.messages[2]!;
  const part = resultPart(oldInspect);
  assert.equal(part.toolCallId, "c1");
  assert.equal(part.toolName, "document.inspect");
  assert.equal(part.type, "tool-result");
  assert.equal(part.output.type, "json");
  assert.equal(resultValue(oldInspect).compacted, true);

  // Matching call still present with same id.
  const assistant = projected.messages[1]!;
  assert.equal(assistant.role, "assistant");
  assert.ok(Array.isArray(assistant.content));
  assert.equal((assistant.content[0] as { toolCallId: string }).toolCallId, "c1");
});

test("C7 pairing: multi-tool turn stays together; all toolCallIds intact", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "go" },
    assistantTurn(
      toolCall("a", "document.inspect", { kind: "tables" }),
      toolCall("b", "document.find", { text: "Milestone" }),
    ),
    toolTurn(
      toolResult("a", "document.inspect", largeInspectPayload()),
      toolResult("b", "document.find", largeFindPayload("Milestone", 12)),
    ),
    assistantTurn(toolCall("c", "document.inspect", { kind: "context" })),
    toolTurn(
      toolResult("c", "document.inspect", {
        ok: true,
        focus: "context",
        context: { target: { text: "x" }, nearby: [] },
        diagnostics: [],
      }),
    ),
    assistantTurn(toolCall("d", "document.replace_text", {})),
    toolTurn(
      toolResult("d", "document.replace_text", {
        ok: true,
        capability: "replace_text",
        status: "ok",
        diagnostics: [],
      }),
    ),
  ];

  const projected = projectInRunObservations(messages);
  // Oldest multi-tool turn is outside recent-2 → both reads compact.
  assert.equal(projected.observationsCompacted, 2);
  const toolMsg = projected.messages[2]!;
  assert.equal(resultPart(toolMsg, 0).toolCallId, "a");
  assert.equal(resultPart(toolMsg, 1).toolCallId, "b");
  assert.equal(resultValue(toolMsg, 0).compacted, true);
  assert.equal(resultValue(toolMsg, 1).compacted, true);

  // Assistant still has both calls.
  const assistant = projected.messages[1]!;
  assert.ok(Array.isArray(assistant.content));
  assert.equal(assistant.content.length, 2);
});

test("C7 pairing: malformed / unmatched ids fail safe (unchanged)", () => {
  const orphanCall: ModelMessage[] = [
    { role: "user", content: "u" },
    assistantTurn(toolCall("x", "document.inspect")),
    // Missing tool message — not a completed turn.
    { role: "user", content: "later" },
  ];
  const a = projectInRunObservations(orphanCall);
  assert.deepEqual(a.messages, orphanCall);
  assert.equal(a.observationsCompacted, 0);

  const mismatched: ModelMessage[] = [
    { role: "user", content: "u" },
    assistantTurn(toolCall("x", "document.inspect")),
    toolTurn(toolResult("y", "document.inspect", largeInspectPayload())),
    assistantTurn(toolCall("a", "document.find")),
    toolTurn(toolResult("a", "document.find", largeFindPayload("q", 3))),
    assistantTurn(toolCall("b", "document.find")),
    toolTurn(toolResult("b", "document.find", largeFindPayload("q", 3))),
  ];
  const b = projectInRunObservations(mismatched);
  // Mismatched pair treated as passthrough; no orphan tool-call produced by us.
  assert.equal(b.observationsCompacted, 0);
  assert.deepEqual(b.messages[1], mismatched[1]);
  assert.deepEqual(b.messages[2], mismatched[2]);
});

test("C7 pairing: no orphan tool-call after projection", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "u" },
    assistantTurn(toolCall("1", "document.inspect")),
    toolTurn(toolResult("1", "document.inspect", largeInspectPayload())),
    assistantTurn(toolCall("2", "document.find")),
    toolTurn(toolResult("2", "document.find", largeFindPayload("a", 4))),
    assistantTurn(toolCall("3", "document.find")),
    toolTurn(toolResult("3", "document.find", largeFindPayload("b", 4))),
  ];
  const projected = projectInRunObservations(messages);
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const message of projected.messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          typeof part === "object" &&
          part !== null &&
          (part as { type?: string }).type === "tool-call"
        ) {
          callIds.add((part as { toolCallId: string }).toolCallId);
        }
      }
    }
    if (message.role === "tool" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          typeof part === "object" &&
          part !== null &&
          (part as { type?: string }).type === "tool-result"
        ) {
          resultIds.add((part as { toolCallId: string }).toolCallId);
        }
      }
    }
  }
  for (const id of callIds) assert.ok(resultIds.has(id), `orphan call ${id}`);
  for (const id of resultIds) assert.ok(callIds.has(id), `orphan result ${id}`);
});

// --- Verbatim window ---

test("C7 window: <=2 tool turns → no compaction", () => {
  assert.equal(RECENT_TOOL_TURNS_VERBATIM, 2);
  const messages: ModelMessage[] = [
    { role: "user", content: "seed" },
    assistantTurn(toolCall("1", "document.inspect")),
    toolTurn(toolResult("1", "document.inspect", largeInspectPayload())),
    assistantTurn(toolCall("2", "document.replace_text")),
    toolTurn(
      toolResult("2", "document.replace_text", {
        ok: true,
        capability: "replace_text",
        status: "ok",
        diagnostics: [],
      }),
    ),
  ];
  const projected = projectInRunObservations(messages);
  assert.equal(projected.observationsCompacted, 0);
  assert.deepEqual(projected.messages, messages);
});

test("C7 window: 3 tool turns → oldest eligible inspect may compact; latest 2 unchanged", () => {
  const inspect = largeInspectPayload();
  const find = largeFindPayload("q", 8);
  const mutate = {
    ok: true,
    capability: "replace_text",
    status: "ok",
    diagnostics: [],
  };
  const messages: ModelMessage[] = [
    { role: "user", content: "current request" },
    { role: "user", content: "Historical conversation checkpoint through abc:\nprior" },
    assistantTurn(toolCall("1", "document.inspect")),
    toolTurn(toolResult("1", "document.inspect", inspect)),
    assistantTurn(toolCall("2", "document.find")),
    toolTurn(toolResult("2", "document.find", find)),
    assistantTurn(toolCall("3", "document.replace_text")),
    toolTurn(toolResult("3", "document.replace_text", mutate)),
  ];

  const projected = projectInRunObservations(messages);
  assert.ok(projected.observationsCompacted >= 1);
  assert.deepEqual(projected.messages[0], messages[0]);
  assert.deepEqual(projected.messages[1], messages[1]);
  assert.deepEqual(projected.messages[4], messages[4]); // recent find assistant
  assert.deepEqual(projected.messages[5], messages[5]); // recent find tool
  assert.deepEqual(projected.messages[6], messages[6]);
  assert.deepEqual(projected.messages[7], messages[7]);
  assert.equal(resultValue(projected.messages[3]!).compacted, true);
  assert.equal(resultValue(projected.messages[3]!).focus, "tables");
});

// --- Tool policies ---

test("C7 policies: old successful find shrinks; recent inspect stays full", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "u" },
    assistantTurn(toolCall("1", "document.find")),
    toolTurn(toolResult("1", "document.find", largeFindPayload("Milestone", 30))),
    assistantTurn(toolCall("2", "document.inspect")),
    toolTurn(toolResult("2", "document.inspect", largeInspectPayload())),
    assistantTurn(toolCall("3", "document.replace_text")),
    toolTurn(
      toolResult("3", "document.replace_text", {
        ok: true,
        capability: "replace_text",
        status: "ok",
        diagnostics: [],
      }),
    ),
  ];
  const projected = projectInRunObservations(messages);
  const oldFind = resultValue(projected.messages[2]!);
  assert.equal(oldFind.compacted, true);
  assert.equal(oldFind.tool, "document.find");
  assert.equal(oldFind.query, "Milestone");
  assert.equal(oldFind.matchCount, 30);
  assert.equal(oldFind.matches, undefined);

  // Recent inspect (turn 2 of 3) stays full.
  assert.deepEqual(resultValue(projected.messages[4]!), largeInspectPayload());
});

test("C7 policies: mutation failure remains full; lifecycle/finish not rewritten", () => {
  const failure = {
    ok: false,
    capability: "replace_text",
    status: "error",
    reasonCode: "TARGET_NOT_FOUND",
    diagnostics: [
      {
        code: "TARGET_NOT_FOUND",
        severity: "error",
        message: "No match for expected text",
      },
    ],
  };
  const messages: ModelMessage[] = [
    { role: "user", content: "u" },
    assistantTurn(toolCall("1", "document.replace_text")),
    toolTurn(toolResult("1", "document.replace_text", failure)),
    assistantTurn(toolCall("2", "document.inspect")),
    toolTurn(toolResult("2", "document.inspect", largeInspectPayload())),
    assistantTurn(toolCall("3", "workspace.create_blank_document")),
    toolTurn(
      toolResult("3", "workspace.create_blank_document", {
        created: true,
        title: "Untitled",
        becameActive: true,
      }),
    ),
  ];

  // 3 tool turns → oldest (failed mutation) outside window but must stay full.
  const projected = projectInRunObservations(messages);
  assert.deepEqual(resultValue(projected.messages[2]!), failure);
  // Lifecycle in recent window; also wouldn't be rewritten by policy.
  assert.deepEqual(projected.messages[5], messages[5]);
  assert.deepEqual(projected.messages[6], messages[6]);
});

test("C7 policies: after successful mutation, old pre-mutation reads compact", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "u" },
    assistantTurn(toolCall("1", "document.inspect")),
    toolTurn(toolResult("1", "document.inspect", largeInspectPayload())),
    assistantTurn(toolCall("2", "document.find")),
    toolTurn(toolResult("2", "document.find", largeFindPayload("x", 10))),
    assistantTurn(toolCall("3", "document.replace_text")),
    toolTurn(
      toolResult("3", "document.replace_text", {
        ok: true,
        capability: "replace_text",
        status: "ok",
        diagnostics: [],
        versionId: "v2",
      }),
    ),
  ];
  const projected = projectInRunObservations(messages, {
    isMutateTool: (name) => name === "document.replace_text",
  });
  assert.equal(resultValue(projected.messages[2]!).compacted, true);
  // find is within recent-2 with mutate → stays full
  const findPayload = resultValue(projected.messages[4]!);
  assert.ok(Array.isArray(findPayload.matches));
  assert.equal((findPayload.matches as unknown[]).length, 10);
});

test("C7 policies: failed inspect outside window keeps failure signal when compactable", () => {
  const failedInspect = {
    ok: false,
    focus: "tables",
    diagnostics: [
      { code: "INSPECT_FAILED", severity: "error", message: "engine boom", reasonCode: "ENGINE" },
    ],
  };
  const messages: ModelMessage[] = [
    { role: "user", content: "u" },
    assistantTurn(toolCall("1", "document.inspect")),
    toolTurn(toolResult("1", "document.inspect", failedInspect)),
    assistantTurn(toolCall("2", "document.find")),
    toolTurn(toolResult("2", "document.find", largeFindPayload("a", 2))),
    assistantTurn(toolCall("3", "document.find")),
    toolTurn(toolResult("3", "document.find", largeFindPayload("b", 2))),
  ];
  const projected = projectInRunObservations(messages);
  const stub = resultValue(projected.messages[2]!);
  assert.equal(stub.ok, false);
  assert.equal(stub.compacted, true);
  assert.equal(stub.reason, "engine boom");
});

// --- Phase 6 composition ---

test("initial retrieval remains available; later turns preserve provider exchanges", () => {
  const project = composeProjectMessages({
    retrievalMessage: "Relevant document structure:\n- Table t0",
  });

  const seed: ModelMessage[] = [{ role: "user", content: "Add milestones" }];
  const turn1 = project(seed);
  assert.equal(turn1.length, 2);
  assert.match(String((turn1[0] as { content: string }).content), /Relevant document structure/);
  assert.deepEqual(turn1[1], seed[0]);

  // Simulate transcript after first tool turn (retrieval is NOT in raw transcript).
  const afterTools: ModelMessage[] = [
    ...seed,
    assistantTurn(toolCall("1", "document.inspect")),
    toolTurn(toolResult("1", "document.inspect", largeInspectPayload())),
    assistantTurn(toolCall("2", "document.find")),
    toolTurn(toolResult("2", "document.find", largeFindPayload("m", 5))),
    assistantTurn(toolCall("3", "document.replace_text")),
    toolTurn(
      toolResult("3", "document.replace_text", {
        ok: true,
        capability: "replace_text",
        status: "ok",
        diagnostics: [],
      }),
    ),
  ];
  const turn2 = project(afterTools);
  assert.equal(turn2.filter(message => JSON.stringify(message).includes("Relevant document structure")).length, 1);
  assert.deepEqual(resultValue(turn2[3]!), largeInspectPayload());
  assert.match(JSON.stringify(turn2), /INITIAL DOCUMENT CONTEXT/);
});

test("OpenRouter tool responses use provider-safe names without changing the raw transcript", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "Create a document" },
    assistantTurn(toolCall("c1", "document.insert_paragraphs")),
    toolTurn(toolResult("c1", "document.insert_paragraphs", { ok: false, reasonCode: "NO_ACTIVE_DOCUMENT" })),
  ];
  const project = composeProjectMessages({ safeToolResultNames: true });
  const projected = project(messages);
  const result = (projected[2]!.content as { toolName: string }[])[0]!;
  assert.equal(result.toolName, "document_insert_paragraphs");
  assert.equal((messages[2]!.content as { toolName: string }[])[0]!.toolName, "document.insert_paragraphs");
  assert.equal((projected[1]!.content as { toolName: string }[])[0]!.toolName, "document_insert_paragraphs");
  assert.equal((messages[1]!.content as { toolName: string }[])[0]!.toolName, "document.insert_paragraphs");
});

test("firstTurnContextProjection still injects once", () => {
  const project = firstTurnContextProjection("Relevant document structure:\n- Table t0");
  const messages = [{ role: "user" as const, content: "Add milestones" }];
  assert.equal(project(messages).length, 2);
  assert.deepEqual(project(messages), messages);
});

test("DIRECT content stays available while its version is current", () => {
  let version = "v1";
  const project = composeProjectMessages({
    retrievalMessage: "COMPLETE CURRENT DOCUMENT CONTENT (v1)",
    directVersionId: "v1",
    currentVersionId: () => version,
  });
  const messages: ModelMessage[] = [{ role: "user", content: "Continue" }];
  assert.match(JSON.stringify(project(messages)), /COMPLETE CURRENT DOCUMENT CONTENT/);
  const afterRead = [...messages, assistantTurn(toolCall("r", "document.find", { text: "x" })), toolTurn(toolResult("r", "document.find", { ok: true }))];
  const second = project(afterRead);
  assert.equal(second[2]?.role, "assistant");
  assert.equal(second[3]?.role, "tool");
  assert.match(JSON.stringify(second[0]), /COMPLETE CURRENT DOCUMENT CONTENT/);
  version = "v2";
  assert.doesNotMatch(JSON.stringify(project(afterRead)), /COMPLETE CURRENT DOCUMENT CONTENT/);
});

test("DIRECT content follows an exact document copy, then expires after editing", () => {
  let version = "source";
  let directVersion = "source";
  let workingRevision = 0;
  const project = composeProjectMessages({
    retrievalMessage: "COMPLETE DOCUMENT CONTENT",
    directVersionId: () => directVersion,
    currentVersionId: () => workingRevision ? null : version,
  });
  const messages: ModelMessage[] = [{ role: "user", content: "Rewrite the copy" }];
  project(messages);
  version = "copy";
  directVersion = "copy";
  assert.match(JSON.stringify(project(messages)), /COMPLETE DOCUMENT CONTENT/);
  workingRevision = 1;
  assert.doesNotMatch(JSON.stringify(project(messages)), /COMPLETE DOCUMENT CONTENT/);
});

test("current DIRECT projection replaces its snapshot at a fixed position and omits an unavailable view", () => {
  let snapshot: string | undefined = "CURRENT INITIAL";
  const project = composeProjectMessages({ retrievalMessage: snapshot, currentDirectMessage: () => snapshot,
    directVersionId: "v1", currentVersionId: () => snapshot ? "v1" : null,
    });
  const messages: ModelMessage[] = [{ role: "user", content: "History" }, { role: "assistant", content: "Earlier reply" },
    { role: "user", content: "Edit" }];
  assert.equal(project(messages)[2]!.content, "CURRENT INITIAL");
  const later: ModelMessage[] = [...messages, { role: "assistant", content: "Tool turn" }];
  snapshot = "CURRENT UPDATED";
  const refreshed = project(later);
  assert.equal(refreshed[2]!.content, "CURRENT UPDATED");
  assert.equal(refreshed.filter((message) => JSON.stringify(message).includes("CURRENT")).length, 1);
  assert.doesNotMatch(JSON.stringify(refreshed), /CURRENT INITIAL/);
  assert.deepEqual(later, [...messages, { role: "assistant", content: "Tool turn" }]);
  snapshot = undefined;
  assert.doesNotMatch(JSON.stringify(project(later)), /CURRENT/);
  snapshot = "CURRENT RECOVERED";
  assert.equal(project(later)[2]!.content, "CURRENT RECOVERED");
});

function readTranscript(tools: AgentToolSet, messages: ModelMessage[] = []) {
  return async (name: string, input: unknown) => {
    const id = `read-${messages.length}`;
    messages.push(assistantTurn(toolCall(id, name, input)));
    const value = await tools[name]!.execute!(input, { toolCallId: id, messages: [...messages], context: undefined as never });
    messages.push(toolTurn(toolResult(id, name, value)));
    return value as Record<string, unknown>;
  };
}

test("exact read reuse references the first full result without losing calls or native execution identity", async () => {
  let reads = 0;
  let finds = 0;
  const tools = { "document.inspect": { kind: "read", execute: () => { reads++; return largeInspectPayload(); } },
    "document.find": { kind: "read", execute: () => { finds++; return largeFindPayload("Details", 1); } },
  } as unknown as AgentToolSet;
  const state = { documentId: "doc-1", versionId: "v1", workingRevision: 0 };
  const guard = guardRepeatedReads(tools, () => state);
  const messages: ModelMessage[] = [{ role: "user", content: "Keep the complete request" }];
  const inspect = readTranscript(tools, messages);
  const first = await inspect("document.inspect", { kind: "tables" });
  const repeat = await inspect("document.inspect", { kind: "tables" });
  assert.equal(reads, 1);
  assert.equal(repeat.originalToolCallId, "read-1");
  assert.equal(repeat.reusedObservation, true);
  assert.deepEqual(repeat.readState, state);
  assert.deepEqual(resultValue(messages[2]!), first);
  assert.equal(messages.length, 5);
  await inspect("document.inspect", { kind: "paragraphs" });
  assert.equal(reads, 2, "different arguments always execute");
  assert.equal(guard.suppressedCount(), 1);
  await inspect("document.find", { text: "Details" });
  assert.equal((await inspect("document.find", { text: "Details" })).reusedObservation, true);
  assert.equal(finds, 1);
});

test("revision, saved version, document switches and failed mutations require fresh reads", async () => {
  let reads = 0;
  const tools = { "document.inspect": { kind: "read", execute: () => { reads++; return largeInspectPayload(); } } } as unknown as AgentToolSet;
  let state = { documentId: "first", versionId: "v1", workingRevision: 0 };
  guardRepeatedReads(tools, () => state);
  const messages: ModelMessage[] = [];
  const inspect = readTranscript(tools, messages);
  const read = () => inspect("document.inspect", { kind: "tables" });
  await read();
  state = { ...state, workingRevision: 1 }; await read();
  state = { ...state, versionId: "v2" }; await read();
  state = { ...state, documentId: "second" }; await read();
  messages.push(assistantTurn(toolCall("switch", "workspace.select_document", { documentId: "first" })), toolTurn(toolResult("switch", "workspace.select_document", { ok: true })));
  state = { documentId: "first", versionId: "v1", workingRevision: 0 }; await read();
  messages.push(assistantTurn(toolCall("failed", "document.replace_text", {})), toolTurn(toolResult("failed", "document.replace_text", { ok: false, reasonCode: "STALE_HANDLE" })));
  await read();
  assert.equal(reads, 6);
});

test("failed, ambiguous, warning and missing-context reads are never assumed reusable", async () => {
  for (const result of [{ ok: false, reasonCode: "NOT_FOUND" }, { ok: true, matchCount: 2, diagnostics: [] },
    { ok: true, matchCount: 0, diagnostics: [] }, { ok: true, matchCount: 1, diagnostics: [{ code: "WARNING" }] }]) {
    let reads = 0;
    const tools = { "document.find": { kind: "read", execute: () => { reads++; return result; } } } as unknown as AgentToolSet;
    guardRepeatedReads(tools, () => ({ documentId: "doc", versionId: "v1", workingRevision: 0 }));
    const find = readTranscript(tools);
    await find("document.find", { text: "Pricing" }); await find("document.find", { text: "Pricing" });
    assert.equal(reads, 2);
  }
  let reads = 0;
  const tools = { "document.find": { kind: "read", execute: () => { reads++; return { ok: true, matchCount: 1, diagnostics: [] }; } } } as unknown as AgentToolSet;
  guardRepeatedReads(tools, () => ({ documentId: "doc", versionId: "v1", workingRevision: 0 }));
  await readTranscript(tools)("document.find", { text: "Pricing" });
  await readTranscript(tools)("document.find", { text: "Pricing" });
  assert.equal(reads, 2, "no earlier observation in context means no reuse");
  const malformed: ModelMessage[] = [assistantTurn(toolCall("wrong", "document.find", { text: "Pricing" })),
    toolTurn(toolResult("wrong", "document.inspect", { ok: true }))];
  await readTranscript(tools, malformed)("document.find", { text: "Pricing" });
  assert.equal(reads, 3, "broken tool pairing means no reuse");
});

// --- Token effect / pathological ---

test("C7 tokens: projected in-run tokens after < before for large inspect/find", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "u" },
    assistantTurn(toolCall("1", "document.inspect")),
    toolTurn(toolResult("1", "document.inspect", largeInspectPayload())),
    assistantTurn(toolCall("2", "document.find")),
    toolTurn(toolResult("2", "document.find", largeFindPayload("wide", 40))),
    assistantTurn(toolCall("3", "document.replace_text")),
    toolTurn(
      toolResult("3", "document.replace_text", {
        ok: true,
        capability: "replace_text",
        status: "ok",
        diagnostics: [],
      }),
    ),
  ];
  const projected = projectInRunObservations(messages);
  assert.ok(projected.estimatedInRunTokensAfter < projected.estimatedInRunTokensBefore);
  assert.ok(projected.observationsCompacted >= 1);
});

test("C7 tokens: 8–10 tool-turn fixture does not retain every full raw payload model-facing", () => {
  const messages: ModelMessage[] = [{ role: "user", content: "pathological" }];
  for (let i = 0; i < 9; i += 1) {
    const id = `t${i}`;
    if (i % 2 === 0) {
      messages.push(assistantTurn(toolCall(id, "document.inspect")));
      messages.push(toolTurn(toolResult(id, "document.inspect", largeInspectPayload())));
    } else {
      messages.push(assistantTurn(toolCall(id, "document.find")));
      messages.push(toolTurn(toolResult(id, "document.find", largeFindPayload(`q${i}`, 25))));
    }
  }

  const projected = projectInRunObservations(messages);
  assert.ok(projected.observationsCompacted >= 5);
  assert.ok(projected.estimatedInRunTokensAfter < projected.estimatedInRunTokensBefore);

  // Count full (non-compacted) inspect/find payloads in projection.
  let fullPayloads = 0;
  let compactedPayloads = 0;
  for (const message of projected.messages) {
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (let i = 0; i < message.content.length; i += 1) {
      const value = resultValue(message, i);
      if (value.compacted === true) compactedPayloads += 1;
      else if (value.tables !== undefined || Array.isArray(value.matches)) {
        fullPayloads += 1;
      }
    }
  }
  assert.equal(fullPayloads, RECENT_TOOL_TURNS_VERBATIM);
  assert.ok(compactedPayloads >= 7);

  // Deterministic.
  const again = projectInRunObservations(messages);
  assert.deepEqual(again.messages, projected.messages);
  assert.equal(again.observationsCompacted, projected.observationsCompacted);
});

test("C7: estimateTokens helper is reused (smoke)", () => {
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("abc") > 0);
});

test("older equivalent reads collapse while mutation results stay visible", () => {
  const messages: ModelMessage[] = [{ role: "user", content: "u" }];
  for (let i = 0; i < 4; i += 1) {
    messages.push(assistantTurn(toolCall(`r${i}`, "document.find", { text: "same" })));
    messages.push(toolTurn(toolResult(`r${i}`, "document.find", largeFindPayload("same", 5))));
  }
  messages.push(assistantTurn(toolCall("m", "document.replace_text")));
  messages.push(toolTurn(toolResult("m", "document.replace_text", { ok: true, versionId: "v2" })));
  const projected = projectInRunObservations(messages);
  assert.equal(resultValue(projected.messages[2]!).superseded, true);
  assert.equal(resultValue(projected.messages.at(-1)!).versionId, "v2");
});
