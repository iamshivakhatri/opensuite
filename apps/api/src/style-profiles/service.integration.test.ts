import '../load-env.js';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { createDbClient, schema } from '@opensuite/db';
import { createNapiDocxEngineBinding, inspectDocxStyleSnapshot, resolveNativeEngineModuleId } from '@opensuite/engine-client';
import { createDocumentService } from '../documents/service.js';
import { createMemoryObjectStorage } from '../storage/index.js';
import { createStyleProfileService } from './service.js';
import { registerStyleProfileRoutes } from '../routes/style-profiles.js';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { createAgentExecutionService } from '../agent/execution.js';
import { createAgentPersistenceService } from '../agent/persistence.js';
import { createStyleProfileTools } from '../agent/capabilities/definitions/style-profiles.js';

const enabled = process.env.RUN_STYLE_PROFILE_DB_TESTS === 'true';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('real DOCX learn/save/fresh-process reload, CRUD, exact provenance, ownership, and source safety', { skip: !enabled }, async () => {
  assert.ok(process.env.DATABASE_URL, 'DATABASE_URL is required');
  assert.equal(resolveNativeEngineModuleId().fromEnv, true, 'OPENSUITE_ENGINE_PATH must select the local Phase 1 engine');
  const admin = createDbClient({ databaseUrl: process.env.DATABASE_URL });
  const testSchema = `style_test_${randomUUID().replaceAll('-', '')}`;
  const quoted = `"${testSchema}"`;
  await admin.pool.query(`CREATE SCHEMA ${quoted}`);
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('options', `-c search_path=${testSchema}`);
  const client = createDbClient({ databaseUrl: url.toString() });
  const app = Fastify();
  try {
    // Apply the complete migration chain in an isolated schema, including 0023.
    // Historical migrations qualify public; substitute only that schema identifier.
    const folder = new URL('../../../../packages/db/migrations/', import.meta.url);
    // Source and built paths have the same depth relative to repository root.
    const journal = JSON.parse(await readFile(new URL('meta/_journal.json', folder), 'utf8')) as { entries: { tag: string }[] };
    for (const entry of journal.entries) {
      const sql = (await readFile(new URL(`${entry.tag}.sql`, folder), 'utf8')).replaceAll('"public"', quoted);
      await client.pool.query(sql);
    }
    const alice = `alice-${randomUUID()}`;
    const bob = `bob-${randomUUID()}`;
    await client.db.insert(schema.user).values([{ id: alice, name: 'Alice', email: `${alice}@example.com` }, { id: bob, name: 'Bob', email: `${bob}@example.com` }]);
    const [workspace] = await client.db.insert(schema.workspace).values({ ownerUserId: alice, name: 'Style test' }).returning();
    const [bobWorkspace] = await client.db.insert(schema.workspace).values({ ownerUserId: bob, name: 'Other workspace' }).returning();
    assert.ok(workspace && bobWorkspace);
    const storage = createMemoryObjectStorage();
    const documents = createDocumentService(client.db, storage, { uploadMaxBytes: 20 * 1024 * 1024, createBlankDocxBytes: async () => (await createNapiDocxEngineBinding()).createBlankDocx() });
    let inspections = 0;
    const profiles = createStyleProfileService(client.db, documents, async bytes => { inspections++; return inspectDocxStyleSnapshot(bytes); });
    registerStyleProfileRoutes(app, { api: { getSession: async ({ headers }) => {
      const id = headers.get('x-test-user');
      return id === alice || id === bob ? { user: { id, name: id, email: `${id}@example.com` }, session: {} } : null;
    } } }, profiles);
    const root = new URL('../../../../', import.meta.url);
    const files = ['Blue Harbor Technologies — September 2026 Monthly Operating Report.docx', 'Maya Chen - Resume.docx', 'Scientific Paper Draft - Battery Capacity.docx'];
    const other = await documents.createOfficeDocumentFromBytes({ workspaceId: bobWorkspace.id, ownerUserId: bob, filename: files[0]!, bytes: await readFile(new URL(files[0]!, root)), source: 'upload' });
    for (const filename of files) {
      const inspectionsBefore = inspections;
      const bytes = await readFile(new URL(filename, root));
      const uploaded = await documents.createOfficeDocumentFromBytes({ workspaceId: workspace.id, ownerUserId: alice, filename, bytes, source: 'upload' });
      // Add another immutable version, then explicitly learn the original version.
      await documents.appendDocumentVersion({ documentId: uploaded.document.id, ownerUserId: alice, baseVersionId: uploaded.version.id, bytes, source: 'user' });
      const request = { method: 'POST' as const, url: '/api/style-profiles', headers: { 'x-test-user': alice }, payload: { documentId: uploaded.document.id, versionId: uploaded.version.id } };
      const denied = await app.inject({ ...request, headers: { 'x-test-user': bob } });
      assert.equal(denied.statusCode, 404, denied.body);
      assert.equal(inspections, inspectionsBefore);
      const response = await app.inject(request);
      assert.equal(response.statusCode, 201, response.body);
      const profile = response.json().profile;
      assert.equal(profile.source.versionId, uploaded.version.id);
      assert.equal(profile.source.fileName, filename);
      assert.equal(profile.style.body.text.fontFamily, 'Arial');
      assert.equal(profile.style.body.text.bold, undefined);
      assert.equal(profile.style.page.marginsTwips.left, 1440);
      if (filename.startsWith('Blue')) {
        assert.deepEqual(profile.style.table.headerFills, ['DCE3EA']);
        assert.equal(profile.style.table.cellMarginsTwips.left, 120);
        assert.equal(profile.style.body.paragraph.spacingAfterTwips, 240);
      }
      if (filename.startsWith('Maya')) {
        assert.equal(profile.style.headings[0].paragraph.spacingAfterTwips, 80);
        assert.ok(profile.style.emphasis.some((e: { formatting: { bold?: boolean }; repeated: boolean }) => e.formatting.bold && !e.repeated));
        assert.equal(profile.style.lists[0]?.format, 'bullet');
        assert.equal(profile.style.lists[0]?.count, 3);
        assert.equal(profile.style.lists[0]?.leftIndentTwips, 720);
      }
      if (filename.startsWith('Scientific')) {
        assert.ok(profile.style.headings.some((h: { level: number }) => h.level === 2));
        assert.equal(profile.style.title, undefined);
        assert.equal(profile.style.headersFooters.present, false);
      }
      assert.equal(hash(await documents.readExactVersionBytes({ documentId: uploaded.document.id, versionId: uploaded.version.id, ownerUserId: alice })), hash(bytes));
      assert.equal((await documents.listVersions({ documentId: uploaded.document.id, ownerUserId: alice })).length, 2);
      // A fresh Node process and pool: no parent service or run-local state.
      const script = `import { createDbClient } from ${JSON.stringify(new URL('../../../../packages/db/dist/index.js', import.meta.url).href)};
        import { createStyleProfileService } from ${JSON.stringify(new URL('./service.js', import.meta.url).href)};
        const c=createDbClient({databaseUrl:process.env.STYLE_TEST_DATABASE_URL});
        try {const p=await createStyleProfileService(c.db, {}).get(process.env.STYLE_TEST_OWNER, process.env.STYLE_TEST_ID);console.log(JSON.stringify(p));} finally {await c.close();}`;
      const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, STYLE_TEST_DATABASE_URL: url.toString(), STYLE_TEST_OWNER: alice, STYLE_TEST_ID: profile.id } });
      assert.deepEqual(JSON.parse(child.stdout), profile);
      for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
        const deniedProfile = await app.inject({ method, url: `/api/style-profiles/${profile.id}`, headers: { 'x-test-user': bob }, ...(method === 'PATCH' ? { payload: { name: 'Stolen' } } : {}) });
        assert.equal(deniedProfile.statusCode, 404, deniedProfile.body);
      }
      const renamed = await app.inject({ method: 'PATCH', url: `/api/style-profiles/${profile.id}`, headers: { 'x-test-user': alice }, payload: { name: 'Renamed' } });
      assert.equal(renamed.statusCode, 200);
      assert.equal(renamed.json().profile.name, 'Renamed');
      assert.deepEqual(renamed.json().profile.style, profile.style);
      const tools = createStyleProfileTools({ profiles, ownerUserId: alice, workspaceId: bobWorkspace.id, currentDocument: () => ({ documentId: uploaded.document.id, versionId: uploaded.version.id, dirty: false }) });
      await assert.rejects(() => Promise.resolve(tools['style.learn_from_document']!.execute!({}, {} as never)), /workspace/);
      const invalidVersion = await app.inject({ ...request, payload: { documentId: uploaded.document.id, versionId: randomUUID() } });
      assert.equal(invalidVersion.statusCode, 404);
      const wrongDocumentVersion = await app.inject({ ...request, payload: { documentId: uploaded.document.id, versionId: other.version.id } });
      assert.equal(wrongDocumentVersion.statusCode, 404);
      if (filename.startsWith('Blue')) {
        // Replay the actual prompt and name-only arguments through the real V3
        // tool loop, real document service, local engine, and PostgreSQL.
        // The scripted model never makes a paid/network model request.
        const binding = await createNapiDocxEngineBinding();
        const persistence = createAgentPersistenceService(client.db);
        const thread = await persistence.createThread({ workspaceId: workspace.id, ownerUserId: alice, createdByUserId: alice, title: 'Style learning regression' });
        const current = await documents.getOwnedDocument({ documentId: uploaded.document.id, ownerUserId: alice });
        const versionCount = (await documents.listVersions({ documentId: current.id, ownerUserId: alice })).length;
        const runPrompt = async (instruction: string, toolName: string, args: Record<string, unknown>) => {
          let turn = 0;
          const model = new MockLanguageModelV4({ doStream: async options => {
            const context = JSON.stringify(options.prompt);
            assert.equal(context.includes('runPatterns'), false);
            assert.equal(context.includes('paragraphPatterns'), false);
            if (turn === 0 && toolName === 'style.learn_from_document') assert.ok(context.includes('- style.learn_from_document (tool)'), 'Learning should be recommended for the actual prompt');
            if (turn === 2) assert.ok(context.includes('Blue Harbor Operating Report Style'), 'The saved profile should appear in the learn/list/get result');
            const calls = [
              { name: 'capabilities_load', input: { ids: [toolName] } },
              { name: toolName.replaceAll('.', '_'), input: args },
              { name: 'finish', input: {} },
            ];
            const call = calls[turn++];
            assert.ok(call, 'No extra model turns or hidden retries');
            return { stream: simulateReadableStream({ chunks: [
              { type: 'stream-start', warnings: [] },
              ...(turn === 3 ? [{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'Completed style request.' }, { type: 'text-end', id: 'answer' }] : []),
              { type: 'tool-call', toolCallId: `style-${turn}`, toolName: call.name, input: JSON.stringify(call.input) },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
            ] as never[] }) };
          } });
          const execution = createAgentExecutionService({ persistence, documents, styleProfiles: profiles, docxBinding: binding, resolveModel: async () => ({ model }) });
          const result = await (await execution.start({ userId: alice, threadId: thread.id, activeDocumentId: current.id, instruction })).result;
          assert.equal(result.run.status, 'completed', result.run.errorMessage ?? 'Run failed');
          const steps = await client.db.select().from(schema.agentStep).where(eq(schema.agentStep.runId, result.run.id));
          assert.equal(steps.filter(step => step.status === 'failed').length, 0);
          assert.equal(steps.filter(step => step.name === toolName && step.status === 'completed').length, 1);
          assert.equal(turn, 3);
          assert.equal((await documents.listVersions({ documentId: current.id, ownerUserId: alice })).length, versionCount);
          assert.equal(hash(await documents.readExactVersionBytes({ documentId: current.id, versionId: current.latestVersion.id, ownerUserId: alice })), hash(bytes));
          return result;
        };
        const learned = await runPrompt('Learn the document style from this document and save it for future use.', 'style.learn_from_document', { name: 'Blue Harbor Operating Report Style' });
        assert.equal(learned.run.baseDocumentVersionId, current.latestVersion.id);
        const saved = (await profiles.list(alice)).find(profile => profile.name === 'Blue Harbor Operating Report Style');
        assert.ok(saved);
        const exact = await profiles.get(alice, saved.id);
        assert.equal(exact.source.documentId, current.id);
        assert.equal(exact.source.versionId, current.latestVersion.id);
        assert.deepEqual(exact.style, profile.style);
        await runPrompt('Tell me all the styles I have saved.', 'style.list_profiles', {});
        await runPrompt('Retrieve the Blue Harbor Operating Report Style profile.', 'style.get_profile', { id: saved.id });
        const { styleProfileSummary } = await import('./service.js');
        assert.ok(JSON.stringify(styleProfileSummary(exact)).length < 6000);
        // Saved profile → newly created content → deterministic apply → one run-boundary save.
        const runApplication = async (existingId?: string) => {
          let turn = 0;
          const calls = [
            { name: 'capabilities_load', input: { ids: ['style.list_profiles', 'style.get_profile', 'style.apply_profile'] } },
            { name: 'style_list_profiles', input: {} },
            { name: 'style_get_profile', input: { id: saved.id } },
            ...(existingId ? [{ name: 'workspace_select_document', input: { documentId: existingId } }] : [
              { name: 'workspace_create_blank_document', input: { title: 'Cincinnati Sports Club — October Newsletter' } },
              { name: 'document_insert_paragraphs', input: { texts: ['Cincinnati Sports Club — October Newsletter', 'Sample club newsletter. Events are test data.', 'Club News', 'Practice is scheduled for October 12.'], placement: { kind: 'end' } } },
              { name: 'document_set_paragraph_style', input: { target: { text: 'Cincinnati Sports Club — October Newsletter' }, style: 'Title' } },
              { name: 'document_set_paragraph_style', input: { target: { text: 'Club News' }, style: 'Heading 1' } },
              { name: 'document_create_table', input: { rows: [['Activity', 'Test date'], ['Practice', 'October 12']], placement: { kind: 'end' } } },
            ]),
            { name: 'style_apply_profile', input: { id: saved.id } },
            { name: 'finish', input: {} },
          ];
          const model = new MockLanguageModelV4({ doStream: async options => {
            const context = JSON.stringify(options.prompt);
            assert.doesNotMatch(context, /runPatterns|paragraphPatterns|STYLE PACK:/);
            if (!turn) for (const id of ['style.list_profiles', 'style.get_profile', 'style.apply_profile']) assert.ok(context.includes(`- ${id} (tool)`));
            if (turn === calls.length - 1) { assert.match(context, /matched/); assert.match(context, /Blue Harbor Operating Report Style/); }
            const call = calls[turn++];
            assert.ok(call, 'Normal saved-style path requires no search/list recovery or retry');
            return { stream: simulateReadableStream({ chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-call', toolCallId: `apply-${turn}`, toolName: call.name, input: JSON.stringify(call.input) },
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
            ] as never[] }) };
          } });
          const execution = createAgentExecutionService({ persistence, documents, styleProfiles: profiles, docxBinding: binding, resolveModel: async () => ({ model }) });
          const applied = await (await execution.start({ userId: alice, threadId: thread.id, activeDocumentId: current.id, instruction: existingId ? 'Use my saved Blue Harbor Operating Report Style on the selected newsletter.' : 'Create a newsletter using my saved Blue Harbor Operating Report Style.' })).result;
          assert.equal(applied.run.status, 'completed', applied.run.errorMessage ?? 'Run failed');
          const steps = await client.db.select().from(schema.agentStep).where(eq(schema.agentStep.runId, applied.run.id));
          assert.equal(steps.filter(step => step.status === 'failed').length, 0, JSON.stringify(steps));
          assert.deepEqual(steps.filter(step => step.name.startsWith('capabilities.')).map(step => step.name), ['capabilities.load']);
          for (const name of ['style.list_profiles', 'style.get_profile', 'style.apply_profile']) assert.equal(steps.filter(step => step.name === name && step.status === 'completed').length, 1);
          assert.equal(turn, calls.length);
          const target = existingId ? await documents.getOwnedDocument({ documentId: existingId, ownerUserId: alice }) : (await documents.listInWorkspace(workspace.id, alice)).find(doc => doc.name === 'Cincinnati Sports Club — October Newsletter.docx');
          assert.ok(target);
          const targetVersions = await documents.listVersions({ documentId: target.id, ownerUserId: alice });
          assert.equal(targetVersions.length, existingId ? 3 : 2, 'One immutable save per application run');
          const targetBytes = await documents.readExactVersionBytes({ documentId: target.id, versionId: target.latestVersion.id, ownerUserId: alice });
          const { buildStyleApplicationPlan } = await import('./application.js');
          const { compareStyleFidelity } = await import('./fidelity.js');
          const fidelity = compareStyleFidelity(buildStyleApplicationPlan(exact.style), await inspectDocxStyleSnapshot(targetBytes, binding));
          assert.equal(fidelity.summary.counts.mismatched, 0, JSON.stringify(fidelity));
          assert.equal(fidelity.summary.counts.matched, 27);
          const content = await binding.inspectDocx(targetBytes, { focus: { kind: 'paragraphs', limit: 100 } });
          assert.deepEqual(content.paragraphs?.items.map(p => p.text), ['Cincinnati Sports Club — October Newsletter', 'Sample club newsletter. Events are test data.', 'Club News', 'Practice is scheduled for October 12.']);
          assert.equal((await documents.listVersions({ documentId: current.id, ownerUserId: alice })).length, versionCount);
          assert.equal(hash(await documents.readExactVersionBytes({ documentId: current.id, versionId: current.latestVersion.id, ownerUserId: alice })), hash(bytes));
          console.log(`Blue Harbor saved-profile application (${existingId ? 'existing' : 'new'} target):`, JSON.stringify(fidelity.summary));
          return target.id;
        };
        const targetId = await runApplication();
        await runApplication(targetId);
        await profiles.delete(alice, saved.id);
        console.log('Blue Harbor real-agent-loop replay: one successful learn call, list/get successful, no source versions changed, no paid model calls');
      }
      const removed = await app.inject({ method: 'DELETE', url: `/api/style-profiles/${profile.id}`, headers: { 'x-test-user': alice } });
      assert.equal(removed.statusCode, 204);
      await assert.rejects(() => profiles.get(alice, profile.id), /not found/);
      console.log(JSON.stringify({ document: filename, body: profile.style.body, headings: profile.style.headings.map((h: { level: number }) => h.level), lists: profile.style.lists, table: profile.style.table, persistedAcrossProcess: true }));
    }
    const sample = await documents.getOwnedDocument({ documentId: (await documents.listInWorkspace(workspace.id, alice))[0]!.id, ownerUserId: alice });
    const latest = await profiles.learnFromDocument({ documentId: sample.id, ownerUserId: alice });
    assert.equal(latest.source.versionId, sample.latestVersion.id);
    assert.equal((await profiles.list(alice, 1)).length, 1);
    assert.equal((await profiles.list(alice, 1, 1)).length, 0);
    assert.deepEqual(await profiles.list(bob), []);
    assert.equal((await app.inject({ method: 'GET', url: '/api/style-profiles' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/style-profiles/not-an-id', headers: { 'x-test-user': alice } })).statusCode, 400);
    await client.db.update(schema.workspace).set({ deletedAt: new Date() }).where(eq(schema.workspace.id, workspace.id));
    await assert.rejects(() => profiles.learnFromDocument({ documentId: sample.id, ownerUserId: alice }), /not found/);
    // Personal profiles remain useful after source trash/restore/history deletion.
    assert.equal((await profiles.get(alice, latest.id)).source.versionId, latest.source.versionId);
  } finally {
    await app.close();
    await client.close();
    await admin.pool.query(`DROP SCHEMA ${quoted} CASCADE`);
    await admin.close();
  }
});
