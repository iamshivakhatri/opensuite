import assert from 'node:assert/strict';
import test from 'node:test';
import { createRunEventHandler, createTranscriptCollector } from './run-events.js';

test('tool failures include a bounded, single-line reason alongside the generic status', async () => {
  const lines: string[] = [];
  const original = console.info;
  console.info = line => { lines.push(String(line)); };
  try {
    const handler = createRunEventHandler({ runId: 'run', messageId: 'message', modelLabel: 'test', transcript: createTranscriptCollector() });
    await handler({ type: 'tool_failed', toolName: 'document.inspect', toolCallId: 'call', error: 'Cannot read DOCX: missing main part\n' + 'x'.repeat(600) });
    assert.match(lines[0]!, /TOOL_FAILED/);
    assert.match(lines[1]!, /TOOL-DETAIL document.inspect.*Cannot read DOCX: missing main part/);
    assert.equal(lines[1]!.includes('\n'), false);
    assert.ok(lines[1]!.length < 500);
  } finally {
    console.info = original;
  }
});
