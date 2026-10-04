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
import { inspectDocxStyleSnapshot, resolveNativeEngineModuleId } from '@opensuite/engine-client';
import { createDocumentService } from '../documents/service.js';
import { createMemoryObjectStorage } from '../storage/index.js';
import { createStyleProfileService } from './service.js';
import { registerStyleProfileRoutes } from '../routes/style-profiles.js';
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
    const documents = createDocumentService(client.db, storage, { uploadMaxBytes: 20 * 1024 * 1024 });
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
      const bytes = await readFile(new URL(filename, root));
      const uploaded = await documents.createOfficeDocumentFromBytes({ workspaceId: workspace.id, ownerUserId: alice, filename, bytes, source: 'upload' });
      // Add another immutable version, then explicitly learn the original version.
      await documents.appendDocumentVersion({ documentId: uploaded.document.id, ownerUserId: alice, baseVersionId: uploaded.version.id, bytes, source: 'user' });
      const request = { method: 'POST' as const, url: '/api/style-profiles', headers: { 'x-test-user': alice }, payload: { documentId: uploaded.document.id, versionId: uploaded.version.id } };
      const denied = await app.inject({ ...request, headers: { 'x-test-user': bob } });
      assert.equal(denied.statusCode, 404, denied.body);
      assert.equal(inspections, files.indexOf(filename));
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
