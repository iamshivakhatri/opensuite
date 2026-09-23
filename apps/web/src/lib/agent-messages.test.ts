import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  mergeMessagePage,
  messageTaggedDocuments,
  presentationStepsForAssistantMessage,
  prependOlderMessages,
  shouldClearLiveTranscript,
} from "./agent-messages.ts";
import type { AgentMessage, AgentStep, ListedDocument } from "./api.ts";

function msg(
  id: string,
  createdAt: string,
  role: AgentMessage["role"] = "user",
): AgentMessage {
  return { id, role, content: `content-${id}`, createdAt };
}

function step(
  id: string,
  kind: AgentStep["kind"],
  name: string,
  summary: string | null = null,
  sequence = 0,
): AgentStep {
  return {
    id,
    sequence,
    kind,
    status: "completed",
    name,
    summary,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };
}

/** Rendered assistant answer bodies: durable narration entries + message content. */
function renderedAssistantBodies(
  steps: readonly AgentStep[],
  messageContent: string,
): string[] {
  const visible = presentationStepsForAssistantMessage(steps, messageContent.length > 0);
  const fromSteps = visible
    .filter((entry) => entry.kind === "narration" && entry.summary)
    .map((entry) => entry.summary as string);
  return messageContent.length > 0 ? [...fromSteps, messageContent] : fromSteps;
}

describe("mergeMessagePage (C6 initial/live page merge)", () => {
  it("appends a fresh latest page to an empty transcript in chronological order", () => {
    const merged = mergeMessagePage([], [
      msg("a", "2026-01-01T00:00:00.000Z"),
      msg("b", "2026-01-01T00:00:01.000Z", "assistant"),
    ]);
    assert.deepEqual(merged.map((m) => m.id), ["a", "b"]);
  });

  it("drops stale optimistic local- entries once the durable page arrives", () => {
    const prev = [
      msg("a", "2026-01-01T00:00:00.000Z"),
      { ...msg("local-999", "2026-01-01T00:00:02.000Z"), id: "local-999" },
    ];
    const merged = mergeMessagePage(prev, [
      msg("a", "2026-01-01T00:00:00.000Z"),
      msg("b", "2026-01-01T00:00:01.000Z", "assistant"),
    ]);
    assert.deepEqual(merged.map((m) => m.id), ["a", "b"]);
  });

  it("does not duplicate ids present in both prev (older pages) and incoming", () => {
    const prev = [
      msg("earlier-1", "2025-12-31T00:00:00.000Z"),
      msg("a", "2026-01-01T00:00:00.000Z"),
    ];
    const merged = mergeMessagePage(prev, [
      msg("a", "2026-01-01T00:00:00.000Z"),
      msg("b", "2026-01-01T00:00:01.000Z", "assistant"),
    ]);
    assert.deepEqual(merged.map((m) => m.id), ["earlier-1", "a", "b"]);
  });

  it("preserves already-loaded older pages when a newer live page arrives", () => {
    const prev = [
      msg("older-1", "2025-12-01T00:00:00.000Z"),
      msg("older-2", "2025-12-02T00:00:00.000Z"),
      msg("a", "2026-01-01T00:00:00.000Z"),
    ];
    const merged = mergeMessagePage(prev, [
      msg("a", "2026-01-01T00:00:00.000Z"),
      msg("new-live", "2026-01-02T00:00:00.000Z", "assistant"),
    ]);
    assert.deepEqual(
      merged.map((m) => m.id),
      ["older-1", "older-2", "a", "new-live"],
    );
  });
});

describe("prependOlderMessages (C6 load-earlier)", () => {
  it("prepends an older page ahead of the current transcript", () => {
    const prev = [msg("c", "2026-01-03T00:00:00.000Z")];
    const older = [
      msg("a", "2026-01-01T00:00:00.000Z"),
      msg("b", "2026-01-02T00:00:00.000Z"),
    ];
    const result = prependOlderMessages(prev, older);
    assert.deepEqual(result.map((m) => m.id), ["a", "b", "c"]);
  });

  it("does not duplicate ids already present in the transcript", () => {
    const prev = [msg("b", "2026-01-02T00:00:00.000Z"), msg("c", "2026-01-03T00:00:00.000Z")];
    const older = [msg("a", "2026-01-01T00:00:00.000Z"), msg("b", "2026-01-02T00:00:00.000Z")];
    const result = prependOlderMessages(prev, older);
    assert.deepEqual(result.map((m) => m.id), ["a", "b", "c"]);
  });

  it("returns prev unchanged when older page is empty", () => {
    const prev = [msg("a", "2026-01-01T00:00:00.000Z")];
    const result = prependOlderMessages(prev, []);
    assert.deepEqual(result, prev);
  });
});

