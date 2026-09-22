import assert from "node:assert/strict";
import { test } from "node:test";

import type { ModelMessage } from "@opensuite/agent-core-v3";

import { estimateTokens } from "./context-projection.js";
import { composeProjectMessages, firstTurnContextProjection } from "./execution.js";
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

test("C7 + Phase 6: first-turn retrieval appears once; later turns only apply C7", () => {
  const stats = createInRunObservationStats();
  const tools = {
    "document.inspect": { kind: "read" as const, description: "i", inputSchema: {} },
    "document.find": { kind: "read" as const, description: "f", inputSchema: {} },
    "document.replace_text": { kind: "mutate" as const, description: "m", inputSchema: {} },
  };
  const project = composeProjectMessages({
    retrievalMessage: "Relevant document structure:\n- Table t0",
    tools: tools as never,
    stats,
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
  assert.ok(!JSON.stringify(turn2).includes("Relevant document structure"));
  assert.equal(resultValue(turn2[2]!).compacted, true);
  assert.ok(stats.observationsCompacted >= 1);
});

test("firstTurnContextProjection still injects once", () => {
  const project = firstTurnContextProjection("Relevant document structure:\n- Table t0");
  const messages = [{ role: "user" as const, content: "Add milestones" }];
  assert.equal(project(messages).length, 2);
  assert.deepEqual(project(messages), messages);
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
