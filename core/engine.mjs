import { activeTask, createTask, defaultProfile, STATUS_LABELS, taskEnd } from './model.mjs';
import { duration, iso, localDate, MINUTE, ms, validTime } from './time.mjs';
import { planTasks } from './planner.mjs';
import { addChangeNotification, updateReminders } from './reminders.mjs';

const emptyPlan = () => ({ blocks: [], fixed: [], risks: [] });

export function createState({ now = new Date().toISOString(), mode = 'empty', tasks = [], profile = {}, scenario = null, imported = null } = {}) {
  return {
    schemaVersion: 1, userId: 'local-student', mode, now, scenario, imported,
    tasks: structuredClone(tasks), profile: { ...defaultProfile(), ...structuredClone(profile) }, profileVersion: 1,
    planningEnabled: false, plan: emptyPlan(), missedBlocks: [], notifications: [], events: [],
    sync: { state: 'offline_sample', checkedAt: now, message: '离线数据，没有连接学校 BB。' }
  };
}

export function validateProfile(profile) {
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  for (const row of profile.availability) {
    if (!Number.isInteger(row.day) || row.day < 0 || row.day > 6 || !clock.test(row.start) || !clock.test(row.end) || row.start >= row.end) throw new Error('空闲时间需为同一天内有效的起止时间。');
  }
  for (const busy of profile.busy) {
    if (!validTime(busy.start) || !validTime(busy.end) || ms(busy.start) >= ms(busy.end)) throw new Error('忙碌时段的结束时间必须晚于开始时间。');
  }
  for (const key of ['dailyLimitMinutes', 'blockMinutes', 'horizonDays']) {
    if (!Number.isFinite(profile[key]) || profile[key] <= 0) throw new Error(`${key} 必须大于零。`);
  }
  if (profile.horizonDays > 90 || profile.blockMinutes > 480 || profile.dailyLimitMinutes > 1440) throw new Error('规划范围超出本地原型支持的合理范围。');
  if (![profile.bufferMinutes, profile.breakMinutes].every(n => Number.isFinite(n) && n >= 0)) throw new Error('缓冲和休息时间必须为非负分钟数。');
  if (!clock.test(profile.quiet.start) || !clock.test(profile.quiet.end)) throw new Error('安静时段格式应为 HH:mm。');
}

export function reconcile(state) {
  if (state.planningEnabled && state.mode !== 'snapshot') {
    for (const b of state.plan.blocks.filter(b => ms(b.end) <= ms(state.now))) {
      const task = state.tasks.find(t => t.id === b.taskId);
      if (task && activeTask(task, state.profile) && !state.missedBlocks.some(m => m.id === b.id)) state.missedBlocks.push({ ...b, status: 'completion_unconfirmed' });
    }
    state.plan = planTasks(state.tasks, state.profile, state.now, state.plan.blocks);
  }
  updateReminders(state);
  return state;
}

function taskById(state, id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) throw new Error('没有找到对应任务。');
  return task;
}

function checkTask(task) {
  if (!task.id || !task.courseCode || !task.title) throw new Error('任务缺少 id、courseCode 或 title。');
  if (!Number.isFinite(task.remainingMinutes) || task.remainingMinutes < 0) throw new Error('预计剩余用时必须是非负分钟数。');
  if (task.deadline?.at && !validTime(task.deadline.at)) throw new Error('截止时间无效。');
  if (task.fixed && (!validTime(task.fixed.start) || !validTime(task.fixed.end) || ms(task.fixed.start) >= ms(task.fixed.end))) throw new Error('固定事件的起止时间无效。');
  if (task.notBefore && !validTime(task.notBefore)) throw new Error('最早安排时间无效。');
  for (const key of ['opensAt', 'closesAt']) if (task[key] && !validTime(task[key])) throw new Error(`${key} 时间无效。`);
  if (task.opensAt && task.closesAt && ms(task.opensAt) >= ms(task.closesAt)) throw new Error('开放时间必须早于关闭时间。');
  if (task.kind === 'quiz' && task.durationMinutes && task.remainingMinutes < task.durationMinutes) throw new Error('连续测验的预计用时不能短于已知测验时长。');
}

