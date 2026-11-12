import { activeTask, applicability, CLOSED, taskEnd } from './model.mjs';
import { DAY, MINUTE, iso, localDate, ms, quietUntil } from './time.mjs';

export function updateReminders(state) {
  const { tasks, now, profile } = state;
  for (const n of state.notifications) {
    if (n.status !== 'pending' || !n.taskId) continue;
    const task = tasks.find(t => t.id === n.taskId);
    if (!task || task.version !== n.taskVersion || CLOSED.has(task.status.value)
      || applicability(task, profile) === 'not_applicable' || (task.paused && n.type !== 'change')) n.status = 'cancelled';
    else if (taskEnd(task, profile) && ms(taskEnd(task, profile)) <= ms(now) && ['deadline', 'plan', 'risk'].includes(n.type)) n.status = 'cancelled';
  }
  const add = ({ task = null, type, key, scheduledAt, title, body, urgent = false }) => {
    const id = `${state.userId}:${key}`;
    const existing = state.notifications.find(n => n.id === id);
    if (existing && existing.status !== 'cancelled') return;
    if (task && task.paused && type !== 'change') return;
    const wake = task?.snoozedUntil && type !== 'change' ? Math.max(ms(scheduledAt), ms(task.snoozedUntil)) : ms(scheduledAt);
    let deliverAt = quietUntil(iso(wake), profile.quiet);
    const end = task && taskEnd(task, profile);
    // In-app only: retain time-critical information silently rather than hiding it past DDL.
    const quietConflict = end && ms(deliverAt) > wake && ms(deliverAt) >= ms(end);
    if (quietConflict || urgent) deliverAt = iso(wake);
    const record = { id, taskId: task?.id || null, taskVersion: task?.version || null,
      type, scheduledAt, deliverAt, title, body, quietConflict: Boolean(quietConflict), silent: Boolean(quietConflict), status: 'pending' };
    if (existing) Object.assign(existing, record);
    else state.notifications.push(record);
  };
  if (state.mode === 'snapshot' || state.mode === 'empty') return;
  for (const task of tasks) {
    if (task.optional && !profile.includeOptional) continue;
    if (CLOSED.has(task.status.value) || applicability(task, profile) === 'not_applicable') continue;
    const end = taskEnd(task, profile);
    if (!end || applicability(task, profile) === 'unknown') {
      add({ task, type: 'clarify', key: `${task.id}:v${task.version}:clarify`, scheduledAt: now,
        title: `${task.title}：需要确认`, body: applicability(task, profile) === 'unknown' ? '请确认分班或是否使用教室电脑，不会先按所有候选安排提醒。' : '没有明确的个人时间；请核实来源或补充时间，系统未猜测截止时刻。' });
      continue;
    }
    if (!activeTask(task, profile)) continue;
    if (ms(end) <= ms(now)) {
      add({ task, type: 'verify', key: `${task.id}:v${task.version}:verify`, scheduledAt: now,
        title: `${task.title}：完成情况待核实`, body: task.channel === 'offline' ? '原定参加时间已到或已过，平台无法核实你是否参加。不会将此判为未参加或继续催交文件。' : '正式处理时间已到或已过，当前仍缺少完成确认。若已提交可自行确认；系统没有判定你漏交。' });
      continue;
    }
    add({ task, type: 'deadline', key: `${task.id}:v${task.version}:deadline`, scheduledAt: iso(Math.max(ms(now), ms(end) - DAY)),
      title: `${task.title}：临近正式时间`, body: `${task.courseCode} 的正式时间为 ${end}。当前未检测到完成证据；这不代表你尚未开始。` });
  }
  for (const risk of state.plan.risks.filter(r => ['insufficient_time', 'fixed_conflict', 'locked_conflict'].includes(r.code))) {
    const task = tasks.find(t => t.id === risk.taskId);
    add({ task, type: 'risk', key: `${risk.taskId}:v${task.version}:${risk.code}:p${state.profileVersion}`, scheduledAt: now, title: `${task.title}：安排需要调整`, body: risk.message });
  }
  const firstOfDay = new Set();
  for (const block of state.plan.blocks) {
    const task = tasks.find(t => t.id === block.taskId);
    if (ms(block.start) <= ms(now)) continue;
    const dayKey = `${block.taskId}:${localDate(block.start)}`;
    if (firstOfDay.has(dayKey)) continue;
    firstOfDay.add(dayKey);
    add({ task, type: 'plan', key: `${block.id}:v${task.version}:start`, scheduledAt: iso(Math.max(ms(now), ms(block.start) - 15 * MINUTE)), title: `准备时段：${task.title}`, body: `计划 ${block.start} 至 ${block.end}。这是准备安排，不是正式 DDL。` });
  }
  // Remove queued plan reminders whose slots disappeared after a local replan.
  for (const n of state.notifications) {
    if (n.status === 'pending' && n.taskId) {
      const task = tasks.find(t => t.id === n.taskId);
      if (task && n.type !== 'change') {
        const wake = Math.max(ms(n.scheduledAt), task.snoozedUntil ? ms(task.snoozedUntil) : 0);
        n.deliverAt = quietUntil(iso(wake), profile.quiet);
        const end = taskEnd(task, profile);
        if (end && ms(n.deliverAt) > wake && ms(n.deliverAt) >= ms(end)) { n.deliverAt = iso(wake); n.silent = true; n.quietConflict = true; }
      }
    }
    if (n.type === 'plan' && n.status === 'pending' && !state.plan.blocks.some(b => n.id.includes(`${b.id}:v`))) n.status = 'cancelled';
  }
  const open = tasks.filter(t => activeTask(t, profile) && taskEnd(t, profile) && ms(taskEnd(t, profile)) > ms(now));
  if (open.length) add({ type: 'digest', key: `digest:${localDate(now)}`, scheduledAt: `${localDate(now)}T08:00:00+08:00`, title: '今日安排摘要', body: `${open.length} 项尚待核实完成的任务；${state.plan.blocks.filter(b => localDate(b.start) === localDate(now)).length} 段今日准备安排。` });
  for (const n of state.notifications) {
    if (n.status === 'pending' && ms(n.deliverAt) <= ms(now)) {
      n.status = 'delivered';
      n.deliveredAt = now;
    }
  }
}

export function addChangeNotification(state, task, message, eventId) {
  const id = `${state.userId}:change:${eventId}:${task.id}`;
  if (!state.notifications.some(n => n.id === id)) state.notifications.push({
    id, taskId: task.id, taskVersion: task.version, type: 'change', scheduledAt: state.now,
    deliverAt: state.now, deliveredAt: state.now, title: `${task.title}：信息已更新`, body: message, status: 'delivered'
  });
}
