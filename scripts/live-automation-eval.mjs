import assert from 'node:assert/strict';
import { writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadReplayData, createReplayClient } from './feed-replay.mjs';

const data = await loadReplayData(), client = createReplayClient();
const report = { testType: 'native-BB_Source_Feed-historical-replay', actualModelTest: true,
  source: 'BB_Source_Feed', startedAt: new Date().toISOString(), checks: [], sourceAudit: [], runs: [] };
const check = (name, passed) => { report.checks.push({ name, passed: Boolean(passed) }); assert.ok(passed, name); console.log('PASS '+name); };
try {
  let state = await client.begin(data);
  check('初始基线只包含当时可见资料，尚未出现的考试公告没有提前解析', !state.tasks.length && !state.automation.pending.length);
  state = await client.release(data.initial);
  const exam = state.tasks.find(t => t.kind === 'exam'), tutorial = state.tasks.find(t => t.kind === 'tutorial');
  check('从原始公告识别 CSC1001 的 11月1日 19:00–21:00 考试', exam?.fixed?.start && Date.parse(exam.fixed.start) === Date.parse('2024-11-01T19:00:00+08:00') && Date.parse(exam.fixed.end) === Date.parse('2024-11-01T21:00:00+08:00'));
  check('原始公告明确取消的 Tutorial 保留为取消状态', tutorial?.status.value === 'cancelled');
  check('未手动生成计划，考试自动进入准备安排', state.plan.blocks.some(b => b.taskId === exam.id));
  const oldNotices = state.notifications.filter(n => n.taskId === exam.id && n.status === 'pending').map(n => n.id);
  report.beforeChange = { tasks: state.tasks, plan: state.plan, notifications: state.notifications };
  state = await client.release(data.update);
  const changed = state.tasks.find(t => t.id === exam.id), restored = state.tasks.find(t => t.id === tutorial?.id);
  check('真实改期公告自动更新同一考试为 11月10日，未新建另一考试', state.tasks.filter(t => t.kind === 'exam').length === 1 && Date.parse(changed?.fixed?.start) === Date.parse('2024-11-10T19:00:00+08:00'));
  check('原 Tutorial 恢复，未编造原始包缺失的课时', restored?.status.value === 'unknown' && restored.version > tutorial.version && !restored.fixed);
  check('改期前待发提醒已撤销', oldNotices.length > 0 && oldNotices.every(id => state.notifications.find(n => n.id === id)?.status !== 'pending'));
  state = await client.includeEconometrics(data);
  const assignment = state.tasks.find(t => t.courseCode === 'ECO3121' && t.sources.some(s => s.documentId === data.assignment.id));
  check('ECO3121 原文的 11月2日 15:00 截止和不接受迟交保持准确', Date.parse(assignment?.deadline?.at) === Date.parse('2024-11-02T15:00:00+08:00') && assignment.policy.late === 'not_allowed');
  check('真实作业进入规划器与提醒队列', state.plan.blocks.some(b => b.taskId === assignment.id) && state.notifications.some(n => n.taskId === assignment.id));
  for (const run of state.aiRuns) {
    for (const doc of run.documents || []) {
      const original = data.documents.find(d => d.id === doc.id);
      assert.ok(original, '模型输入必须对应原始包中的文档 ID');
      assert.deepEqual(doc, original, '模型输入的课程、学期、正文、日期、路径与原始解析完全一致');
      report.sourceAudit.push(data.originals.find(d => d.id === doc.id));
    }
  }
  check('所有模型输入逐字段对齐原始包，未复制改写正文或替换课程／日期', report.sourceAudit.length > 0);
  const realCourses = new Set(data.feed.courses.map(c => c.code));
  check('当前所有任务均属于原始包课程，且每项有原文引用', state.tasks.every(t => realCourses.has(t.courseCode) && t.sources.length && t.sources.every(s => s.role !== 'synthetic_fixture')));
  check('模型由后台源更新触发，没有手动调用分析接口或规则替身', state.aiRuns.every(r => r.transport === 'live_http' && r.trigger === 'source_update'));
  const runs = state.aiRuns.length; await new Promise(resolve => setTimeout(resolve, 5700)); state = await client.call('/api/state');
  check('原始包未变化时不重复调用模型', state.aiRuns.length === runs);
  check('增量输入目录没有遗留的虚拟资料', !(await readdir(fileURLToPath(new URL('../.local/course-inbox/', import.meta.url)))).some(n => n.endsWith('.json')));
  state = await client.call('/api/automation/config', { subscriptions: data.subscriptions, replaySources: true });
  check('跟进范围仅为原始包中的五门课程和对应历史学期', state.automation.subscriptions.length === 5 && state.automation.subscriptions.every(s => data.subscriptions.some(c => c.courseCode === s.courseCode && c.term === s.term)));
  report.runs = state.aiRuns.map(r => ({ id: r.id, documents: r.documents.map(d => d.id), model: r.model, transport: r.transport, trigger: r.trigger, usage: r.usage, elapsedMs: r.elapsedMs, responseId: r.responseId }));
  report.final = { now: state.now, tasks: state.tasks, plan: state.plan, notifications: state.notifications, subscriptions: state.automation.subscriptions };
  report.status = 'passed';
  await writeFile(fileURLToPath(new URL('../examples/automation-live-output.json', import.meta.url)), JSON.stringify({ evidenceType: report.testType, documents: state.aiRuns.flatMap(r => r.documents || []), modelRuns: state.aiRuns, ...report.final }, null, 2));
} catch (error) { report.status = 'failed'; report.error = error.message; console.error(error.message); process.exitCode = 1; }
finally {
  report.passed = report.checks.filter(c => c.passed).length; report.finishedAt = new Date().toISOString();
  await writeFile(fileURLToPath(new URL('../artifacts/live-automation-report.json', import.meta.url)), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, passed: report.passed, error: report.error }));
}
