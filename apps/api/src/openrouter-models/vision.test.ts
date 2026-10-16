import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openRouterAcceptsImages } from './vision.js';

test('vision capabilities inspect actual endpoint model modalities and tool support; unknown routes fail closed', async () => {
  for (const [modalities, endpoints, tools, expected] of [
    [['text', 'image'], [{ status: 0, supported_parameters: ['tools'] }], true, true],
    [['text'], [{ status: 0, supported_parameters: ['tools'] }], true, false],
    [undefined, [{ status: 0, supported_parameters: ['tools'] }], true, false],
    [['text', 'image'], [], true, false],
    [['text', 'image'], [{ status: 1, supported_parameters: ['tools'] }], true, false],
    [['text', 'image'], [{ status: 0, supported_parameters: [] }], true, false],
    [['text', 'image'], [{ status: 0, supported_parameters: [] }], false, true],
    [['text', 'image'], [{ status: 0, input_modalities: ['text'], supported_parameters: ['tools'] }], true, false],
  ] as const) {
    const captured: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => { captured.push(String(url)); assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer same-selected-key'); return Response.json({ data: { architecture: { input_modalities: modalities }, endpoints } }); };
    assert.equal(await openRouterAcceptsImages('vendor/selected-model', 'same-selected-key', tools, fetchImpl), expected);
    assert.deepEqual(captured, ['https://openrouter.ai/api/v1/models/vendor/selected-model/endpoints']);
  }
  assert.equal(await openRouterAcceptsImages('vendor/model', 'key', true, async () => { throw new Error('unavailable'); }), false);
  assert.equal(await openRouterAcceptsImages('vendor/model', 'key', true, async () => new Response('', { status: 403 })), false);
  assert.equal(await openRouterAcceptsImages('https://untrusted', 'key', true, async () => { throw new Error('must not fetch'); }), false);
});

test('vision reader configuration keeps BYOK/managed selection and selected key; no automatic reader or cross-source fallback', async () => {
  const { resolveOpenRouterVision } = await import('./vision.js');
  for (const credentialSource of ['managed', 'byok'] as const) {
    const requests: string[] = [];
    const resolved = { provider: 'openrouter' as const, model: 'deepseek/text-only', credentialSource, apiKey: `${credentialSource}-selected-key` };
    const fetchImpl: typeof fetch = async (url, init) => {
      assert.equal((init!.headers as Record<string, string>).Authorization, `Bearer ${resolved.apiKey}`);
      requests.push(String(url));
      return Response.json({ data: { architecture: { input_modalities: String(url).includes('text-only') ? ['text'] : ['text', 'image'] }, endpoints: [{ status: 0, supported_parameters: [] }] } });
    };
    const route = await resolveOpenRouterVision({ resolved, managedReader: 'configured/managed-reader', byokReader: 'configured/byok-reader', fetchImpl });
    assert.equal(route.direct, false);
    assert.equal(route.reader!.usageAttribution!.model, `configured/${credentialSource}-reader`);
    assert.equal(route.reader!.usageAttribution!.credentialSource, credentialSource);
    assert.equal(requests.length, 2);
    const unavailable = await resolveOpenRouterVision({ resolved, ...(credentialSource === 'managed' ? { byokReader: 'not/permitted' } : { managedReader: 'not/permitted' }), fetchImpl });
    assert.deepEqual(unavailable, { direct: false });
  }
});
