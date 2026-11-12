import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadFeed } from '../core/load-feed.mjs';
import { createPublicWorkspace } from '../public/browser-workspace.mjs';

const feed = await loadFeed(fileURLToPath(new URL('../BB_Source_Feed/', import.meta.url)));
const evidence = JSON.parse(await readFile(new URL('../examples/automation-live-output.json', import.meta.url), 'utf8'));
const workspace = storage => createPublicWorkspace({ feed, evidence, storage });
const event = values => ({ id: crypto.randomUUID(), ...values });

test('public view starts from captured native-feed AI tasks and computes actual blocks', async () => {
  const state = await workspace().request('/api/state');
  assert.equal(state.tasks.length, 3);
  assert.deepEqual(state.tasks, evidence.tasks);
  assert.equal(state.aiRuns.length, 5);
  assert.ok(state.plan.blocks.length);
});
test('public completion releases only its task and persists across a fresh view', async () => {
  const memory = new Map(), storage = { getItem: key => memory.get(key), setItem: (key, value) => memory.set(key, value) };
  const app = workspace(storage), before = await app.request('/api/state');
  const id = before.tasks.find(t => t.kind === 'assignment').id;
  const after = await app.request('/api/events', event({ type: 'STATUS_RECORDED', taskId: id, value: 'user_confirmed', origin: 'user' }));
  assert.equal(after.plan.blocks.some(b => b.taskId === id), false);
  assert.equal(after.tasks.find(t => t.id === id).status.value, 'user_confirmed');
  assert.deepEqual((await workspace(storage).request('/api/state')).tasks, after.tasks);
  assert.equal((await workspace().request('/api/state')).tasks.find(t => t.id === id).status.value, 'unknown');
});
test('public profile changes rerun the same core planner and original results can be restored', async () => {
  const app = workspace();
  const state = await app.request('/api/events', event({ type: 'PROFILE_UPDATED', profile: { availability: [] } }));
  assert.equal(state.plan.blocks.length, 0);
  assert.ok(state.plan.risks.length);
  assert.ok((await app.request('/public/restore', {})).plan.blocks.length);
});
test('all four public classic scenarios use the source feed and their events work', async () => {
  for (const scenario of ['submission', 'exam-change', 'capacity', 'english']) {
    const app = workspace();
    const state = await app.request('/api/import', { scenario });
    assert.ok(state.tasks.every(t => feed.courses.some(c => c.code === t.courseCode)));
    await app.request('/api/events', event({ type: 'PLAN_REQUESTED' }));
    const after = await app.request('/api/demo/event', {});
    assert.ok(after.events.length);
  }
});
test('public task import keeps the original replay clock and does not claim a fresh model call', async () => {
  const app = workspace();
  const state = await app.request('/api/tasks/import', { now: evidence.now, tasks: evidence.tasks });
  assert.equal(state.now, evidence.now);
  assert.equal(state.aiRuns, undefined);
  await assert.rejects(() => app.request('/api/ai/analyze', {}), /Node/);
  await assert.rejects(() => app.request('/api/tasks/import', { tasks: evidence.tasks }), /now/);
});
