import { activeTask, applicability, CLOSED, fixedFor, taskEnd } from './model.mjs';
import { MINUTE, DAY, atLocal, duration, intersects, iso, localDate, ms, nextDate, weekday } from './time.mjs';

function subtract(window, occupied) {
  let pieces = [window];
  for (const busy of occupied) {
    pieces = pieces.flatMap(piece => {
      if (!intersects(piece, busy)) return [piece];
      const result = [];
      if (ms(busy.start) > ms(piece.start)) result.push({ start: piece.start, end: busy.start });
      if (ms(busy.end) < ms(piece.end)) result.push({ start: busy.end, end: piece.end });
      return result;
    });
  }
  return pieces;
}

function windowsFor(profile, now) {
  const windows = [];
  for (let i = 0; i < profile.horizonDays; i++) {
    const date = nextDate(localDate(now), i);
    for (const row of profile.availability.filter(a => a.day === weekday(date))) {
      const start = Math.max(ms(atLocal(date, row.start)), Math.ceil(ms(now) / (15 * MINUTE)) * 15 * MINUTE);
      const end = ms(atLocal(date, row.end));
      if (start < end) windows.push({ start: iso(start), end: iso(end) });
    }
  }
  const merged = [];
  for (const w of windows.sort((a, b) => ms(a.start) - ms(b.start))) {
    const last = merged.at(-1);
    if (last && ms(w.start) <= ms(last.end)) last.end = iso(Math.max(ms(last.end), ms(w.end)));
    else merged.push({ ...w });
  }
  return merged;
}

