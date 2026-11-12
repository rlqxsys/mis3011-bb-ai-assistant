// Historical snapshot / regression demonstrations only. The automatic course
// pipeline uses ai/documents + ai/analysis, never these course-specific rules.
import { createTask, slug } from '../core/model.mjs';
import { extractDeadline, parsePosted } from '../core/time.mjs';

export function source(courseCode, path, locator, quote, role = 'course') {
  return { courseCode, path, locator, quote: quote || '', role };
}

function yearOf(course) {
  const counts = {};
  for (const a of course.ann) {
    const year = parsePosted(a.posted)?.slice(0, 4);
    if (year) counts[year] = (counts[year] || 0) + 1;
  }
  return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || null;
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(textOf).join('\n');
  return '';
}

function identity(course, term, url, title) {
  const contentId = url && new URL(url).searchParams.get('content_id');
  return `${course}:${term}:${contentId || slug(title)}`;
}

function policy(text) {
  return {
    late: /late submission is (?:strictly )?NOT allowed/i.test(text) ? 'not_allowed'
      : /late submission|day of late|days? later than/i.test(text) ? 'penalty' : 'unknown',
    attempts: /unlimited times/i.test(text) ? 'unlimited' : /multiple times/i.test(text) ? 'multiple' : 'unknown',
    scoring: /highest grade/i.test(text) ? 'highest' : /last submission|latest submission/i.test(text) ? 'last' : 'unknown'
  };
}

// Deterministic adapter. Course-specific, reviewed interpretations are explicit below;
// this is not a general LLM extractor and does not manufacture uncertain dates.
export function normalizeFeed(feed, capturedAt) {
  const tasks = [], notices = [];
  for (const course of feed.courses) {
    const term = yearOf(course), courseTasks = [];
    for (const [pi, page] of course.pages.entries()) {
      if (/last year|practice exams/i.test(page.n)) continue;
      for (const [ri, row] of page.rows.entries()) {
        const link = row.links.find(link => /uploadAssignment|launchAssessment/.test(link.u));
        if (!link || /answer|solution/i.test(row.title)) continue;
        const kind = /launchAssessment/.test(link.u) ? 'quiz' : /slides/i.test(row.title) ? 'upload' : 'assignment';
        const sources = [source(course.code, `courses/${course.code}.json`, `pages[${pi}].rows[${ri}]`, `${row.title}\n${row.body}`)];
        let body = row.body || '';
        for (const ref of row.links) {
          const attachment = feed.attachments[course.code].find(a => a.sourceUrl === ref.u);
          if (attachment?.contentFile && feed.texts[attachment.contentFile] && !/answer|solution/i.test(attachment.name)) {
            const content = textOf(feed.texts[attachment.contentFile]);
            body += `\n${content}`;
            sources.push(source(course.code, attachment.contentFile, '附件抽取文字', content, 'attachment'));
          }
        }
        const deadline = extractDeadline(body, term);
        const task = createTask({
          id: identity(course.code, term, link.u, row.title), courseCode: course.code, term,
          title: row.title, kind, url: link.u, deadline,
          policy: policy(body), sources, optional: /not counted in final grade/i.test(row.title),
          condition: /if you choose to use the classroom computer/i.test(body) ? 'classroom-computer' : null,
          splittable: kind !== 'quiz', remainingMinutes: kind === 'quiz' ? 30 : kind === 'upload' ? 20 : 120,
          requirements: [row.body || row.title],
          issues: !deadline?.at ? ['未取得明确截止时刻，不自动补为午夜。'] : []
        });
        courseTasks.push(task);
      }
    }
    for (const [ai, ann] of course.ann.entries()) {
      if (!/^Assignment\s+\d+$/i.test(ann.title)) continue;
      const deadline = extractDeadline(ann.body, term);
      if (!deadline) continue;
      let task = courseTasks.find(t => t.title.toLowerCase() === ann.title.toLowerCase());
      const proof = source(course.code, `courses/${course.code}.json`, `ann[${ai}] · ${ann.posted}`, ann.body, 'announcement');
      if (!task) {
        task = createTask({ id: identity(course.code, term, null, ann.title), courseCode: course.code, term, title: ann.title, remainingMinutes: 180 });
        courseTasks.push(task);
      }
      if (task.deadline?.precision === 'conflict') {
        // Once contradictory, keep all evidence and wait for explicit resolution.
      } else if (task.deadline?.date && task.deadline.date !== deadline.date) {
        task.issues.push('正文日期存在冲突，需要确认；暂不自动选择。');
        task.deadline = { ...task.deadline, at: null, precision: 'conflict' };
      } else task.deadline = deadline;
      task.sources.push(proof);
      task.policy = { ...task.policy, ...policy(ann.body) };
      task.requirements.push(ann.body);
    }
    for (const [gi, grade] of course.grades.entries()) {
      const name = grade[0].split('\n')[0].trim();
      if (/^(weighted total|total|participation)$/i.test(name)) continue;
      let task = courseTasks.find(t => t.title.toLowerCase() === name.toLowerCase());
      if (!task) {
        task = createTask({
          id: `${course.code}:${term}:grade-${slug(name)}`, courseCode: course.code, term, title: name,
          kind: /exam|mid.term/i.test(name) ? 'exam' : /\btest\b/i.test(grade[0]) ? 'quiz' : 'assignment',
          issues: ['仅有成绩条目，尚未可靠关联任务入口。']
        });
        courseTasks.push(task);
      }
      const raw = grade.join('\n');
      task.sources.push(source(course.code, `courses/${course.code}.json`, `grades[${gi}]`, raw, 'grade_snapshot'));
      const status = /\bGRADED\b/.test(raw) ? 'graded' : /\bSUBMITTED\b/.test(raw) ? 'submitted' : 'unknown';
      task.status = { value: status, origin: status === 'unknown' ? 'no_evidence' : 'bb_snapshot', at: capturedAt };
      if (!task.deadline) task.deadline = extractDeadline(grade[0], term);
      task.grade = grade[2];
      // Last activity is deliberately not stored as submittedAt.
    }
    for (const task of courseTasks) {
      const detail = course.details.find(d => d.u === task.url);
      if (detail) task.sources.push(source(course.code, `courses/${course.code}.json`, 'details · 可见记录并非完整回执', JSON.stringify(detail), 'attempt_metadata'));
    }
    tasks.push(...courseTasks);
    notices.push({ courseCode: course.code, message: '历史快照含模拟分数和提交时刻，不用于推断真实学习习惯。' });
  }
  return { tasks, notices, extractor: 'deterministic-v1; complex cases use reviewed course adapters' };
}

