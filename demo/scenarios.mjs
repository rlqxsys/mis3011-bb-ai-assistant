import { normalizeFeed, reviewedTasks, source } from './feed-adapter.mjs';
import { createState, reconcile } from '../core/engine.mjs';

export const scenarios = [
  { id: 'submission', title: '作业完整流程', subtitle: '导入 → 排期 → 提醒 → 模拟 BB 提交 → 自动释放时间', notes: '正式日期和要求来自原文；假定这些任务当时可见。未导入后来成绩；提交事件为显式模拟，不是真实 BB 操作。' },
  { id: 'exam-change', title: '考试改期与 Tutorial 恢复', subtitle: '真实通知关联变化 · 保留任务身份，撤销旧提醒', notes: '按 2024-10-14 / 10-17 公告顺序回放。Tutorial 的原时段未知，恢复后仍待确认，不虚构课时。' },
  { id: 'capacity', title: '推迟后是否来得及', subtitle: 'ECO3121 真实作业的 15:00 截止 · 推迟准备后的容量变化', notes: '任务和截止来自原始公告；剩余用时、空闲窗口和推迟操作仅作为排期测试条件。' },
  { id: 'english', title: '分班与条件性交件', subtitle: '选择分班 · 上传不等于展示完成 · 外部提交', notes: '保留个人展示日期未知；分班考试来自公告。作文只展示外部渠道，不挪用至当前时间安排。' }
];

export function loadScenario(feed, id, capturedAt = new Date().toISOString()) {
  const spec = scenarios.find(s => s.id === id);
  if (!spec) throw new Error('未知演示场景。');
  const catalog = normalizeFeed(feed, capturedAt), known = reviewedTasks(feed);
  const find = (course, title) => {
    const original = catalog.tasks.find(t => t.courseCode === course && t.title === title);
    if (!original) throw new Error(`任务源缺失：${course} ${title}`);
    const task = structuredClone(original);
    task.status = { value: 'unknown', origin: 'replay_initial', at: null };
    delete task.grade;
    task.sources = task.sources.filter(s => !['grade_snapshot', 'attempt_metadata'].includes(s.role));
    return task;
  };
  let tasks, now, profile = {};
  if (id === 'submission') {
    now = '2024-11-22T09:00:00+08:00';
    tasks = [find('CSC1001', 'Assignment 2'), find('ECO3121', 'Assignment 3')];
    tasks[0].remainingMinutes = 120;
    tasks[1].remainingMinutes = 180;
  } else if (id === 'exam-change') {
    now = '2024-10-15T10:00:00+08:00';
    tasks = [known.cscExam, known.cscTutorial];
    profile = { sections: { CSC1001: 'T13' } };
  } else if (id === 'capacity') {
    now = '2024-11-01T10:00:00+08:00';
    const assignment = find('ECO3121', 'Assignment 2');
    assignment.remainingMinutes = 120;
    tasks = [assignment];
    profile = { availability: [{ day: 5, start: '19:00', end: '21:00' }, { day: 6, start: '10:00', end: '12:00' }], dailyLimitMinutes: 120 };
  } else {
    now = '2023-11-24T09:00:00+08:00';
    const slides = find('ENG1001', 'Slides for Individual Presentation');
    tasks = [known.engPresentation, slides, known.engListening, known.engEssay];
  }
  const state = createState({ now, mode: 'replay', tasks, profile, scenario: spec, imported: { ...feed.stats, capturedAt } });
  return reconcile(state);
}

export function scenarioEvents(feed, state) {
  if (state.scenario?.id === 'exam-change') {
    const proof = reviewedTasks(feed).cscUpdate;
    return [
      { id: 'replay:notice-1017:clock', type: 'CLOCK_ADVANCED', to: '2024-10-17T19:20:00+08:00' },
      { id: 'replay:notice-1017:exam', type: 'TASK_CHANGED', taskId: 'CSC1001:2024:midterm', patch: { fixed: { start: '2024-11-10T19:00:00+08:00', end: '2024-11-10T21:00:00+08:00' } }, source: proof, message: '期中考试由 11 月 1 日 19:00–21:00 改为 11 月 10 日同一时段；旧提醒已撤销，复习安排已重新检查。' },
      { id: 'replay:notice-1017:tutorial', type: 'STATUS_RECORDED', taskId: 'CSC1001:2024:tutorial-1101', value: 'unknown', origin: 'announcement', source: proof, note: '11 月 1 日 Tutorial 恢复；原课时仍需补充。' }
    ];
  }
  if (state.scenario?.id === 'submission') {
    const task = state.tasks.find(t => t.courseCode === 'CSC1001');
    return [{ id: 'replay:csc-a2:submission', type: 'STATUS_RECORDED', taskId: task.id, value: 'submitted', origin: 'demo_bb', note: '模拟接入器收到成功提交，未操作学校 BB。', source: source('CSC1001', 'demo/scenarios.mjs', 'submission event', '用于验证联动的模拟成功提交事件，不是真实回执。', 'synthetic_fixture') }];
  }
  if (state.scenario?.id === 'capacity') return [{ id: 'replay:capacity:postpone', type: 'TASK_DEFERRED', taskId: state.tasks[0].id, until: '2024-11-02T12:00:00+08:00' }];
  const task = state.tasks.find(t => t.title === 'Slides for Individual Presentation');
  return [{ id: 'replay:eng:slides', type: 'STATUS_RECORDED', taskId: task.id, value: 'submitted', origin: 'demo_bb', note: '模拟幻灯片已提交，但不代表本人已经完成展示。' }];
}
