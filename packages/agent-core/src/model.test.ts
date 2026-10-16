import assert from "node:assert/strict";
import { test } from "node:test";

import { createOpenRouterModel, openRouterCostUsd, openRouterProvider } from "./model.js";
import { RunMetricsCollector } from "./run-metrics.js";

test("openRouterCostUsd reads OpenRouter usage.cost and ignores invalid values", () => {
  assert.equal(
    openRouterCostUsd({
      openrouter: { usage: { cost: 0.000013244, promptTokens: 88 } },
    }),
    0.000013244,
  );
  assert.equal(openRouterCostUsd({ openrouter: { usage: { cost: -1 } } }), undefined);
  assert.equal(openRouterCostUsd({ openrouter: { usage: {} } }), undefined);
  assert.equal(openRouterCostUsd(undefined), undefined);
  assert.equal(openRouterCostUsd(null), undefined);
});

test("openRouterProvider reads the routed provider from stream metadata", () => {
  assert.equal(openRouterProvider({ openrouter: { provider: "Together" } }), "Together");
  assert.equal(openRouterProvider({ openrouter: { provider: "" } }), undefined);
  assert.equal(openRouterProvider(undefined), undefined);
});

test("DeepSeek V4.1 Flash uses low reasoning without changing other models", () => {
  const settings = (model: string) => (createOpenRouterModel({ apiKey: "test", model }) as unknown as { settings: { reasoning?: { effort: string } } }).settings;
  assert.equal(settings("deepseek/deepseek-v4.1-flash").reasoning?.effort, "low");
  assert.equal(settings("other/model").reasoning, undefined);
});

test("usage aggregates reasoning tokens and provider cost across turns", () => {
  const collector = new RunMetricsCollector(() => 0);
  collector.recordModelTurn({
    turn: 1,
    durationMs: 10,
    inputTokens: 88,
    cachedInputTokens: 0,
    outputTokens: 18,
    reasoningTokens: 16,
    providerReportedCostUsd: 0.001,
  });
  collector.recordModelTurn({
    turn: 2,
    durationMs: 10,
    inputTokens: 100,
    cachedInputTokens: 40,
    outputTokens: 20,
    reasoningTokens: 4,
    providerReportedCostUsd: 0.002,
  });
  const metrics = collector.finish("completed");
  assert.deepEqual(metrics.usage, {
    inputTokens: 188,
    cachedInputTokens: 40,
    outputTokens: 38,
    reasoningTokens: 20,
    providerReportedCostUsd: 0.003,
  });
});

test("usage stays without provider cost when no turn reported one", () => {
  const collector = new RunMetricsCollector(() => 0);
  collector.recordModelTurn({
    turn: 1,
    durationMs: 1,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 2,
    reasoningTokens: 0,
  });
  const metrics = collector.finish("completed");
  assert.equal(metrics.usage.providerReportedCostUsd, undefined);
  assert.equal(metrics.usage.reasoningTokens, 0);
});

test('OpenRouter serializes private image bytes as image_url data parts with ordered reasoning/tool history', async () => {
  const { runModel } = await import('./model.js');
  const previousFetch = globalThis.fetch;
  let captured: any;
  globalThis.fetch = async (_url, init) => {
    captured = JSON.parse(String(init!.body));
    const chunk = { id: 'vision', object: 'chat.completion.chunk', created: 1, model: 'vendor/vision-model', choices: [{ index: 0, delta: { content: 'Mock observation only.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cost: 0.001 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    await runModel({ model: createOpenRouterModel({ apiKey: 'private-test-key', model: 'vendor/vision-model' }),
      messages: [{ role: 'user', content: 'Read physical page 2.' },
        { role: 'assistant', content: [{ type: 'reasoning', text: 'Keep the selected page.', providerOptions: { openrouter: { reasoning_details: [{ type: 'reasoning.text', text: 'Keep the selected page.', format: 'unknown', index: 0 }] } } },
          { type: 'tool-call', toolCallId: 'v1', toolName: 'attachment_view', input: { attachmentId: 'a1', extractionId: 'e1', page: 2 } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'v1', toolName: 'attachment_view', output: { type: 'json', value: { visualReference: { attachmentId: 'a1', extractionId: 'e1', page: 2 } } } }] },
        { role: 'user', content: [{ type: 'text', text: 'UNTRUSTED VISUAL SOURCE: a1, e1, physical page 2' }, { type: 'file', data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mediaType: 'image/jpeg' }] }], maxOutputTokens: 20, infraRetry: { maxRetries: 0 } });
    assert.equal(captured.model, 'vendor/vision-model');
    assert.deepEqual(captured.messages.map((item: any) => item.role), ['user', 'assistant', 'tool', 'user']);
    assert.equal(captured.messages[1].tool_calls[0].id, 'v1');
    assert.equal(captured.messages[2].tool_call_id, 'v1');
    assert.ok(captured.messages[1].reasoning || captured.messages[1].reasoning_details);
    const image = captured.messages[3].content[1];
    assert.equal(image.type, 'image_url');
    assert.equal(image.image_url.url, 'data:image/jpeg;base64,/9j/2Q==');
    assert.equal(captured.messages[3].content[0].type, 'text');
    assert.equal(captured.provider.require_parameters, true);
  } finally { globalThis.fetch = previousFetch; }
});