export function announcement(feed, code, title) {
  const course = feed.courses.find(c => c.code === code);
  const index = course.ann.findIndex(a => a.title === title);
  if (index < 0) throw new Error(`Missing source announcement: ${code} / ${title}`);
  const ann = course.ann[index];
  return source(code, `courses/${code}.json`, `ann[${index}] · ${ann.posted}`, ann.body, 'announcement');
}

export function reviewedTasks(feed) {
  const cscOld = announcement(feed, 'CSC1001', 'Time of Midterm and No Tutorial for that Day');
  const cscNew = announcement(feed, 'CSC1001', 'Important Update of Midterm Date and Time');
  const eng = announcement(feed, 'ENG1001', 'Notes on Individual Presentation');
  const finals = announcement(feed, 'ENG1001', 'Arrangements for Final Exams');
  const essay = announcement(feed, 'ENG1001', 'Assignment Submission for Personal Essay');
  const options = {};
  for (const section of ['L09', 'L10', 'L11', 'L12']) {
    const hour = ['L09', 'L10'].includes(section) ? '09:00' : '10:30';
    const end = ['L09', 'L10'].includes(section) ? '09:50' : '11:20';
    options[section] = { start: `2023-11-25T${hour}:00+08:00`, end: `2023-11-25T${end}:00+08:00`, location: 'TD307', arrivalMinutes: 15, approximateDuration: true };
  }
  return {
    cscExam: createTask({ id: 'CSC1001:2024:midterm', courseCode: 'CSC1001', term: '2024', title: 'Midterm Exam', kind: 'exam', channel: 'offline', remainingMinutes: 240, fixed: { start: '2024-11-01T19:00:00+08:00', end: '2024-11-01T21:00:00+08:00' }, sources: [cscOld], requirements: ['准备复习；考试地点稍后公布。'] }),
    cscTutorial: createTask({ id: 'CSC1001:2024:tutorial-1101', courseCode: 'CSC1001', term: '2024', title: '11 月 1 日 Tutorial', kind: 'tutorial', channel: 'offline', sections: ['T13', 'T14'], remainingMinutes: 0, fixed: null, status: { value: 'cancelled', origin: 'announcement', at: '2024-10-14T13:48:38+08:00' }, issues: ['原始 tutorial 具体时段不在交接包；恢复后仍需学生补充课表。'], sources: [cscOld] }),
    cscUpdate: cscNew,
    engPresentation: createTask({ id: 'ENG1001:2023:individual-presentation', courseCode: 'ENG1001', term: '2023', title: 'Individual Presentation · 本人展示', kind: 'presentation', channel: 'offline', remainingMinutes: 120, sources: [eng], requirements: ['4–5 分钟 Summary AND Response，另加约 1 分钟问答。', '只参加本人被安排的展示课次；无需正式商务着装，避免运动服。'], issues: ['个人排表外链失效，具体上台日期未知，不能把全部展示课次排给一人。'] }),
    engListening: createTask({ id: 'ENG1001:2023:listening-final', courseCode: 'ENG1001', term: '2023', title: 'Final Listening Exam', kind: 'exam', channel: 'offline', sectionOptions: options, remainingMinutes: 60, sources: [finals], issues: ['需选择 L09/L10/L11/L12；考试时长约 50 分钟。'], requirements: ['闭卷；提前 15 分钟到场。'] }),
    engEssay: createTask({ id: 'ENG1001:2023:personal-essay', courseCode: 'ENG1001', term: '2023', title: 'Personal Essay · VeriGuide', kind: 'assignment', channel: 'external', remainingMinutes: 120, sources: [essay], issues: ['10 月 18／19 日按分班上课开始时间截止，尚缺本人准确课时。'], requirements: ['仅通过本班 VeriGuide 链接线上提交，无需纸质封面或到教室交件。', '应收到成功确认邮件；平台目前不能读取该外部提交凭据。'] })
  };
}
