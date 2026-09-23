import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mergeMessagePage, messageTaggedDocuments, prependOlderMessages } from "./agent-messages.ts";
import type { AgentMessage, ListedDocument } from "./api.ts";

function msg(
  id: string,
  createdAt: string,
  role: AgentMessage["role"] = "user",
): AgentMessage {
  return { id, role, content: `content-${id}`, createdAt };
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