export function planTasks(tasks, profile, now, previous = []) {
  const windows = windowsFor(profile, now), fixed = [], blocks = [], risks = [], used = {};
  for (const task of tasks) {
    const event = fixedFor(task, profile);
    if (!CLOSED.has(task.status.value) && applicability(task, profile) === 'applicable' && event && ms(event.end) > ms(now)) {
      fixed.push({ ...event, taskId: task.id, title: task.title, kind: task.kind });
    }
  }
  for (let i = 0; i < fixed.length; i++) {
    for (let j = i + 1; j < fixed.length; j++) {
      if (intersects(fixed[i], fixed[j])) risks.push({ taskId: fixed[i].taskId, code: 'fixed_conflict', message: `固定事件与 ${fixed[j].title} 冲突，不能自动移动考试。` });
    }
  }
  const occupied = [...profile.busy, ...fixed.map(f => ({ start: iso(ms(f.start) - (f.arrivalMinutes || 0) * MINUTE), end: f.end }))];
  const active = tasks.filter(t => activeTask(t, profile));
  const cutoff = task => ms(taskEnd(task, profile)) - profile.bufferMinutes * MINUTE;
  const reserve = block => {
    blocks.push(block);
    const date = localDate(block.start);
    used[date] = (used[date] || 0) + duration(block);
    occupied.push({ start: iso(ms(block.start) - profile.breakMinutes * MINUTE), end: iso(ms(block.end) + profile.breakMinutes * MINUTE) });
  };
  const validBlock = (block, task) => {
    const date = localDate(block.start);
    return ms(block.start) >= ms(now) && ms(block.end) <= cutoff(task)
      && (!task.notBefore || ms(block.start) >= ms(task.notBefore))
      && (!task.opensAt || ms(block.start) >= ms(task.opensAt))
      && windows.some(w => ms(block.start) >= ms(w.start) && ms(block.end) <= ms(w.end))
      && !occupied.some(w => intersects(w, block))
      && (used[date] || 0) + duration(block) <= profile.dailyLimitMinutes;
  };
  // Keep valid locked slots first, then unchanged tasks. Changed tasks get replanned.
  const retained = previous.filter(b => ms(b.start) >= ms(now)).sort((a, b) => Number(b.locked) - Number(a.locked) || ms(a.start) - ms(b.start));
  for (const block of retained) {
    const task = active.find(t => t.id === block.taskId);
    if (!task || !taskEnd(task, profile) || (!block.locked && block.taskVersion !== task.version)) continue;
    const already = blocks.filter(b => b.taskId === task.id).reduce((n, b) => n + duration(b), 0);
    if (already + duration(block) > task.remainingMinutes) continue;
    if (validBlock(block, task)) reserve({ ...block, taskVersion: task.version });
    else if (block.locked) risks.push({ taskId: task.id, code: 'locked_conflict', message: '锁定时段与新约束冲突，已移出有效计划，需要确认。' });
  }
  const candidates = active.filter(t => t.remainingMinutes > 0 && taskEnd(t, profile));
  const potential = task => {
    const totals = {};
    for (const w of windows) {
      const from = Math.max(ms(w.start), task.notBefore ? ms(task.notBefore) : 0, task.opensAt ? ms(task.opensAt) : 0);
      const to = Math.min(ms(w.end), cutoff(task));
      if (to <= from) continue;
      for (const p of subtract({ start: iso(from), end: iso(to) }, occupied)) {
        const date = localDate(p.start);
        totals[date] = (totals[date] || 0) + duration(p);
      }
    }
    return Object.entries(totals).reduce((n, [date, minutes]) => n + Math.min(minutes, Math.max(0, profile.dailyLimitMinutes - (used[date] || 0))), 0);
  };
  candidates.sort((a, b) => (potential(a) - a.remainingMinutes) - (potential(b) - b.remainingMinutes)
    || Number(b.policy?.late === 'not_allowed') - Number(a.policy?.late === 'not_allowed')
    || cutoff(a) - cutoff(b) || a.id.localeCompare(b.id));
  for (const task of candidates) {
    if (cutoff(task) <= ms(now)) {
      risks.push({ taskId: task.id, code: 'past_deadline', message: '正式时间已过或不足提交缓冲；完成情况仍需核实，未判定漏交。' });
      continue;
    }
    let remaining = task.remainingMinutes - blocks.filter(b => b.taskId === task.id).reduce((n, b) => n + duration(b), 0);
    const reason = task.policy?.late === 'not_allowed' ? '不接受迟交，优先保证截止前的可用时段。' : '按剩余可用时间与预计用时排序；未改变固定日程。';
    for (const w of windows) {
      if (remaining <= 0) break;
      let cursor = Math.max(ms(w.start), task.notBefore ? ms(task.notBefore) : 0, task.opensAt ? ms(task.opensAt) : 0);
      const end = Math.min(ms(w.end), cutoff(task));
      while (cursor < end && remaining > 0) {
        const pieces = subtract({ start: iso(cursor), end: iso(end) }, occupied);
        const piece = pieces.find(p => duration(p) >= Math.min(15, remaining));
        if (!piece) break;
        const date = localDate(piece.start), dailyLeft = profile.dailyLimitMinutes - (used[date] || 0);
        const minutes = Math.min(remaining, task.splittable ? profile.blockMinutes : remaining, duration(piece), dailyLeft);
        if (minutes < Math.min(15, remaining) || (!task.splittable && minutes < remaining)) {
          cursor = ms(piece.end);
          continue;
        }
        const start = piece.start, finish = iso(ms(start) + minutes * MINUTE);
        reserve({ id: `${task.id}@${start}`, taskId: task.id, taskVersion: task.version, start, end: finish, locked: false, reason });
        remaining -= minutes;
        cursor = ms(finish) + profile.breakMinutes * MINUTE;
      }
    }
    if (remaining > 0) {
      const beyondHorizon = ms(taskEnd(task, profile)) > ms(now) + profile.horizonDays * DAY;
      risks.push({ taskId: task.id, code: beyondHorizon ? 'beyond_horizon' : 'insufficient_time', missingMinutes: remaining,
        message: beyondHorizon ? `当前 ${profile.horizonDays} 天规划窗口尚有 ${remaining} 分钟未安排。` : `截止前仍缺 ${remaining} 分钟可安排时间；请调整空闲时间、预计用时或其他安排。` });
    }
  }
  for (const task of active) {
    if (!taskEnd(task, profile) && task.remainingMinutes > 0) risks.push({ taskId: task.id, code: 'needs_time', message: '缺少明确截止／本人参加时间，未擅自排期。' });
  }
  return { blocks: blocks.sort((a, b) => ms(a.start) - ms(b.start)), fixed, risks };
}
