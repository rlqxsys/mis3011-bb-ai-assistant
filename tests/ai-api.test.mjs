import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server.mjs';
import { item, assignmentText, fakeProvider, operation } from './ai-fixtures.mjs';

let server, base;
const provider = fakeProvider([
  { ok: true, message: '测试替身' },
  { summary: '新增作业', items: [item()], questions: [] },
  { summary: '今晚有会', operations: [operation()], questions: [] },
  new Error('测试用上游故障')
]);
async function call(path, body) {
  const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
before(async () => { server = await createApp({ stateFile: null, aiProvider: provider }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { server.close(); await once(server, 'close'); });
test('AI UI module and source catalogue are served without grades', async () => {
  assert.equal((await fetch(base + '/ai-panel.mjs')).status, 200);
  const result = await call('/api/ai/documents'); assert.ok(result.body.length > 400);
  assert.equal(result.body.some(d => d.type === 'grade' || d.text), false);
});
test('AI connection test returns explicit test-double transport in this test', async () => {
  const result = await call('/api/ai/test', {}); assert.equal(result.body.connectionTest.transport, 'test_double');
});
test('HTTP AI source ingestion creates a real core task and plan', async () => {
  await call('/api/ai/session', { now: '2026-11-12T10:00:00+08:00' });
  let result = await call('/api/ai/analyze', { documents: [{ id: 'source-omega', courseCode: 'UNSEEN500', term: '2026', title: 'Omega', text: assignmentText }] });
  assert.equal(result.status, 200); assert.equal(result.body.tasks[0].title, 'Assignment Omega');
  assert.equal(result.body.aiRuns[0].transport, 'test_double');
  result = await call('/api/events', { id: 'api-ai-plan', type: 'PLAN_REQUESTED' }); assert.ok(result.body.plan.blocks.length);
});
test('source duplicates skip the upstream call through the actual HTTP API', async () => {
  const count = provider.calls.length;
  const result = await call('/api/ai/analyze', { documents: [{ id: 'source-omega', courseCode: 'UNSEEN500', term: '2026', title: 'Omega', text: assignmentText }] });
  assert.equal(result.body.aiResult.skipped, true); assert.equal(provider.calls.length, count);
});
test('natural-language preview does not change actual preferences until applied', async () => {
  const result = await call('/api/ai/command', { instruction: '如果我今晚有会呢？' });
  assert.equal(result.body.profile.busy.length, 0); assert.equal(result.body.aiResult.preview.events.length, 1);
  const applied = await call('/api/ai/apply-preview', { runId: result.body.aiResult.runId });
  assert.equal(applied.body.profile.busy.length, 1);
});
test('AI upstream failure returns a visible error and preserves tasks', async () => {
  const before = (await call('/api/state')).body;
  const result = await call('/api/ai/analyze', { force: true, documents: [{ id: 'source-omega', courseCode: 'UNSEEN500', term: '2026', title: 'Omega', text: assignmentText }] });
  assert.equal(result.status, 400); assert.match(result.body.error, /上游故障/);
  const after = (await call('/api/state')).body; assert.deepEqual(after.tasks, before.tasks); assert.deepEqual(after.plan, before.plan);
});
test('a cross-origin page cannot silently configure a localhost model key', async () => {
  const result = await fetch(base + '/api/ai/config', { method: 'POST', headers: { Origin: 'https://untrusted.invalid', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(result.status, 403);
});
