import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_HISTORY_CHARACTERS,
  MAX_HISTORY_MESSAGES,
  MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS,
  availableEvidenceTokenBudget,
  estimateTokens,
  projectHistoricalMessages,
  safeInputTokenBudget,
  type HistoricalMessage,
} from "./context-projection.js";

const message = (role: HistoricalMessage["role"], content: string): HistoricalMessage => ({ role, content });

test("keeps a short history unchanged and does not mutate it", () => {
  const history = [message("user", "one"), message("assistant", "two")];
  const projected = projectHistoricalMessages(history);
  assert.deepEqual(projected.messages, history);
  assert.notEqual(projected.messages, history);
  assert.equal(projected.historyWasTrimmed, false);
});

test("keeps the recent chronological suffix within both bounds", () => {
  const history = Array.from({ length: MAX_HISTORY_MESSAGES + 2 }, (_, index) =>
    message(index % 2 === 0 ? "user" : "assistant", `message-${index}`),
  );
  const projected = projectHistoricalMessages(history);
  assert.ok(projected.messages.length <= MAX_HISTORY_MESSAGES);
  assert.ok(projected.historicalCharactersProjected <= MAX_HISTORY_CHARACTERS);
  assert.deepEqual(projected.messages, history.slice(-MAX_HISTORY_MESSAGES));
});

test("drops oldest messages when the character budget is full", () => {
  const history = [
    message("user", "a".repeat(MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS)),
    message("assistant", "b".repeat(MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS)),
    message("user", "c".repeat(MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS)),
  ];
  const projected = projectHistoricalMessages(history);
  assert.equal(projected.messages.length, 1);
  assert.deepEqual(projected.messages, history.slice(2));
  assert.ok(projected.historicalCharactersProjected <= MAX_HISTORY_CHARACTERS);
});

test("truncates one huge historical message deterministically", () => {
  const history = [message("user", "x".repeat(MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS + 1))];
  const projected = projectHistoricalMessages(history);
  assert.equal(projected.messages[0]?.content.length, MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS);
  assert.match(projected.messages[0]?.content ?? "", /Historical message truncated for model context/);
  assert.equal(history[0]?.content.length, MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS + 1);
});

test("drops a leading assistant whose user request was omitted", () => {
  const history = [
    message("user", "x".repeat(MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS)),
    message("assistant", "y".repeat(MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS)),
    message("assistant", "z".repeat(MAX_SINGLE_HISTORY_MESSAGE_CHARACTERS)),
  ];
  const projected = projectHistoricalMessages(history);
  assert.deepEqual(projected.messages, []);
});

test("returns an empty projection for empty history", () => {
  assert.deepEqual(projectHistoricalMessages([]).messages, []);
});

test("uses one conservative deterministic token estimate", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abc"), 1);
  assert.equal(estimateTokens("abcdef"), 2);
  assert.equal(estimateTokens("abcdef"), estimateTokens("abcdef"));
  assert.ok(estimateTokens("a".repeat(300)) > estimateTokens("a".repeat(30)));
  assert.equal(safeInputTokenBudget(10_000), 6_000);
  assert.equal(availableEvidenceTokenBudget(10_000, 1_000), 5_000);
  assert.equal(availableEvidenceTokenBudget(10_000, 6_500), 0);
  assert.equal(availableEvidenceTokenBudget(undefined, 1_000), undefined);
});

test("unknown context keeps C1 behavior while a token budget keeps the recent suffix", () => {
  const history = [
    message("user", "old".repeat(100)),
    message("assistant", "middle".repeat(100)),
    message("user", "recent".repeat(100)),
  ];
  assert.deepEqual(
    projectHistoricalMessages(history).messages,
    projectHistoricalMessages(history, {}).messages,
  );
  const projected = projectHistoricalMessages(history, { maxTokens: estimateTokens(history[2]!.content) });
  assert.deepEqual(projected.messages, [history[2]]);
  assert.equal(projected.historyTrimmedByTokenBudget, true);
  assert.ok(projected.estimatedHistoricalTokens <= estimateTokens(history[2]!.content));
});