it("keeps submitted document tags on only their historical message", () => {
  const documents = [
    { id: "b", name: "B.docx" },
    { id: "c", name: "C.docx" },
  ] as ListedDocument[];
  const tagged = { ...msg("tagged", "2026-01-01T00:00:00.000Z"), documentIds: ["b", "c"] };
  assert.deepEqual(messageTaggedDocuments(tagged, documents).map((document) => document.name), ["B.docx", "C.docx"]);
  assert.deepEqual(messageTaggedDocuments(msg("plain", "2026-01-01T00:00:01.000Z"), documents), []);
});

describe("assistant transcript reconciliation (finish narration vs message)", () => {
  it("A: one-turn final answer renders Hello world exactly once", () => {
    const steps = [
      step("n1", "narration", "Assistant narration", "Hello world", 0),
      step("f1", "tool", "finish", "Completed", 1),
    ];
    assert.deepEqual(renderedAssistantBodies(steps, "Hello world"), ["Hello world"]);
  });

  it("B: tool run keeps mid narration and final message without duplicating the answer", () => {
    const steps = [
      step("n1", "narration", "Assistant narration", "I'll inspect the document.", 0),
      step("i1", "inspect", "document.inspect", "Completed", 1),
      step("n2", "narration", "Assistant narration", "Done.", 2),
      step("f1", "tool", "finish", "Completed", 3),
    ];
    assert.deepEqual(renderedAssistantBodies(steps, "Done."), [
      "I'll inspect the document.",
      "Done.",
    ]);
    const visible = presentationStepsForAssistantMessage(steps, true);
    assert.deepEqual(
      visible.map((entry) => entry.name),
      ["Assistant narration", "document.inspect", "finish"],
    );
  });

  it("C: finish tool omits only the narration immediately before finish", () => {
    const steps = [
      step("n1", "narration", "Assistant narration", "Final answer body", 0),
      step("f1", "tool", "finish", "Completed", 1),
    ];
    const visible = presentationStepsForAssistantMessage(steps, true);
    assert.deepEqual(
      visible.map((entry) => [entry.kind, entry.name]),
      [["tool", "finish"]],
    );
    assert.deepEqual(renderedAssistantBodies(steps, "Final answer body"), ["Final answer body"]);
  });

  it("D: refetch after completion clears live once durable assistant content exists", () => {
    assert.equal(
      shouldClearLiveTranscript({ hasAssistantContent: true, runIsTerminal: false }),
      true,
    );
    assert.equal(
      shouldClearLiveTranscript({ hasAssistantContent: false, runIsTerminal: false }),
      false,
    );
  });

  it("E: page reload with persisted steps still shows the answer once", () => {
    // Same identity rule as live completion — reload rehydrates steps + message.
    const steps = [
      step("n1", "narration", "Assistant narration", "Persisted answer", 0),
      step("f1", "tool", "finish", "Completed", 1),
    ];
    assert.deepEqual(renderedAssistantBodies(steps, "Persisted answer"), ["Persisted answer"]);
  });

  it("F: failed/cancelled runs keep narration when there is no assistant message", () => {
    const steps = [
      step("n1", "narration", "Assistant narration", "Partial progress", 0),
      step("t1", "tool", "document.replace_text", "Failed", 1),
    ];
    assert.deepEqual(
      presentationStepsForAssistantMessage(steps, false).map((entry) => entry.summary),
      ["Partial progress", "Failed"],
    );
    assert.equal(
      shouldClearLiveTranscript({ hasAssistantContent: false, runIsTerminal: true }),
      true,
    );
  });

  it("keeps sequential assistant turns independent (no cross-message collapse)", () => {
    const first = renderedAssistantBodies(
      [step("n1", "narration", "Assistant narration", "First", 0), step("f1", "tool", "finish", "Completed", 1)],
      "First",
    );
    const second = renderedAssistantBodies(
      [step("n2", "narration", "Assistant narration", "Second", 0), step("f2", "tool", "finish", "Completed", 1)],
      "Second",
    );
    assert.deepEqual(first, ["First"]);
    assert.deepEqual(second, ["Second"]);
  });
});
