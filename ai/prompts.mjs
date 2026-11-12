import { readFileSync } from 'node:fs';

// Editing prompt text does not restart the service or discard its in-memory key.
const prompt = name => readFileSync(new URL(`./prompts/${name}.txt`, import.meta.url), 'utf8');

export function analysisMessages(documents, state, schema) {
  const courses = new Set(documents.map(d => `${d.courseCode}:${d.term}`));
  const tasks = state.tasks.filter(t => courses.has(`${t.courseCode}:${t.term}`)).map(t => ({
    id: t.id, courseCode: t.courseCode, term: t.term, title: t.title, kind: t.kind,
    deadline: t.deadline, fixed: t.fixed, status: t.status.value, version: t.version,
    requirements: t.requirements, condition: t.condition, sections: t.sections, durationMinutes: t.durationMinutes,
    sourceRefs: t.sources.filter(s => !['grade_snapshot', 'attempt_metadata'].includes(s.role)).slice(-5).map(s => ({ documentId: s.documentId, contentId: s.contentId, publishedAt: s.publishedAt, quote: String(s.quote || '').slice(0, 1800) }))
  }));
  return [
    { role: 'system', content: `${prompt('analysis')}\n输出 JSON schema：${JSON.stringify(schema)}` },
    { role: 'user', content: JSON.stringify({ documents, existingTasks: tasks, knownStudentSections: state.profile.sections,
      note: 'existingTasks 是匹配上下文，不是本次资料；currentTime 不是课程发布时间。', currentTime: state.now, timezone: 'Asia/Shanghai' }) }
  ];
}

export function commandMessages(instruction, state, schema) {
  return [
    { role: 'system', content: `${prompt('commands')}\n输出 JSON schema：${JSON.stringify(schema)}` },
    { role: 'user', content: JSON.stringify({ instruction, now: state.now, timezone: 'Asia/Shanghai',
      tasks: state.tasks.map(t => ({ id: t.id, title: t.title, courseCode: t.courseCode, term: t.term, remainingMinutes: t.remainingMinutes, deadline: t.deadline, fixed: t.fixed })),
      profile: state.profile }) }
  ];
}
