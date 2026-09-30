import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAgentRunBanner,
  formatAgentRunDone,
  formatCompactDuration,
  formatCompactTokens,
  formatDocumentSaved,
  formatModelTurnCompleted,
  formatModelTurnFirstStreamPart,
  formatModelTurnStarted,
  formatToolFinished,
  formatValidationChecks,
} from "./agent-run-log.js";
import { shouldLogHttpRequest } from "../dev-log.js";

test("lifecycle helpers format scannable model and tool lines", () => {
  assert.equal(
    formatModelTurnStarted({ turn: 1, model: "deepseek/deepseek-v4.1-flash" }),
    "[agent] TURN 1\n  → LLM start\n  model=deepseek/deepseek-v4.1-flash",
  );
  assert.match(formatModelTurnStarted({ turn: 1, model: "test", maxOutputTokens: 8_192 }), /model=test cap=8192/);
  assert.match(formatModelTurnCompleted({
    turn: 1, durationMs: 1, inputTokens: 1, cachedInputTokens: 0,
    outputTokens: 8_192, reasoningTokens: 8_000,
    toolNames: ["document.inspect", "document.find"], finishReason: "length",
  }), /finish=length[\s\S]*discardedTools=2/);
  assert.equal(
    formatModelTurnFirstStreamPart({ turn: 1, kind: "reasoning", elapsedMs: 420 }),
    "[agent] TURN 1\n  … reasoning 420ms",
  );
  const done = formatModelTurnCompleted({
    turn: 1,
    durationMs: 31_600,
    inputTokens: 11_400,
    cachedInputTokens: 0,
    outputTokens: 9_000,
    reasoningTokens: 8_400,
    toolNames: ["document.set_table_cells_text"],
    finishReason: "tool-calls",
    sawStreamPart: true,
  });
  assert.match(done, /\[agent\] TURN 1/);
  assert.match(done, /← LLM done 31\.6s/);
  assert.match(done, /finish=tool-calls/);
  assert.match(done, /input=11\.4k cached=0/);
  assert.match(done, /output=9k reasoning=8\.4k/);
  assert.match(done, /tools=1 \[document\.set_table_cells_text\]/);
  assert.match(
    formatModelTurnCompleted({
      turn: 2,
      durationMs: 1_800,
      inputTokens: 19_000,
      cachedInputTokens: 9_900,
      outputTokens: 363,
      reasoningTokens: 0,
      toolNames: [],
      finishReason: "stop",
      sawStreamPart: false,
    }),
    /tools=0 \(none\)/,
  );
  assert.match(
    formatModelTurnCompleted({
      turn: 2,
      durationMs: 1_800,
      inputTokens: 19_000,
      cachedInputTokens: 9_900,
      outputTokens: 363,
      reasoningTokens: 0,
      toolNames: [],
      finishReason: "stop",
      sawStreamPart: false,
    }),
    /streaming=no/,
  );
  assert.equal(
    formatToolFinished({ toolName: "document.inspect", ok: true, durationMs: 26 }),
    "[agent] TOOL document.inspect ✓ 26ms",
  );
  assert.equal(
    formatToolFinished({
      toolName: "document.set_table_cells_text",
      ok: false,
      durationMs: 18,
      code: "TABLE_NOT_FOUND",
    }),
    "[agent] TOOL document.set_table_cells_text ✗ TABLE_NOT_FOUND 18ms",
  );
});

test("run banner and DONE summary stay compact and name-based", () => {
  const banner = formatAgentRunBanner({
    runId: "35c6e573-aaaa-bbbb-cccc-dddddddddddd",
    model: "deepseek/deepseek-v4.1-flash",
    target: "Northstar Launch Report.docx",
    sources: ["September Updates.docx"],
    retrievalMode: "direct",
    documentCount: 2,
    contextTokens: 3_100,
  });
  assert.match(banner, /\[agent\] RETRIEVAL DIRECT · 2 docs · ~3\.1k ctx/);
  assert.match(banner, /model=deepseek\/deepseek-v4\.1-flash/);
  assert.match(banner, /target=Northstar Launch Report\.docx/);
  assert.match(banner, /sources=September Updates\.docx/);
  assert.doesNotMatch(banner, /35c6e573-aaaa/);

  assert.equal(
    formatDocumentSaved("Atlas ERP.xlsx", 3),
    "[agent] SAVE Atlas ERP.xlsx → v3",
  );

  const done = formatAgentRunDone({
    outcome: "success",
    totalDurationMs: 151_500,
    modelTimeMs: 151_000,
    toolTimeMs: 510,
    modelTurns: 7,
    toolCalls: 14,
    toolErrors: 1,
    persistedVersions: 1,
    inputTokens: 304_000,
    cachedInputTokens: 240_000,
    outputTokens: 36_000,
    costUsd: 0.0642,
  });
  assert.match(done, /\[agent\] DONE 151\.5s/);
  assert.match(done, /model=151\.0s tools=510ms/);
  assert.match(done, /turns=7 toolCalls=14 errors=1 versions=1/);
  assert.match(done, /input=304k cached=240k output=36k cost=\$0\.0642/);
});

test("validation formatting uses pass/warn/skip marks on one line", () => {
  const text = formatValidationChecks([
    { id: "target", status: "pass", message: "Target updated" },
    { id: "sources", status: "pass", message: "Source documents unchanged" },
    { id: "period", status: "warning", message: "stale-period remains" },
  ]);
  assert.equal(text, "[agent] VALIDATION ✓ target ✓ sources ⚠ period");
});

test("compact token and duration helpers", () => {
  assert.equal(formatCompactTokens(363), "363");
  assert.equal(formatCompactTokens(11_400), "11.4k");
  assert.equal(formatCompactDuration(113), "113ms");
  assert.equal(formatCompactDuration(1_800), "1.8s");
});

test("HTTP request log filter suppresses routine agent polls", () => {
  assert.equal(
    shouldLogHttpRequest({
      method: "GET",
      path: "/api/agent/runs/abc/events",
      statusCode: 200,
    }),
    false,
  );
  assert.equal(
    shouldLogHttpRequest({
      method: "GET",
      path: "/api/agent/runs/abc/working-document",
      statusCode: 200,
    }),
    false,
  );
  assert.equal(
    shouldLogHttpRequest({
      method: "GET",
      path: "/api/agent/threads/t1/messages",
      statusCode: 200,
    }),
    false,
  );
  assert.equal(
    shouldLogHttpRequest({
      method: "GET",
      path: "/api/agent/runs/abc/events",
      statusCode: 500,
    }),
    true,
  );
  assert.equal(
    shouldLogHttpRequest({
      method: "POST",
      path: "/api/agent/threads/t1/runs",
      statusCode: 200,
    }),
    true,
  );
});
