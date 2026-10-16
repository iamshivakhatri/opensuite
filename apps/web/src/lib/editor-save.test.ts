import assert from 'node:assert/strict';
import test from 'node:test';
import { createEditorSaveState } from './editor-save.ts';

test('edits made during an upload stay dirty and concurrent saves share one write', async () => {
  const state = createEditorSaveState();
  state.changed();
  let finish!: () => void;
  let writes = 0;
  const write = async () => { writes++; await new Promise<void>(resolve => { finish = resolve; }); };
  const first = state.save(write);
  const second = state.save(write);
  await Promise.resolve();
  const exportRevision = state.revision;
  state.changed();
  assert.notEqual(state.revision, exportRevision);
  finish();
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(writes, 1);
  assert.equal(state.isDirty(), true);
  await state.save(async () => { writes++; });
  assert.equal(writes, 2);
  assert.equal(state.isDirty(), false);
});

test('failed exports and uploads keep edits available for retry', async () => {
  const state = createEditorSaveState();
  state.changed();
  assert.equal(await state.save(async () => { throw new Error('offline'); }), false);
  assert.equal(state.isDirty(), true);
  assert.equal(await state.save(async () => {}), true);
  assert.equal(state.isDirty(), false);
});

test('autosaves keep one draft and manual Save checkpoints it exactly once', async () => {
  const state = createEditorSaveState();
  let drafts = 0;
  let versions = 0;
  for (let index = 0; index < 25; index++) {
    state.changed();
    assert.equal(await state.save(async () => { drafts++; }), true);
  }
  assert.equal(drafts, 25);
  assert.equal(versions, 0);
  assert.equal(state.isDirty(), false);
  assert.equal(await state.save(async () => { versions++; }, true), true);
  assert.equal(await state.save(async () => { versions++; }, true), true);
  assert.equal(versions, 1);
  state.reset(true);
  await state.save(async () => { versions++; }, true);
  assert.equal(versions, 2, 'a draft loaded after refresh can be saved as a version');
});

test('manual Save waits for an active autosave before creating the version', async () => {
  const state = createEditorSaveState();
  state.changed();
  let finish!: () => void;
  let versions = 0;
  const draft = state.save(() => new Promise<void>(resolve => { finish = resolve; }));
  const manual = state.save(async () => { versions++; }, true);
  await Promise.resolve();
  assert.equal(versions, 0);
  finish();
  assert.equal(await draft, true);
  assert.equal(await manual, true);
  assert.equal(versions, 1);
});
