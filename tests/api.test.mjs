import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server.mjs';

let server, base, temp;
async function call(path, data) {
  const res = await fetch(`${base}${path}`, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return { status: res.status, body: await res.json() };
}
before(async () => {
  temp = await mkdtemp(join(tmpdir(), 'mis3011-api-test-'));
  server = await createApp({ stateFile: join(temp, 'state.json') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server.close(); await once(server, 'close'); await rm(temp, { recursive: true, force: true }); });
test('HTML, JS and CSS serve successfully without a build', async () => {
  for (const path of ['/', '/app.mjs', '/style.css', '/core/model.mjs']) assert.equal((await fetch(`${base}${path}`)).status, 200);
});
test('catalog reports actual feed coverage and candidate count', async () => {
  const r = await call('/api/catalog'); assert.equal(r.body.stats.attachments, 296); assert.equal(r.body.candidates, 58);
});
test('API import, profile, plan, reminder delivery and submission complete end to end', async () => {
  let r = await call('/api/import', { scenario: 'submission' }); assert.equal(r.status, 200); assert.equal(r.body.mode, 'replay');
  r = await call('/api/events', { id: 'api-profile', type: 'PROFILE_UPDATED', profile: { dailyLimitMinutes: 150 } });
  assert.equal(r.body.profile.dailyLimitMinutes, 150);
  r = await call('/api/events', { id: 'api-plan', type: 'PLAN_REQUESTED' }); assert.ok(r.body.plan.blocks.length);
  const next = r.body.notifications.filter(n => n.status === 'pending').sort((a, b) => Date.parse(a.deliverAt) - Date.parse(b.deliverAt))[0];
  r = await call('/api/events', { id: 'api-clock', type: 'CLOCK_ADVANCED', to: next.deliverAt }); assert.ok(r.body.notifications.some(n => n.id === next.id && n.status === 'delivered'));
  r = await call('/api/demo/event', {}); assert.equal(r.body.tasks[0].status.value, 'submitted');
  assert.equal(r.body.plan.blocks.some(b => b.taskId === r.body.tasks[0].id), false);
});
test('state is persisted on disk and a fresh server restores it', async () => {
  const saved = JSON.parse(await readFile(join(temp, 'state.json'), 'utf8')); assert.equal(saved.tasks[0].status.value, 'submitted');
  const second = await createApp({ stateFile: join(temp, 'state.json') });
  second.listen(0, '127.0.0.1'); await once(second, 'listening');
  try {
    const restored = await (await fetch(`http://127.0.0.1:${second.address().port}/api/state`)).json();
    assert.equal(restored.tasks[0].status.value, 'submitted'); assert.equal(restored.planningEnabled, true);
  } finally { second.close(); await once(second, 'close'); }
});
test('repeated source event is idempotent through HTTP', async () => {
  const before = await call('/api/state'); const after = await call('/api/demo/event', {});
  assert.equal(after.body.events.length, before.body.events.length); assert.equal(after.body.notifications.length, before.body.notifications.length);
});
test('a multi-event API batch is atomic if a later event fails', async () => {
  const before = await call('/api/state');
  const r = await call('/api/events', { events: [{ id: 'atomic-first', type: 'PLAN_REQUESTED' }, { id: 'atomic-invalid', type: 'INVALID' }] });
  assert.equal(r.status, 400); assert.deepEqual((await call('/api/state')).body, before.body);
});
test('source viewer opens packaged sources but not arbitrary system files', async () => {
  assert.equal((await fetch(`${base}/api/source?path=courses/CSC1001.json`)).status, 200);
  assert.equal((await fetch(`${base}/api/source?path=../../../../../etc/passwd`)).status, 404);
});
test('normalized-task import supports a separate integration without the source parser', async () => {
  const r = await call('/api/tasks/import', { now: '2024-11-01T09:00:00+08:00', tasks: [{ id: 'external-stable-id', courseCode: 'CUSTOM', title: 'Injected task', remainingMinutes: 60, deadline: { at: '2024-11-02T15:00:00+08:00' } }] });
  assert.equal(r.status, 200); assert.equal(r.body.tasks.length, 1); assert.equal(r.body.tasks[0].status.value, 'unknown');
});
test('snapshot import is browse-only and does not produce historical nagging', async () => {
  const r = await call('/api/import', { mode: 'snapshot' }); assert.equal(r.body.tasks.length, 58); assert.equal(r.body.notifications.length, 0);
  assert.equal((await call('/api/events', { id: 'archive-plan', type: 'PLAN_REQUESTED' })).status, 400);
});
