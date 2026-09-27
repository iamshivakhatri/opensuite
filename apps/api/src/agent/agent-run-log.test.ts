import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAgentRunBanner,
  formatAgentRunDone,
  formatCompactDuration,
  formatCompactTokens,
  formatModelTurnCompleted,
  formatModelTurnFirstOutput,
  formatModelTurnStarted,
  formatToolFinished,
  formatToolStarted,
  formatValidationChecks,
} from "./agent-run-log.js";
import { shouldLogHttpRequest } from "../dev-log.js";

test("lifecycle helpers format scannable model and tool lines", () => {
  assert.equal(formatModelTurnStarted(1), "[Turn 1]\n→ LLM call started");
  assert.equal(formatModelTurnFirstOutput(420), "  first output 420ms");
  assert.match(
    formatModelTurnCompleted({
      durationMs: 31_600,
      inputTokens: 11_400,
      cachedInputTokens: 0,
      outputTokens: 9_000,
      reasoningTokens: 8_400,
      toolNames: ["document.set_table_cells_text"],
    }),
    /← LLM responded 31\.6s/,
  );
  assert.match(
    formatModelTurnCompleted({
      durationMs: 1_800,
      inputTokens: 19_000,
      cachedInputTokens: 9_900,
      outputTokens: 363,
      reasoningTokens: 0,
      toolNames: [],
    }),
    /no tools · turn complete/,
  );
  assert.equal(formatToolStarted("document.replace_text"), "→ document.replace_text");
  assert.equal(formatToolFinished({ ok: true, durationMs: 113 }), "✓ completed 113ms");
  assert.equal(
    formatToolFinished({ ok: false, durationMs: 5, code: "TABLE_NOT_FOUND" }),
    "✗ TABLE_NOT_FOUND · 5ms",
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
    contextTokens: 2_000,
  });
  assert.match(banner, /AGENT RUN 35c6e573/);
  assert.match(banner, /Target\s+Northstar Launch Report\.docx/);
  assert.match(banner, /Sources\s+September Updates\.docx/);
  assert.match(banner, /Retrieval\s+DIRECT · 2 docs · ~2k context tokens/);
  assert.doesNotMatch(banner, /35c6e573-aaaa/);

  const done = formatAgentRunDone({
    outcome: "success",
    totalDurationMs: 33_500,
    modelTimeMs: 33_400,
    toolTimeMs: 113,
    modelTurns: 2,
    toolCalls: 1,
    persistedVersions: 1,
    costUsd: 0.0175,
  });
  assert.match(done, /DONE ✓ 33\.5s/);
  assert.match(done, /Model\s+33\.4s/);
  assert.match(done, /Tools\s+113ms/);
  assert.match(done, /Cost\s+\$0\.0175/);
});

test("validation formatting uses pass/warn/skip marks", () => {
  const text = formatValidationChecks([
    { status: "pass", message: "Target updated" },
    { status: "warning", message: "Heading structure changed" },
    { status: "skipped", message: "Period check skipped" },
  ]);
  assert.match(text, /^\[Validation\]/);
  assert.match(text, /✓ target updated/);
  assert.match(text, /⚠ heading structure changed/);
  assert.match(text, /– period check skipped/);
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
