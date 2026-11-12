import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState, applyEvent } from '../core/engine.mjs';
import { createAutomation, createDocumentSource } from '../ai/automation.mjs';
import { createAIService } from '../ai/service.mjs';
import { prepareDocument } from '../ai/documents.mjs';
import { createApp } from '../server.mjs';
import { fakeProvider, item, operation, assignmentText } from './ai-fixtures.mjs';

const document = patch => prepareDocument({ id: 'source-omega', courseCode: 'UNSEEN500', term: '2026', title: 'Omega', text: assignmentText, ...patch });
const subscription = { courseCode: 'UNSEEN500', term: '2026' };
test('generic core and AI modules do not import demo rules or old course-specific cases', async () => {
  for (const folder of ['core', 'ai']) {
    const root = new URL(`../${folder}/`, import.meta.url);
    for (const name of (await readdir(root)).filter(n => n.endsWith('.mjs'))) {
      const text = await readFile(new URL(name, root), 'utf8');
      assert.doesNotMatch(text, /from ['"].*demo\//, `${folder}/${name}`);
      assert.doesNotMatch(text, /CSC1001|ECO3121|ENG1001/, `${folder}/${name}`);
    }
  }
});
const parsed = messages => {
  const { documents: [d], existingTasks } = JSON.parse(messages.at(-1).content);
  return { summary: '自动解析测试', items: [item({ operation: existingTasks.length ? 'update' : 'new', targetTaskId: existingTasks[0]?.id || null,
    deadlineAt: d.text.includes('November 15') ? '2026-11-15T15:00:00+08:00' : item().deadlineAt,
    deadlineDate: null, evidence: [{ documentId: d.id, quote: d.text, fields: ['deadlineAt', 'requirements', 'latePolicy'] }] })], questions: [] };
};
function setup(outputs = [parsed, parsed, parsed]) {
  let docs = [], now = '2026-11-12T10:00:00+08:00';
  const provider = fakeProvider(outputs), ai = createAIService(provider);
  const auto = createAutomation({ readDocuments: async () => ({ documents: docs, errors: [] }), provider, ai, clock: () => now });
  return { auto, ai, provider, setDocs: values => { docs = values; }, setClock: value => { now = value; },
    initial: () => createState({ now, mode: 'replay' }), start: s => auto.configure(s, { subscriptions: [subscription] }),
    tick: async s => auto.processNext(await auto.scan(s)) };
}

test('one-time subscription starts a baseline without sending the historical course pack', async () => {
  const x = setup(); x.setDocs([document()]);
  let s = await x.start(x.initial()); s = await x.tick(s);
  assert.equal(x.provider.calls.length, 0); assert.equal(s.automation.pending.length, 0); assert.equal(s.planningEnabled, true);
  const live = await x.start(createState()); assert.equal(live.mode, 'live'); assert.equal(live.now, '2026-11-12T10:00:00+08:00');
});
test('new raw source automatically creates tasks, plan and reminder queue, without PLAN_REQUESTED', async () => {
  const x = setup(); let s = await x.start(x.initial()); x.setDocs([document()]); s = await x.tick(s);
  assert.equal(s.tasks.length, 1); assert.ok(s.plan.blocks.length); assert.ok(s.notifications.some(n => n.type === 'deadline'));
  assert.equal(s.aiRuns[0].trigger, 'source_update'); assert.equal(s.automation.pending.length, 0);
  assert.equal(s.aiRuns[0].transport, 'test_double');
});
test('unchanged versions do not call AI, including after JSON persistence and restoration', async () => {
  const x = setup(); let s = await x.start(x.initial()); x.setDocs([document()]); s = await x.tick(s);
  const count = s.events.length; s = await x.tick(JSON.parse(JSON.stringify(s))); s = await x.tick(s);
  assert.equal(x.provider.calls.length, 1); assert.equal(s.events.length, count);
});
test('source update matches the same task and replaces obsolete scheduled reminders', async () => {
  const x = setup(); let s = await x.start(x.initial()); x.setDocs([document()]); s = await x.tick(s);
  const id = s.tasks[0].id;
  x.setDocs([document({ text: 'Assignment Omega is now due November 15, 2026 at 3 PM. Submit one PDF. Late submission is NOT allowed.' })]);
  s = await x.tick(s);
  assert.equal(s.tasks.length, 1); assert.equal(s.tasks[0].id, id); assert.equal(s.tasks[0].deadline.at, '2026-11-15T15:00:00+08:00');
  assert.equal(s.notifications.some(n => n.taskVersion === 1 && n.status === 'pending'), false);
  assert.match(s.automation.activity[0].message, /更新 1 项/);
});
test('file disappearance is not cancellation; confirmed tasks are not resurrected by changes', async () => {
  const x = setup(); let s = await x.start(x.initial()); x.setDocs([document()]); s = await x.tick(s);
  s = applyEvent(s, { id: 'done', type: 'STATUS_RECORDED', taskId: s.tasks[0].id, value: 'user_confirmed' });
  x.setDocs([]); s = await x.tick(s); assert.equal(s.tasks[0].status.value, 'user_confirmed');
  x.setDocs([document({ text: assignmentText + ' Check the PDF.' })]); s = await x.tick(s);
  assert.equal(s.tasks[0].status.value, 'user_confirmed'); assert.equal(s.plan.blocks.length, 0);
});
test('course and term subscription excludes other sources from model calls', async () => {
  const x = setup(); let s = await x.start(x.initial());
  x.setDocs([document({ id: 'other', courseCode: 'OTHER' }), document({ id: 'old-term', term: '2025' }), document()]); s = await x.tick(s);
  assert.equal(x.provider.calls.length, 1); assert.equal(s.tasks[0].courseCode, subscription.courseCode);
});
test('including existing material queues it once, not the whole pack on every scan', async () => {
  const x = setup(); x.setDocs([document()]);
  let s = await x.auto.configure(x.initial(), { subscriptions: [subscription], includeExisting: true });
  assert.equal(s.automation.pending.length, 1); s = await x.tick(s); s = await x.tick(s);
  assert.equal(s.tasks.length, 1); assert.equal(x.provider.calls.length, 1);
});
test('pause stops background processing; resume retains versions and pending work', async () => {
  const x = setup(); let s = await x.start(x.initial());
  s = await x.auto.configure(s, { enabled: false }); x.setDocs([document()]); s = await x.tick(s); assert.equal(x.provider.calls.length, 0);
  s = await x.start(s); s = await x.tick(s); assert.equal(s.tasks.length, 1);
});
test('missing model connection queues work without attempts or fake analysis', async () => {
  const x = setup(); x.provider.configure({ configured: false });
  let s = await x.start(x.initial()); x.setDocs([document()]); s = await x.tick(s);
  assert.equal(s.automation.pending.length, 1); assert.equal(s.automation.pending[0].attempts, 0); assert.equal(x.provider.calls.length, 0);
  x.provider.configure({ configured: true }); s = await x.tick(s); assert.equal(s.tasks.length, 1);
});
test('failures back off, preserve tasks, stop after three attempts; new versions resume', async () => {
  const x = setup([new Error('unavailable'), new Error('unavailable'), new Error('unavailable'), parsed]);
  let s = await x.start(x.initial()); x.setDocs([document()]); s = await x.tick(s); s = await x.tick(s);
  assert.equal(x.provider.calls.length, 1); assert.equal(s.tasks.length, 0);
  x.setClock('2026-11-12T10:02:00+08:00'); s = await x.tick(s);
  x.setClock('2026-11-12T10:05:00+08:00'); s = await x.tick(s);
  x.setClock('2026-11-12T10:15:00+08:00'); s = await x.tick(s); assert.equal(x.provider.calls.length, 3);
  x.setDocs([document({ text: assignmentText + ' Updated instructions.' })]); s = await x.tick(s);
  assert.equal(x.provider.calls.length, 4); assert.equal(s.tasks.length, 1);
});
test('explicit personal changes auto-apply; hypothetical or ambiguous statements do not', async () => {
  const x = setup([{ summary: '记录会议', intent: 'apply', operations: [operation()], questions: [] },
    { summary: '假设会议', intent: 'preview', operations: [operation()], questions: [] },
    { summary: '时间待定', intent: 'apply', operations: [operation()], questions: ['几点开始？'] }]);
  const s = x.initial(); const applied = await x.ai.command('今晚有会，重新排', s, { apply: 'auto' });
  assert.equal(applied.applied, true); assert.equal(applied.state.profile.busy.length, 1);
  const whatif = await x.ai.command('如果今晚有会呢', s, { apply: 'auto' }); assert.equal(whatif.applied, false); assert.equal(s.profile.busy.length, 0);
  const ambiguous = await x.ai.command('有会', s, { apply: 'auto' }); assert.equal(ambiguous.applied, false); assert.ok(ambiguous.preview.questions.length);
});
test('a later independent document does not erase unresolved questions', async () => {
  const x = setup([{ summary: '待补充', items: [item({ deadlineAt: null, deadlineDate: null, uncertainties: [{ field: 'deadlineAt', question: '几点截止？' }] })], questions: [] },
    { summary: '无关公告', items: [], questions: [] }]);
  let s = (await x.ai.analyze([document()], x.initial())).state;
  s = (await x.ai.analyze([document({ id: 'unrelated', text: 'Welcome to class.' })], s)).state;
  assert.ok(s.aiQuestions.some(q => q.includes('几点截止')));
});

test('repeating an explicit meeting does not duplicate busy time or change profile version', async () => {
  const response = { summary: '会议', intent: 'apply', operations: [operation()], questions: [] };
  const x = setup([response, response]);
  const first = (await x.ai.command('今晚会议', x.initial(), { apply: 'auto' })).state;
  const second = (await x.ai.command('今晚会议', first, { apply: 'auto' })).state;
  assert.equal(second.profile.busy.length, 1); assert.equal(second.profileVersion, first.profileVersion);
});

test('actual background timer handles file/API updates, raw feed refresh, restart and parse errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bb-auto-')), feedRoot = join(dir, 'feed'), inboxRoot = join(dir, 'inbox'), stateFile = join(dir, 'state.json');
  await mkdir(join(feedRoot, 'courses'), { recursive: true }); await writeFile(join(feedRoot, 'attachments.json'), '{}'); await mkdir(inboxRoot);
  const provider = fakeProvider([parsed, parsed, parsed]); let server, base;
  const start = async () => { server = await createApp({ feedRoot, inboxRoot, stateFile, aiProvider: provider, automationIntervalMs: 30 }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`; };
  const call = async (path, body) => { const r = await fetch(base + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}); const data = await r.json(); assert.equal(r.status, 200, JSON.stringify(data)); return data; };
  const until = async predicate => { for (let i = 0; i < 100; i++) { const s = await call('/api/state'); if (predicate(s)) return s; await new Promise(r => setTimeout(r, 20)); } throw new Error('background update timed out'); };
  try {
    await start(); await call('/api/ai/session', { now: '2026-11-12T10:00:00+08:00' });
    await call('/api/automation/config', { subscriptions: [subscription] });
    await writeFile(join(inboxRoot, 'notice.json'), JSON.stringify(document()));
    let s = await until(s => s.tasks.length === 1); assert.ok(s.plan.blocks.length); const id = s.tasks[0].id;
    await call('/api/feed/documents', { documents: [document({ id: 'extension', text: 'Assignment Omega is now due November 15, 2026 at 3 PM.' })] });
    s = await until(s => s.tasks[0].version > 1); assert.equal(s.tasks[0].id, id); assert.equal(s.tasks.length, 1);
    await writeFile(join(inboxRoot, 'broken.json'), '{');
    await writeFile(join(feedRoot, 'courses', 'UNSEEN500.json'), JSON.stringify({ code: 'UNSEEN500', title: 'Test', ann: [{ title: 'New announcement', posted: 'Thursday, November 12, 2026 1:00:00 PM CST', body: assignmentText }], pages: [], grades: [], details: [] }));
    s = await until(s => s.aiRuns.length === 3); assert.ok(s.automation.sourceErrors.some(e => e.includes('broken.json')));
    assert.equal(s.tasks.length, 1); assert.equal(provider.calls.length, 3);
    server.close(); await once(server, 'close');
    const saved = JSON.parse(await readFile(stateFile, 'utf8')); assert.equal(saved.automation.enabled, true);
    await start(); await until(s => s.automation.lastScanAt !== saved.automation.lastScanAt);
    assert.equal(provider.calls.length, 3); assert.equal((await call('/api/ai/documents')).some(d => d.title === 'New announcement'), true);
    await call('/api/import', { mode: 'snapshot' }); assert.equal((await call('/api/state')).automation.enabled, false);
  } finally { if (server?.listening) { server.close(); await once(server, 'close'); } await rm(dir, { recursive: true, force: true }); }
});
