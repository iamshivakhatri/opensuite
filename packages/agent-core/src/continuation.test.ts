import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { jsonSchema } from 'ai';
import { defineTool, type AgentContinuation } from './types.js';
import { runAgent } from './run.js';

// Capture the actual provider HTTP body, after both SDK message transformations.
test('Turn 21 wire request is identical across a JSON-persisted continuation', async () => {
  async function scenario(bounded: boolean) {
    let turn = 0;
    let mutations = 0;
    let loaded = false;
    const requests: unknown[] = [];
    const schema = jsonSchema<Record<string, unknown>>({ type: 'object', additionalProperties: true });
    const tools = {
      load: defineTool({ kind: 'read', description: 'Load edit capability', inputSchema: schema, execute: () => { loaded = true; return { loadedIds: ['edit'] }; } }),
      inspect: defineTool({ kind: 'read', description: 'Inspect', inputSchema: schema, execute: () => ({ ok: true, observationId: 'full', text: 'Original document evidence', version: mutations ? 'v2' : 'v1' }) }),
      edit: defineTool({ kind: 'mutate', description: 'Edit', inputSchema: schema, execute: args => {
        if (args.attempt === 'wrong') return { ok: false, reasonCode: 'TARGET_NOT_FOUND' };
        mutations++; return { ok: true, version: 'v2', changes: ['heading'] };
      } }),
    };
    const model = createOpenRouter({ apiKey: 'scripted-only', fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const current = ++turn;
      const name = current === 1 ? 'load' : current === 3 || current === 4 ? 'edit' : 'inspect';
      const args = current === 3 ? { attempt: 'wrong' } : current === 4 ? { attempt: 'correct' } : { observationId: 'full', remaining: 'finish final edit' };
      const delta = current <= 21 ? {
        reasoning_details: [{ type: 'reasoning.text', text: `Exposed reasoning ${current}`, signature: `sig-${current}`, id: `r-${current}`, format: 'anthropic-claude-v1', index: 0 },
          { type: 'reasoning.encrypted', data: `opaque-${current}`, id: `e-${current}`, format: 'openai-responses-v1', index: 1 }],
        tool_calls: [{ index: 0, id: `call-${current}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      } : { content: 'Finished' };
      const chunk = { id: `response-${current}`, object: 'chat.completion.chunk', created: 1, model: 'scripted', choices: [{ index: 0, delta, finish_reason: current <= 21 ? 'tool_calls' : 'stop' }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } })('scripted');
    const input = { model, system: 'Document task', messages: [{ role: 'user' as const, content: 'Earlier request' },
      { role: 'assistant' as const, content: 'Earlier answer' }, { role: 'user' as const, content: 'Original unfinished request with exact doc reference' }], tools,
      projectTools: () => loaded ? tools : { load: tools.load, inspect: tools.inspect } };
    const first = await runAgent({ ...input, maxTurns: bounded ? 20 : 22 });
    if (bounded) {
      assert.equal(first.stopReason, 'max_turns');
      const saved = JSON.parse(JSON.stringify(first.continuation)) as AgentContinuation;
      const resumed = await runAgent({ ...input, messages: saved.messages, continuation: saved, maxTurns: 20 });
      assert.equal(resumed.stopReason, 'completed');
      assert.equal(resumed.inputTokens, 0); // Prior usage was not billed again.
    }
    assert.equal(mutations, 1, 'Replay restores evidence without executing prior mutations');
    return requests[20];
  }
  const uninterrupted = await scenario(false);
  const continued = await scenario(true);
  assert.deepEqual(continued, uninterrupted);
  const wire = JSON.stringify(continued);
  assert.match(wire, /sig-1/);
  assert.match(wire, /opaque-1/);
  assert.match(wire, /TARGET_NOT_FOUND/);
  assert.match(wire, /Original document evidence/);
  assert.match(wire, /Original unfinished request/);
});
