import { applyEvent } from '../core/engine.mjs';
import { timeOK, taskContextKey } from './analysis.mjs';

export function compileCommand(value, state, runId) {
  if (!value || typeof value.summary !== 'string' || !Array.isArray(value.operations)) throw new Error('AI 返回的调整结构无效。');
  let scratch = structuredClone(state);
  const events = [], questions = [...(value.questions || [])];
  for (const [i, operation] of value.operations.entries()) {
    const op = operation, id = `${runId}:operation:${i}`;
    let event;
    if (op.type === 'clarify') { questions.push(op.reason || op.title); continue; }
    if (['set_estimate', 'defer', 'pause', 'snooze'].includes(op.type) && !scratch.tasks.some(t => t.id === op.taskId)) throw new Error('自然语言调整未匹配到明确任务。');
    if (op.type === 'add_busy' || op.type === 'remove_busy') {
      if (!timeOK(op.start) || !timeOK(op.end)) throw new Error('忙碌时段需要明确、带时区的起止时间。');
      if (op.type === 'add_busy' && scratch.profile.busy.some(b => Date.parse(b.start) === Date.parse(op.start) && Date.parse(b.end) === Date.parse(op.end))) continue;
      const busy = op.type === 'add_busy' ? [...scratch.profile.busy, { title: op.title, start: op.start, end: op.end }]
        : scratch.profile.busy.filter(b => Date.parse(b.start) !== Date.parse(op.start) || Date.parse(b.end) !== Date.parse(op.end));
      event = { id, type: 'PROFILE_UPDATED', profile: { busy } };
    } else if (op.type === 'set_estimate') event = { id, type: 'TASK_CHANGED', taskId: op.taskId, patch: { remainingMinutes: op.minutes }, message: '按你的表达更新剩余用时，不改官方时间。' };
    else if (op.type === 'defer') {
      if (!timeOK(op.start)) throw new Error('推迟操作缺少明确时间。');
      event = { id, type: 'TASK_DEFERRED', taskId: op.taskId, until: op.start };
    } else if (op.type === 'pause') event = { id, type: 'REMINDER_PREFERENCE', taskId: op.taskId, paused: true };
    else if (op.type === 'snooze') {
      if (!timeOK(op.start)) throw new Error('稍后提醒缺少明确时间。');
      event = { id, type: 'REMINDER_PREFERENCE', taskId: op.taskId, until: op.start };
    } else if (op.type === 'set_quiet') event = { id, type: 'PROFILE_UPDATED', profile: { quiet: { start: op.startClock, end: op.endClock } } };
    else if (op.type === 'set_daily_limit') event = { id, type: 'PROFILE_UPDATED', profile: { dailyLimitMinutes: op.minutes } };
    else if (op.type === 'set_weekly_window') {
      const availability = scratch.profile.availability.filter(a => a.day !== op.day);
      availability.push({ day: op.day, start: op.startClock, end: op.endClock });
      event = { id, type: 'PROFILE_UPDATED', profile: { availability } };
    } else throw new Error('AI 提出了不支持的操作，没有执行。');
    scratch = applyEvent(scratch, event);
    events.push(event);
  }
  if (events.length && scratch.tasks.length && !scratch.planningEnabled) {
    const event = { id: `${runId}:plan`, type: 'PLAN_REQUESTED' };
    scratch = applyEvent(scratch, event);
    events.push(event);
  }
  return { summary: value.summary, events, questions: [...new Set(questions)], plan: scratch.plan,
    notifications: scratch.notifications, baseContext: taskContextKey(state), baseProfileVersion: state.profileVersion };
}

export function applyCommand(state, compiled, run) {
  if (compiled.baseContext !== taskContextKey(state) || compiled.baseProfileVersion !== state.profileVersion) throw new Error('任务或偏好在预览后变化，请重新分析调整，未应用过期结果。');
  let next = state;
  for (const event of compiled.events) next = applyEvent(next, event);
  next = structuredClone(next);
  next.aiRuns = [...(next.aiRuns || []), { ...run, summary: compiled.summary, events: compiled.events, questions: compiled.questions }];
  return next;
}
