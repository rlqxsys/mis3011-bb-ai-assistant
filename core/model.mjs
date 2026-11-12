export const CLOSED = new Set(['submitted', 'graded', 'user_confirmed', 'cancelled', 'exempt']);
export const STATUS_LABELS = {
  unknown: '未检测到完成证据', draft: '草稿／进行中，尚未正式提交',
  submitted: 'BB 显示已提交', graded: 'BB 显示已评分',
  user_confirmed: '你已确认完成（非 BB 验证）', cancelled: '已取消', exempt: '已豁免'
};
export const KIND_LABELS = { assignment: '作业', quiz: '在线测验', exam: '考试', presentation: '口头展示', upload: '材料上传', tutorial: 'Tutorial' };
export const slug = text => text.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

export function createTask(data) {
  return {
    id: data.id, courseCode: data.courseCode, term: data.term,
    title: data.title, kind: data.kind || 'assignment', channel: 'bb',
    deadline: null, opensAt: null, closesAt: null, durationMinutes: null,
    fixed: null, sectionOptions: null, condition: null,
    requirements: [], issues: [], sources: [], version: 1,
    status: { value: 'unknown', origin: 'no_evidence', at: null },
    remainingMinutes: 90, estimateOrigin: 'demo_default', splittable: true,
    notBefore: null, paused: false, snoozedUntil: null, ...data
  };
}

export function applicability(task, profile) {
  if (task.condition === 'classroom-computer') {
    const choice = profile.devices[task.courseCode];
    if (!choice) return 'unknown';
    if (choice === 'own') return 'not_applicable';
  }
  if (task.sections?.length) {
    const section = profile.sections[task.courseCode];
    if (!section) return 'unknown';
    if (!task.sections.includes(section)) return 'not_applicable';
  }
  if (task.sectionOptions) return task.sectionOptions[profile.sections[task.courseCode]] ? 'applicable' : 'unknown';
  return 'applicable';
}

export function fixedFor(task, profile) {
  if (task.sectionOptions) return task.sectionOptions[profile.sections[task.courseCode]] || null;
  return task.fixed;
}

export function activeTask(task, profile) {
  return !CLOSED.has(task.status.value) && (!task.optional || profile.includeOptional) && applicability(task, profile) === 'applicable';
}

export function taskEnd(task, profile) {
  const end = task.deadline?.at || fixedFor(task, profile)?.start || null;
  if (task.closesAt && (!end || Date.parse(task.closesAt) < Date.parse(end))) return task.closesAt;
  return end;
}

export function defaultProfile() {
  return {
    timezone: 'Asia/Shanghai', sections: {}, devices: {}, includeOptional: false,
    availability: Array.from({ length: 7 }, (_, day) => ({ day, start: '19:00', end: '21:30' })),
    busy: [], dailyLimitMinutes: 120, blockMinutes: 50, breakMinutes: 10,
    bufferMinutes: 20, horizonDays: 21, quiet: { start: '22:00', end: '08:00' }
  };
}
