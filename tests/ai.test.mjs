import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, applyEvent } from '../core/engine.mjs';
import { createTask } from '../core/model.mjs';
import { createProvider } from '../ai/provider.mjs';
import { compileAnalysis, applyAnalysis } from '../ai/analysis.mjs';
import { prepareDocument, buildDocuments, documentsFromUpload } from '../ai/documents.mjs';
import { createAIService } from '../ai/service.mjs';
import { analysisMessages } from '../ai/prompts.mjs';
import { compileCommand, applyCommand } from '../ai/commands.mjs';
import { loadFeed } from '../core/load-feed.mjs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { item, operation, assignmentText, fakeProvider } from './ai-fixtures.mjs';

const feed = await loadFeed(fileURLToPath(new URL('../BB_Source_Feed/', import.meta.url)));
const doc = prepareDocument({ id: 'source-omega', courseCode: 'UNSEEN500', term: '2026', title: 'New assignment', text: assignmentText, publishedAt: '2026-11-12T09:00:00+08:00' });
const initial = () => createState({ now: '2026-11-12T10:00:00+08:00', mode: 'replay' });
test('browser modules and server entry retain valid JavaScript syntax', () => {
  for (const path of ['web/app.mjs', 'web/ai-panel.mjs', 'server.mjs', 'ai/prompts.mjs']) {
    const result = spawnSync(process.execPath, ['--check', fileURLToPath(new URL(`../${path}`, import.meta.url))], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
const compile = (items, state = initial(), docs = [doc], id = 'test-ai') => compileAnalysis({ summary: '测试解析', items, questions: [] }, docs, state, id);
function apply(items = [item()]) {
  const state = initial(), result = compile(items);
  return applyAnalysis(state, result, { id: 'test-ai', documents: [doc], transport: 'test_double' });
}

test('new arbitrary course material drives task creation and the real planner', () => {
  let s = apply(); assert.equal(s.tasks[0].courseCode, 'UNSEEN500'); assert.equal(s.tasks[0].deadline.at, item().deadlineAt);
  s = applyEvent(s, { id: 'plan', type: 'PLAN_REQUESTED' }); assert.ok(s.plan.blocks.length);
  assert.equal(s.tasks[0].status.value, 'unknown'); assert.equal(s.tasks[0].estimateOrigin, 'ai_estimate');
});
test('unsupported fabricated evidence is held for review, not silently applied', () => {
  const result = compile([item({ evidence: [{ documentId: doc.id, quote: 'Invented deadline next week', fields: ['deadlineAt'] }] })]);
  assert.equal(result.events.length, 0); assert.equal(result.decisions[0].outcome, 'needs_review');
});
test('a real quote still needs field-specific grounding for a claimed time', () => {
  const result = compile([item({ evidence: [{ documentId: doc.id, quote: assignmentText, fields: ['requirements'] }] })]);
  assert.equal(result.events.length, 0); assert.match(result.questions[0], /deadlineAt/);
});
test('date-only material remains unplanned until exact time is known', () => {
  const s = apply([item({ deadlineAt: null, uncertainties: [{ field: 'deadlineAt', question: '具体截止时刻未知' }] })]);
  assert.equal(s.tasks[0].deadline.at, null); assert.equal(s.tasks[0].deadline.precision, 'date');
});
test('a bad model JSON structure is an error, not a fallback to legacy scenarios', () => {
  assert.throws(() => compileAnalysis({ text: 'not a task' }, [doc], initial(), 'bad'), /结构/);
});
test('an explicit update changes the stable task and cancels obsolete queued reminders', () => {
  let s = apply(); s = applyEvent(s, { id: 'plan', type: 'PLAN_REQUESTED' });
  const changed = prepareDocument({ ...doc, id: 'update-omega', publishedAt: '2026-11-13T09:00:00+08:00', text: 'Assignment Omega is now due November 15, 2026 at 3 PM.' });
  const update = item({ operation: 'update', targetTaskId: s.tasks[0].id, deadlineAt: '2026-11-15T15:00:00+08:00', requirements: [], latePolicy: 'unknown', evidence: [{ documentId: changed.id, quote: changed.text, fields: ['deadlineAt'] }] });
  const result = compile([update], s, [changed], 'update'); s = applyAnalysis(s, result, { documents: [changed] });
  assert.equal(s.tasks.length, 1); assert.equal(s.tasks[0].deadline.at, update.deadlineAt);
  assert.equal(s.notifications.some(n => n.taskVersion === 1 && n.status === 'pending'), false);
});
test('old source cannot override a newer arrangement', () => {
  let s = apply(); s.tasks[0].sources[0].publishedAt = '2026-11-14T09:00:00+08:00';
  const result = compile([item({ operation: 'update', targetTaskId: s.tasks[0].id })], s);
  assert.equal(result.events.length, 0); assert.match(result.questions[0], /早于/);
});
test('source changes do not undo an already confirmed submission', () => {
  let s = apply(); s = applyEvent(s, { id: 'done', type: 'STATUS_RECORDED', taskId: s.tasks[0].id, value: 'user_confirmed' });
  const result = compile([item({ operation: 'supplement', targetTaskId: s.tasks[0].id, requirements: ['提交一个 PDF', '检查文件可读性'] })], s, [doc], 'supplement');
  s = applyAnalysis(s, result, { documents: [doc] }); assert.equal(s.tasks[0].status.value, 'user_confirmed');
});
test('first-seen cancellation creates a cancelled event, later reinstate resolves its identity', () => {
  const canceledDoc = prepareDocument({ ...doc, text: 'The tutorial for T13 on November 14 is cancelled.' });
  const canceled = item({ operation: 'cancel', title: 'Tutorial', kind: 'tutorial', channel: 'offline', deadlineAt: null, deadlineDate: null,
    estimatedMinutes: 0, requirements: [], latePolicy: 'unknown', evidence: [{ documentId: doc.id, quote: canceledDoc.text, fields: ['cancel'] }] });
  let s = applyAnalysis(initial(), compile([canceled], initial(), [canceledDoc]), { documents: [canceledDoc] });
  assert.equal(s.tasks[0].status.value, 'cancelled');
  const restoredDoc = prepareDocument({ ...doc, id: 'restore', text: 'The original tutorial will still be held.' });
  s = applyAnalysis(s, compile([item({ ...canceled, operation: 'reinstate', targetTaskId: s.tasks[0].id, evidence: [{ documentId: 'restore', quote: restoredDoc.text, fields: ['reinstate'] }] })], s, [restoredDoc], 'restore'), { documents: [restoredDoc] });
  assert.equal(s.tasks.length, 1); assert.equal(s.tasks[0].status.value, 'unknown'); assert.equal(s.tasks[0].fixed, null);
});
test('a returned conflict is retained for review, without changing the official deadline', () => {
  const s = apply(), result = compile([item({ operation: 'conflict', targetTaskId: s.tasks[0].id, reason: '两处正式日期冲突' })], s);
  assert.equal(result.events.length, 0); assert.match(result.questions[0], /冲突/);
});
test('newer online-only instruction removes only the specified old requirement', () => {
  let s = apply(); s.tasks[0].requirements = ['纸质交件', '400–600 字'];
  const correction = prepareDocument({ ...doc, id: 'online-correction', text: 'Only online submission is required. No paper copy.' });
  const result = compile([item({ operation: 'update', targetTaskId: s.tasks[0].id, deadlineAt: null, requirements: ['仅在线提交'], removeRequirements: ['纸质交件'], latePolicy: 'unknown', evidence: [{ documentId: correction.id, quote: correction.text, fields: ['requirements'] }] })], s, [correction], 'req-correction');
  s = applyAnalysis(s, result, { documents: [correction] }); assert.deepEqual(s.tasks[0].requirements, ['400–600 字', '仅在线提交']);
});
test('known time clears the corresponding earlier AI uncertainty', () => {
  let s = apply([item({ deadlineAt: null, uncertainties: [{ field: 'deadlineAt', question: '具体时刻待确认' }] })]);
  const result = compile([item({ operation: 'update', targetTaskId: s.tasks[0].id })], s, [doc], 'resolved-time');
  s = applyAnalysis(s, result, { documents: [doc] }); assert.equal(s.tasks[0].issues.includes('具体时刻待确认'), false);
});
test('grade and submission history are excluded from model input documents and context', () => {
  const docs = buildDocuments(feed); assert.ok(docs.length > 400); assert.equal(docs.some(d => d.type === 'grade'), false);
  const s = apply(); s.tasks[0].sources.push({ role: 'grade_snapshot', quote: 'PRIVATE-SCORE' }, { role: 'attempt_metadata', quote: 'PRIVATE-ATTEMPT' });
  const prompt = JSON.stringify(analysisMessages([doc], s, {}));
  assert.equal(prompt.includes('PRIVATE-SCORE'), false); assert.equal(prompt.includes('PRIVATE-ATTEMPT'), false);
});
test('raw course JSON import strips grades/details rather than serializing them', () => {
  const raw = { ...feed.courses[0], grades: [['PRIVATE-SCORE']], details: [{ body: 'PRIVATE-ATTEMPT' }] };
  const output = JSON.stringify(documentsFromUpload(raw)); assert.equal(output.includes('PRIVATE-'), false);
});
test('AI service deduplicates source versions without a second model call', async () => {
  const p = fakeProvider([{ summary: 'new', items: [item()], questions: [] }]), service = createAIService(p);
  const first = await service.analyze([doc], initial()); const second = await service.analyze([doc], first.state);
  assert.equal(second.skipped, true); assert.equal(p.calls.length, 1);
});
test('upstream model failure does not change student state or produce fake output', async () => {
  const p = fakeProvider([new Error('provider unavailable')]), service = createAIService(p), s = initial();
  await assert.rejects(service.analyze([doc], s), /unavailable/); assert.equal(s.tasks.length, 0); assert.equal(s.aiRuns, undefined);
});
test('what-if preview calculates a plan without applying changes', () => {
  let s = apply(); s = applyEvent(s, { id: 'plan', type: 'PLAN_REQUESTED' }); const before = JSON.stringify(s);
  const result = compileCommand({ summary: '今晚有会', operations: [operation()], questions: [] }, s, 'cmd');
  assert.equal(result.events[0].type, 'PROFILE_UPDATED'); assert.equal(JSON.stringify(s), before);
  const next = applyCommand(s, result, { id: 'cmd' }); assert.equal(next.profile.busy.length, 1);
});
test('planning command cannot use a hidden arbitrary action to alter a deadline or submit work', () => {
  const s = apply();
  assert.throws(() => compileCommand({ summary: 'bad', operations: [operation({ type: 'submit' })], questions: [] }, s, 'bad'), /不支持/);
});
test('a stale command preview is not applied over newer user preferences', () => {
  const s = apply(), result = compileCommand({ summary: 'busy', operations: [operation()], questions: [] }, s, 'cmd');
  const changed = applyEvent(s, { id: 'prefs', type: 'PROFILE_UPDATED', profile: { dailyLimitMinutes: 90 } });
  assert.throws(() => applyCommand(changed, result, {}), /重新分析/);
});
test('clarifying an ambiguous instruction does not mutate any profile field', () => {
  const s = apply(), result = compileCommand({ summary: '请确认', operations: [operation({ type: 'clarify', reason: '你指哪份作业？' })], questions: [] }, s, 'cmd');
  assert.equal(result.events.length, 0); assert.ok(result.questions.length);
});
test('feedback is explicit, one row per task, and never inferred from a submission timestamp', () => {
  let s = apply(); const taskId = s.tasks[0].id;
  s = applyEvent(s, { id: 'f1', type: 'EFFORT_FEEDBACK_RECORDED', taskId, actualMinutes: 150 });
  s = applyEvent(s, { id: 'f2', type: 'EFFORT_FEEDBACK_RECORDED', taskId, actualMinutes: 160 });
  assert.equal(s.effortFeedback.length, 1); assert.equal(s.effortFeedback[0].origin, 'explicit_user_feedback'); assert.equal(s.tasks[0].status.value, 'unknown');
});
test('new estimates use transparent median calibration only with enough same-type feedback', () => {
  const s = initial(); s.effortFeedback = Array.from({ length: 3 }, (_, i) => ({ taskId: `x${i}`, kind: 'assignment', estimatedMinutes: 120, actualMinutes: 180 }));
  const result = compile([item()], s); const task = result.events[0].tasks[0];
  assert.equal(task.remainingMinutes, 180); assert.equal(task.estimateSamples, 3); assert.equal(task.estimateOrigin, 'feedback_calibrated');
});
test('provider uses real HTTP JSON contract, hides its key and does not persist it in info', async () => {
  let sent;
  const p = createProvider({ env: {}, fetcher: async (url, options) => { sent = { url, options }; return { ok: true, status: 200, json: async () => ({ id: 'actual-contract-test', model: 'test-model', choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }) }; } });
  p.configure({ endpoint: 'https://test.invalid/chat/completions', model: 'test-model', apiKey: 'SECRET', consent: true });
  const r = await p.complete([{ role: 'user', content: 'hello' }], { type: 'object' }, 'test');
  assert.equal(sent.options.headers.Authorization, 'Bearer SECRET'); assert.equal(JSON.stringify(p.info()).includes('SECRET'), false); assert.equal(r.value.ok, true);
});
test('provider requires explicit sending consent and does not call through missing config', async () => {
  const p = createProvider({ env: {} }); await assert.rejects(p.complete([], {}, 'test'), /配置/);
  p.configure({ apiKey: 'SECRET', model: 'test' }); await assert.rejects(p.complete([], {}, 'test'), /确认/);
});
test('provider truncation and malformed JSON are visible failures, not repaired into invented tasks', async () => {
  const p = createProvider({ env: {}, fetcher: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{' } }] }) }) });
  p.configure({ apiKey: 'SECRET', model: 'test', consent: true }); await assert.rejects(p.complete([], {}, 'test'), /截断/);
});
test('DeepSeek sends JSON Object in explicit non-thinking mode', async () => {
  let body;
  const p = createProvider({ env: {}, fetcher: async (url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }) };
  } });
  p.configure({ endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash', apiKey: 'TEST-KEY', format: 'json_object', consent: true });
  await p.complete([], {}, 'test');
  assert.deepEqual(body.thinking, { type: 'disabled' }); assert.deepEqual(body.response_format, { type: 'json_object' });
});
test('changing provider cannot silently reuse a key for another service', () => {
  const p = createProvider({ env: {} });
  p.configure({ apiKey: 'TEST-KEY', model: 'test' });
  assert.throws(() => p.configure({ endpoint: 'https://api.deepseek.com/chat/completions', apiKey: '' }), /不会复用/);
  assert.equal(p.info().endpoint, 'https://openrouter.ai/api/v1/chat/completions');
});
test('what-if computes a real preview even before the first plan request', () => {
  const s = apply(); assert.equal(s.planningEnabled, false);
  const result = compileCommand({ summary: '今晚有会', operations: [operation()], questions: [] }, s, 'first-preview');
  assert.ok(result.plan.blocks.length); assert.ok(result.events.some(e => e.type === 'PLAN_REQUESTED'));
  assert.equal(s.planningEnabled, false);
});
test('policy evidence accepts the actual schema field name without requiring an alias', () => {
  const r = compile([item({ evidence: [{ documentId: doc.id, quote: assignmentText, fields: ['deadlineAt', 'requirements', 'latePolicy'] }] })]);
  assert.equal(r.decisions[0].outcome, 'applied'); assert.equal(r.events[0].tasks[0].policy.late, 'not_allowed');
});
test('exam duration is not treated as a minimum revision-time estimate', () => {
  const r = compile([item({ kind: 'exam', durationMinutes: 120, estimatedMinutes: 60, evidence: [{ documentId: doc.id, quote: assignmentText, fields: ['deadlineAt', 'requirements', 'policy', 'durationMinutes'] }] })]);
  assert.equal(r.events[0].tasks[0].remainingMinutes, 60);
});
test('calling an old source a supplement cannot overwrite a newer deadline', () => {
  const s = apply(); s.tasks[0].sources[0].publishedAt = '2026-11-14T09:00:00+08:00';
  const r = compile([item({ operation: 'supplement', targetTaskId: s.tasks[0].id, deadlineAt: '2026-11-13T15:00:00+08:00' })], s);
  assert.equal(r.events.length, 0); assert.match(r.decisions[0].reason, /早于/);
});
test('repeating established duration and sections does not block a separately grounded change', () => {
  const s = apply(); s.tasks[0].durationMinutes = 120; s.tasks[0].sections = ['L02'];
  const changed = prepareDocument({ ...doc, id: 'new-notice', text: 'The assignment deadline is moved to November 15, 2026 at 3 PM.' });
  const output = item({ operation: 'update', targetTaskId: s.tasks[0].id, deadlineAt: '2026-11-15T15:00:00+08:00', durationMinutes: 120, sections: ['L02'], requirements: ['提交一个 PDF'], evidence: [{ documentId: changed.id, quote: changed.text, fields: ['deadlineAt'] }] });
  const raw = JSON.stringify(output), result = compile([output], s, [changed], 'incremental');
  assert.equal(result.decisions[0].outcome, 'applied'); assert.equal(JSON.stringify(output), raw);
  const next = applyAnalysis(s, result, { documents: [changed] });
  assert.equal(next.tasks[0].durationMinutes, 120); assert.deepEqual(next.tasks[0].sections, ['L02']);
});
test('a genuinely changed duration still requires its own evidence', () => {
  const s = apply(); s.tasks[0].durationMinutes = 120;
  const r = compile([item({ operation: 'update', targetTaskId: s.tasks[0].id, durationMinutes: 150 })], s);
  assert.equal(r.decisions[0].outcome, 'needs_review'); assert.match(r.decisions[0].reason, /durationMinutes/);
});
