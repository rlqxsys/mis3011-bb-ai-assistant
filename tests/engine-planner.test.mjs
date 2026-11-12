import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadFeed } from '../core/load-feed.mjs';
import { loadScenario, scenarioEvents } from '../demo/scenarios.mjs';
import { applyEvent, createState, reconcile, validateProfile } from '../core/engine.mjs';
import { createTask, defaultProfile, applicability, fixedFor } from '../core/model.mjs';
import { planTasks } from '../core/planner.mjs';
import { duration, intersects, localClock, localDate, ms, MINUTE } from '../core/time.mjs';

const feed = await loadFeed(fileURLToPath(new URL('../BB_Source_Feed/', import.meta.url)));
let seq = 0;
const run = (s, type, fields = {}) => applyEvent(s, { id: `test-${seq++}`, type, ...fields });
const planned = id => run(loadScenario(feed, id), 'PLAN_REQUESTED');
const sample = overrides => createTask({ id: 'TEST:1', courseCode: 'TEST', term: '2024', title: 'Test assignment', remainingMinutes: 60, deadline: { at: '2024-11-02T15:00:00+08:00', date: '2024-11-02', precision: 'minute' }, ...overrides });

test('replay seed excludes future grade snapshots and attempt history', () => {
  const s = loadScenario(feed, 'submission');
  assert.ok(s.tasks.every(t => t.status.value === 'unknown' && !('grade' in t)));
  assert.ok(s.tasks.every(t => !t.sources.some(p => ['grade_snapshot', 'attempt_metadata'].includes(p.role))));
});
test('import is not a request to automatically fill a calendar', () => {
  const s = loadScenario(feed, 'submission'); assert.equal(s.planningEnabled, false); assert.equal(s.plan.blocks.length, 0);
});
test('complete assignment flow generates non-overlapping blocks before deadlines', () => {
  const s = planned('submission'); assert.ok(s.plan.blocks.length > 0);
  for (const b of s.plan.blocks) assert.ok(ms(b.end) <= ms(s.tasks.find(t => t.id === b.taskId).deadline.at) - s.profile.bufferMinutes * MINUTE);
  for (let i = 1; i < s.plan.blocks.length; i++) assert.equal(intersects(s.plan.blocks[i - 1], s.plan.blocks[i]), false);
});
test('submission frees only the submitted task and cancels its queued ordinary reminders', () => {
  let s = planned('submission'); const id = s.tasks[0].id, other = s.tasks[1].id;
  const otherSlots = s.plan.blocks.filter(b => b.taskId === other).map(b => b.id);
  for (const e of scenarioEvents(feed, s)) s = applyEvent(s, e);
  assert.equal(s.tasks[0].status.value, 'submitted');
  assert.equal(s.plan.blocks.some(b => b.taskId === id), false);
  assert.equal(s.notifications.some(n => n.taskId === id && n.type !== 'change' && n.status === 'pending'), false);
  assert.deepEqual(s.plan.blocks.filter(b => b.taskId === other).map(b => b.id), otherSlots);
});
test('draft is not a successful submission and retains preparation', () => {
  let s = planned('submission');
  s = run(s, 'STATUS_RECORDED', { taskId: s.tasks[0].id, value: 'draft', origin: 'bb_adapter' });
  assert.ok(s.plan.blocks.some(b => b.taskId === s.tasks[0].id));
});
test('user confirmation is labelled separately from BB verification', () => {
  let s = planned('submission'); s = run(s, 'STATUS_RECORDED', { taskId: s.tasks[0].id, value: 'user_confirmed', origin: 'user' });
  assert.equal(s.tasks[0].status.origin, 'user'); assert.equal(s.plan.blocks.some(b => b.taskId === s.tasks[0].id), false);
});
test('user UI cannot label its own confirmation as a BB submitted state', () => {
  const s = planned('submission');
  assert.throws(() => run(s, 'STATUS_RECORDED', { taskId: s.tasks[0].id, value: 'submitted', origin: 'user' }), /BB/);
});
test('a repeated event ID produces no extra effects or notifications', () => {
  let s = planned('submission'); const e = scenarioEvents(feed, s)[0]; s = applyEvent(s, e);
  assert.strictEqual(applyEvent(s, e), s);
});
test('repeated identical snapshots with different event IDs do not bump task version', () => {
  let s = planned('submission'); const task = structuredClone(s.tasks[0]);
  s = run(s, 'TASKS_UPSERTED', { tasks: [task] });
  s = run(s, 'TASKS_UPSERTED', { tasks: [task] });
  assert.equal(s.tasks[0].version, task.version);
});
test('exam update changes one stable event and restores tutorial without inventing its time', () => {
  let s = planned('exam-change'); const id = s.tasks[0].id;
  for (const e of scenarioEvents(feed, s)) s = applyEvent(s, e);
  assert.equal(s.tasks[0].id, id); assert.equal(s.tasks.length, 2);
  assert.equal(localDate(s.tasks[0].fixed.start), '2024-11-10');
  assert.equal(s.tasks[1].status.value, 'unknown'); assert.equal(s.tasks[1].fixed, null);
  assert.equal(s.plan.fixed.some(f => localDate(f.start) === '2024-11-01'), false);
  assert.equal(s.notifications.some(n => n.taskId === id && n.taskVersion === 1 && n.status === 'pending'), false);
});
test('postponing a task does not postpone the official deadline or hide insufficient capacity', () => {
  let s = planned('capacity'); const deadline = s.tasks[0].deadline.at;
  for (const e of scenarioEvents(feed, s)) s = applyEvent(s, e);
  assert.equal(s.tasks[0].deadline.at, deadline);
  assert.ok(s.plan.risks.some(r => r.taskId === s.tasks[0].id && r.code === 'insufficient_time'));
  assert.ok(s.plan.blocks.filter(b => b.taskId === s.tasks[0].id).every(b => ms(b.end) < ms(deadline)));
});
test('only one valid listening exam is selected for a known English section', () => {
  let s = planned('english'); assert.equal(s.plan.fixed.length, 0);
  s = run(s, 'PROFILE_UPDATED', { profile: { sections: { ENG1001: 'L12' } } });
  assert.equal(s.plan.fixed.length, 1); assert.equal(localClock(s.plan.fixed[0].start), '10:30');
});
test('invalid English section remains unknown, not applicable to every candidate slot', () => {
  const s = loadScenario(feed, 'english'), task = s.tasks.find(t => t.sectionOptions);
  assert.equal(applicability(task, { ...s.profile, sections: { ENG1001: 'L99' } }), 'unknown');
  assert.equal(fixedFor(task, { ...s.profile, sections: { ENG1001: 'L99' } }), null);
});
test('own device makes conditional slide upload not applicable without altering its evidence', () => {
  let s = planned('english'); s = run(s, 'PROFILE_UPDATED', { profile: { devices: { ENG1001: 'own' } } });
  const slides = s.tasks.find(t => t.kind === 'upload');
  assert.equal(applicability(slides, s.profile), 'not_applicable'); assert.equal(slides.status.value, 'unknown');
});
test('uploaded slides never complete the oral presentation', () => {
  let s = planned('english'); for (const e of scenarioEvents(feed, s)) s = applyEvent(s, e);
  assert.equal(s.tasks.find(t => t.kind === 'upload').status.value, 'submitted');
  assert.equal(s.tasks.find(t => t.kind === 'presentation').status.value, 'unknown');
});
test('unknown personal presentation time is not converted into all course sessions', () => {
  const s = planned('english');
  assert.equal(s.plan.fixed.some(f => f.kind === 'presentation'), false);
  assert.ok(s.plan.risks.some(r => r.code === 'needs_time'));
});
test('passing a planned slot does not reduce remaining work or assert non-completion', () => {
  let s = planned('submission'); const minutes = s.tasks[0].remainingMinutes;
  s = run(s, 'CLOCK_ADVANCED', { to: '2024-11-23T09:00:00+08:00' });
  assert.equal(s.tasks[0].remainingMinutes, minutes); assert.equal(s.tasks[0].status.value, 'unknown');
  assert.ok(s.missedBlocks.length > 0); assert.equal(s.missedBlocks[0].status, 'completion_unconfirmed');
});
test('snapshot mode never creates overdue reminders or a fake historical plan', () => {
  const s = createState({ mode: 'snapshot', tasks: [sample()], now: '2026-11-12T09:00:00+08:00' });
  reconcile(s); assert.equal(s.notifications.length, 0);
  assert.throws(() => run(s, 'PLAN_REQUESTED'), /历史快照/);
});
test('sync failure preserves submissions and last reliable check', () => {
  let s = planned('submission'); for (const e of scenarioEvents(feed, s)) s = applyEvent(s, e);
  const before = structuredClone(s.tasks), checkedAt = s.sync.checkedAt;
  s = run(s, 'SYNC_FAILED');
  assert.deepEqual(s.tasks, before); assert.equal(s.sync.checkedAt, checkedAt); assert.equal(s.sync.state, 'stale');
});
test('an incoming absence does not erase a user confirmation or delete a task', () => {
  let s = planned('submission'); const id = s.tasks[0].id;
  s = run(s, 'STATUS_RECORDED', { taskId: id, value: 'user_confirmed' });
  s = run(s, 'TASKS_UPSERTED', { tasks: [sample()] });
  assert.equal(s.tasks.find(t => t.id === id).status.value, 'user_confirmed'); assert.equal(s.tasks.length, 3);
});
test('pausing and resuming reminders does not mark a task as complete', () => {
  let s = planned('submission'); const id = s.tasks[0].id;
  s = run(s, 'REMINDER_PREFERENCE', { taskId: id, paused: true });
  assert.equal(s.tasks[0].status.value, 'unknown'); assert.equal(s.notifications.filter(n => n.taskId === id && n.status === 'pending').length, 0);
  s = run(s, 'REMINDER_PREFERENCE', { taskId: id, paused: false });
  assert.ok(s.notifications.some(n => n.taskId === id && n.status === 'pending'));
});
test('reading a notification changes neither submission nor estimated work', () => {
  let s = planned('submission'); const before = structuredClone(s.tasks);
  s = run(s, 'NOTICE_READ', { notificationId: s.notifications.find(n => n.status === 'delivered').id });
  assert.deepEqual(s.tasks, before);
});
test('snooze respects quiet hours when there is sufficient time before the deadline', () => {
  let s = planned('submission'); const id = s.tasks[0].id;
  s = run(s, 'REMINDER_PREFERENCE', { taskId: id, until: '2024-11-22T23:00:00+08:00' });
  const plan = s.notifications.find(n => n.taskId === id && n.type === 'plan' && n.status === 'pending');
  assert.equal(localClock(plan.deliverAt), '08:00');
});
test('invalid changes throw without mutating the original state', () => {
  const s = planned('submission'), before = JSON.stringify(s);
  assert.throws(() => run(s, 'TASK_CHANGED', { taskId: s.tasks[0].id, patch: { remainingMinutes: -1 } }));
  assert.equal(JSON.stringify(s), before);
});
test('clock is explicit and monotonic in historical replay', () => {
  const s = planned('submission'); assert.throws(() => run(s, 'CLOCK_ADVANCED', { minutes: -1 }));
});
test('availability ranges must be valid; an empty week is allowed and reports insufficient time', () => {
  assert.throws(() => validateProfile({ ...defaultProfile(), availability: [{ day: 2, start: '20:00', end: '19:00' }] }));
  let s = planned('submission'); s = run(s, 'PROFILE_UPDATED', { profile: { availability: [] } });
  assert.equal(s.plan.blocks.length, 0); assert.ok(s.plan.risks.some(r => r.code === 'insufficient_time'));
});
test('busy time excludes slots and invalidates only conflicting retained slots', () => {
  let s = planned('submission'); const b = s.plan.blocks[0];
  s = run(s, 'PROFILE_UPDATED', { profile: { busy: [{ start: b.start, end: b.end, title: 'Meeting' }] } });
  assert.ok(s.plan.blocks.every(p => !intersects(p, b)));
});
test('locked valid slots survive a replan; completed tasks release them', () => {
  let s = planned('submission'); const b = s.plan.blocks[0];
  s = run(s, 'BLOCK_LOCKED', { blockId: b.id, locked: true }); s = run(s, 'PLAN_REQUESTED');
  assert.ok(s.plan.blocks.some(p => p.id === b.id && p.locked));
  s = run(s, 'STATUS_RECORDED', { taskId: b.taskId, value: 'user_confirmed' });
  assert.equal(s.plan.blocks.some(p => p.id === b.id), false);
});
test('continuous quiz cannot be split into two short windows', () => {
  const p = { ...defaultProfile(), availability: [{ day: 5, start: '19:00', end: '19:30' }, { day: 5, start: '20:00', end: '20:30' }] };
  const plan = planTasks([sample({ kind: 'quiz', splittable: false })], p, '2024-11-01T09:00:00+08:00');
  assert.equal(plan.blocks.length, 0); assert.ok(plan.risks.some(r => r.code === 'insufficient_time'));
});
test('overlapping availability rows do not duplicate available time or exceed daily cap', () => {
  const p = { ...defaultProfile(), availability: [{ day: 5, start: '19:00', end: '21:00' }, { day: 5, start: '20:00', end: '22:00' }], dailyLimitMinutes: 90 };
  const plan = planTasks([sample({ remainingMinutes: 180 })], p, '2024-11-01T09:00:00+08:00');
  assert.ok(plan.blocks.reduce((n, b) => n + duration(b), 0) <= 90);
});
test('fixed events and arrival buffer block preparation windows', () => {
  const exam = sample({ id: 'EXAM', kind: 'exam', remainingMinutes: 0, deadline: null, fixed: { start: '2024-11-01T19:30:00+08:00', end: '2024-11-01T20:30:00+08:00', arrivalMinutes: 15 } });
  const p = defaultProfile(), plan = planTasks([sample(), exam], p, '2024-11-01T09:00:00+08:00');
  assert.ok(plan.blocks.every(b => !intersects(b, { start: '2024-11-01T19:15:00+08:00', end: exam.fixed.end })));
});
test('planner invariants hold over a deterministic range of task durations', () => {
  for (let i = 1; i <= 50; i++) {
    const tasks = [sample({ remainingMinutes: i * 7 }), sample({ id: 'B', remainingMinutes: i * 3, splittable: false })];
    const p = defaultProfile(), plan = planTasks(tasks, p, '2024-11-01T09:00:00+08:00');
    const used = {};
    for (const b of plan.blocks) {
      assert.ok(duration(b) > 0); assert.ok(ms(b.end) <= ms(tasks[0].deadline.at) - p.bufferMinutes * MINUTE);
      const date = localDate(b.start); used[date] = (used[date] || 0) + duration(b); assert.ok(used[date] <= p.dailyLimitMinutes);
    }
    for (let j = 1; j < plan.blocks.length; j++) assert.equal(intersects(plan.blocks[j - 1], plan.blocks[j]), false);
    assert.ok(plan.blocks.filter(b => b.taskId === 'B').length <= 1);
  }
});
test('known open and close windows constrain a quiz independently of its later DDL', () => {
  const task = sample({ kind: 'quiz', splittable: false, opensAt: '2024-11-01T20:00:00+08:00', closesAt: '2024-11-01T21:00:00+08:00', remainingMinutes: 30 });
  const plan = planTasks([task], defaultProfile(), '2024-11-01T09:00:00+08:00');
  assert.equal(plan.blocks.length, 1);
  assert.ok(ms(plan.blocks[0].start) >= ms(task.opensAt));
  assert.ok(ms(plan.blocks[0].end) <= ms(task.closesAt) - 20 * MINUTE);
});
test('actual quiz duration cannot be understated by an edited estimate', () => {
  const s = createState({ now: '2024-11-01T09:00:00+08:00', mode: 'replay' });
  assert.throws(() => run(s, 'TASKS_UPSERTED', { tasks: [sample({ kind: 'quiz', remainingMinutes: 30, durationMinutes: 60 })] }), /测验/);
});
test('optional practice does not become a mandatory plan or reminder', () => {
  let s = createState({ now: '2024-11-01T09:00:00+08:00', mode: 'replay', tasks: [sample({ optional: true })] });
  s = run(s, 'PLAN_REQUESTED');
  assert.equal(s.plan.blocks.length, 0); assert.equal(s.notifications.length, 0);
});
test('jumping past a deadline cancels obsolete pending alerts and asks for evidence once', () => {
  let s = planned('submission');
  s = run(s, 'CLOCK_ADVANCED', { to: '2024-12-01T09:00:00+08:00' });
  assert.equal(s.notifications.some(n => ['deadline', 'plan'].includes(n.type) && n.status === 'pending'), false);
  assert.equal(s.notifications.filter(n => n.type === 'verify').length, 2);
  const count = s.notifications.length;
  s = run(s, 'CLOCK_ADVANCED', { minutes: 60 });
  assert.equal(s.notifications.length, count);
});
test('unchanged adjacent preparation blocks retain configured break time', () => {
  const s = planned('submission');
  for (let i = 1; i < s.plan.blocks.length; i++) {
    const before = s.plan.blocks[i - 1], after = s.plan.blocks[i];
    if (localDate(before.end) === localDate(after.start)) assert.ok(ms(after.start) - ms(before.end) >= s.profile.breakMinutes * MINUTE);
  }
});
test('minute estimates edited by the student are not overwritten by a later source refresh', () => {
  let s = planned('submission'); const original = structuredClone(s.tasks[0]);
  s = run(s, 'TASK_CHANGED', { taskId: original.id, patch: { remainingMinutes: 35 } });
  s = run(s, 'TASKS_UPSERTED', { tasks: [original] });
  assert.equal(s.tasks[0].remainingMinutes, 35); assert.equal(s.tasks[0].estimateOrigin, 'user');
});
test('snoozing beyond the deadline retains an immediate explicit risk warning', () => {
  let s = planned('submission'); const id = s.tasks[0].id;
  s = run(s, 'REMINDER_PREFERENCE', { taskId: id, until: '2024-11-25T09:00:00+08:00' });
  assert.ok(s.notifications.some(n => n.type === 'change' && n.status === 'delivered' && /可能来不及/.test(n.body)));
  assert.equal(s.tasks[0].status.value, 'unknown');
});
test('a daytime post-deadline evidence check is not mislabelled as a quiet-hours conflict', () => {
  let s = planned('submission'); s = run(s, 'CLOCK_ADVANCED', { to: '2024-12-01T09:00:00+08:00' });
  assert.ok(s.notifications.filter(n => n.type === 'verify').every(n => !n.quietConflict));
});