export function applyEvent(current, event) {
  if (!event.id || !event.type) throw new Error('事件需要稳定 id 和 type。');
  if (current.events.some(e => e.id === event.id)) return current;
  const state = structuredClone(current), changes = [];
  switch (event.type) {
    case 'PROFILE_UPDATED': {
      state.profile = { ...state.profile, ...event.profile };
      validateProfile(state.profile);
      state.profileVersion++;
      // Availability and section changes invalidate obsolete queued clarification notices.
      for (const n of state.notifications) if (n.status === 'pending' && ['clarify', 'risk'].includes(n.type)) n.status = 'cancelled';
      break;
    }
    case 'PLAN_REQUESTED':
      if (state.mode === 'snapshot') throw new Error('完整历史快照只供查看，请载入历史回放场景或导入当前任务后再规划。');
      state.planningEnabled = true;
      break;
    case 'CLOCK_ADVANCED': {
      if (state.mode !== 'replay') throw new Error('只有历史回放模式可以手动推进时钟。');
      const next = event.to || iso(ms(state.now) + Number(event.minutes) * MINUTE);
      if (!validTime(next) || ms(next) <= ms(state.now)) throw new Error('回放时钟只能向前推进。');
      state.now = next;
      break;
    }
    case 'TASK_CHANGED': {
      const task = taskById(state, event.taskId);
      const allowed = ['title', 'deadline', 'fixed', 'remainingMinutes', 'notBefore', 'opensAt', 'closesAt', 'durationMinutes', 'requirements', 'condition', 'sections', 'sectionOptions', 'issues', 'policy', 'aiUncertainties'];
      const before = structuredClone(task);
      for (const key of allowed) if (key in event.patch) task[key] = structuredClone(event.patch[key]);
      if (!('aiUncertainties' in event.patch) && (event.patch.deadline?.origin === 'user_confirmed' || event.patch.fixed?.origin === 'user_confirmed')) {
        const resolved = task.aiUncertainties || [];
        const fields = event.patch.fixed ? ['fixed', 'fixedStart', 'fixedEnd'] : ['deadline', 'deadlineAt', 'deadlineDate'];
        task.aiUncertainties = resolved.filter(u => !fields.includes(u.field));
        task.issues = task.issues.filter(q => !resolved.some(u => fields.includes(u.field) && u.question === q));
      }
      if ('remainingMinutes' in event.patch) task.estimateOrigin = 'user';
      checkTask(task);
      if (event.source) task.sources.push(event.source);
      task.version++;
      changes.push({ task, message: event.message || '任务信息变化，已检查关联计划和提醒。', before });
      break;
    }
    case 'STATUS_RECORDED': {
      const task = taskById(state, event.taskId);
      if (!(event.value in STATUS_LABELS)) throw new Error('未知状态。');
      if (['submitted', 'graded'].includes(event.value) && !['bb_adapter', 'demo_bb'].includes(event.origin)) throw new Error('BB 确认状态应由接入器提供；个人操作请使用 user_confirmed。');
      task.status = { value: event.value, origin: event.origin || 'user', at: state.now, note: event.note || '' };
      task.version++;
      if (event.source) task.sources.push(event.source);
      changes.push({ task, message: `${event.note ? `${event.note} ` : ''}${STATUS_LABELS[event.value]}。这是本任务的证据，不代表其他关联事项已经完成。` });
      break;
    }
    case 'TASK_DEFERRED': {
      const task = taskById(state, event.taskId);
      if (!validTime(event.until) || ms(event.until) < ms(state.now)) throw new Error('推迟后的最早安排时间不能早于当前时间。');
      task.notBefore = event.until;
      task.version++;
      changes.push({ task, message: `已推迟准备安排至 ${event.until} 之后；正式截止时间没有改变。` });
      break;
    }
    case 'REMINDER_PREFERENCE': {
      const task = taskById(state, event.taskId);
      if (typeof event.paused === 'boolean') task.paused = event.paused;
      if (event.until !== undefined) {
        if (event.until !== null && (!validTime(event.until) || ms(event.until) <= ms(state.now))) throw new Error('稍后提醒时间应晚于当前时间。');
        task.snoozedUntil = event.until;
        for (const n of state.notifications.filter(n => n.taskId === task.id && n.status === 'pending' && n.type !== 'change')) n.deliverAt = event.until || n.scheduledAt;
        if (event.until && taskEnd(task, state.profile) && ms(event.until) >= ms(taskEnd(task, state.profile))) {
          changes.push({ task, message: '注意：你选择的稍后提醒时间不早于正式时间，可能来不及处理。正式时间未改变，请检查该任务；这条风险说明不会被稍后偏好隐藏。' });
        }
      }
      // A preference changes neither submission evidence nor the official deadline.
      break;
    }
    case 'NOTICE_READ': {
      const n = state.notifications.find(n => n.id === event.notificationId);
      if (n && n.status === 'delivered') n.status = 'read';
      break;
    }
    case 'BLOCK_LOCKED': {
      const block = state.plan.blocks.find(b => b.id === event.blockId);
      if (!block) throw new Error('找不到准备时段。');
      block.locked = Boolean(event.locked);
      break;
    }
    case 'SYNC_FAILED':
      state.sync = { ...state.sync, state: 'stale', message: event.message || '读取失败，保留上次可靠记录；未将任务或提交判为消失。' };
      break;
    case 'EFFORT_FEEDBACK_RECORDED': {
      const task = taskById(state, event.taskId);
      if (!Number.isFinite(event.actualMinutes) || event.actualMinutes <= 0 || event.actualMinutes > 20_000) throw new Error('请填写自愿提供的实际用时分钟数。');
      const feedback = { taskId: task.id, kind: task.kind, courseCode: task.courseCode,
        estimatedMinutes: task.initialEstimateMinutes || task.remainingMinutes,
        actualMinutes: event.actualMinutes, origin: 'explicit_user_feedback', at: state.now };
      state.effortFeedback = [...(state.effortFeedback || []).filter(r => r.taskId !== task.id), feedback];
      break;
    }
    case 'TASKS_UPSERTED': {
      for (const incoming of event.tasks) {
        const task = state.tasks.find(t => t.id === incoming.id);
        if (task) {
          // Incoming snapshots do not erase local confirmations/preferences.
          const { id, status, version, paused, snoozedUntil, notBefore, ...fields } = incoming;
          if (task.estimateOrigin === 'user') { delete fields.remainingMinutes; delete fields.estimateOrigin; }
          const different = Object.keys(fields).some(key => JSON.stringify(task[key]) !== JSON.stringify(fields[key]));
          const authoritativeStatus = status && ['submitted', 'graded'].includes(status.value) && ['bb_adapter', 'demo_bb'].includes(status.origin);
          const statusChanged = authoritativeStatus && (task.status.value !== status.value || task.status.origin !== status.origin);
          if (different || statusChanged) {
            Object.assign(task, fields, { version: task.version + 1 });
            if (authoritativeStatus) task.status = status;
            checkTask(task);
            changes.push({ task, message: '接入器更新了任务信息；未因缺少记录而撤销本地确认。' });
          }
        } else { const created = createTask(incoming); checkTask(created); state.tasks.push(created); }
      }
      state.sync = { state: 'adapter', checkedAt: state.now, message: '接入器已更新；未出现的任务保持原状态，不视为取消。' };
      break;
    }
    default: throw new Error(`不支持的事件类型：${event.type}`);
  }
  state.events.push({ ...event, observedAt: state.now, changes: changes.map(c => ({ taskId: c.task.id, message: c.message, before: c.before || null })) });
  reconcile(state);
  for (const change of changes) addChangeNotification(state, change.task, change.message, event.id);
  return state;
}

export function summarize(state) {
  return {
    tasks: state.tasks.length,
    active: state.tasks.filter(t => activeTask(t, state.profile)).length,
    plannedMinutes: state.plan.blocks.reduce((n, b) => n + duration(b), 0),
    risks: state.plan.risks.length,
    unread: state.notifications.filter(n => n.status === 'delivered').length,
    pending: state.notifications.filter(n => n.status === 'pending').length,
    today: localDate(state.now)
  };
}
