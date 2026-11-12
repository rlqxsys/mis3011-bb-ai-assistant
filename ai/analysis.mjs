import { createTask, slug, KIND_LABELS } from '../core/model.mjs';
import { applyEvent, reconcile } from '../core/engine.mjs';
import { validTime, ms } from '../core/time.mjs';
import { hash } from './documents.mjs';

const compact = text => String(text || '').replace(/\s+/g, ' ').trim();
const unique = values => [...new Set(values)];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const dateOK = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && validTime(`${value}T12:00:00Z`) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
export const timeOK = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && dateOK(value.slice(0, 10)) && validTime(value);

export function taskContextKey(state) { return hash(state.tasks.map(t => [t.id, t.version])); }

function evidenceFor(item, documents) {
  if (!Array.isArray(item.evidence) || !item.evidence.length) throw new Error('缺少原文证据。');
  return item.evidence.map(ref => {
    const doc = documents.find(d => d.id === ref.documentId);
    if (!doc || compact(ref.quote).length < 4 || !compact(`${doc.title}\n${doc.text}`).includes(compact(ref.quote))) throw new Error('引用无法在所选原文中定位。');
    return { ...ref, doc };
  });
}

function calibratedEstimate(item, state) {
  const initial = item.estimatedMinutes ?? 90;
  if (!Number.isFinite(initial) || initial < 0 || initial > 20_000) throw new Error('准备时长建议无效。');
  const rows = (state.effortFeedback || []).filter(r => r.kind === item.kind && r.estimatedMinutes > 0);
  const ratios = rows.map(r => r.actualMinutes / r.estimatedMinutes).sort((a, b) => a - b);
  const median = ratios.length % 2 ? ratios[Math.floor(ratios.length / 2)] : (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2;
  const ratio = rows.length >= 3 ? Math.max(0.5, Math.min(2, median)) : 1;
  const minutes = Math.max(item.kind === 'quiz' ? item.durationMinutes || 0 : 0, Math.round(initial * ratio));
  return { minutes, initial, samples: rows.length, origin: rows.length >= 3 ? 'feedback_calibrated' : item.estimatedMinutes ? 'ai_estimate' : 'default_estimate' };
}

function changesOnly(item, target) {
  if (!target) return;
  // Repeated established facts are not new claims requiring a new citation.
  const known = { deadlineAt: target.deadline?.at, deadlineDate: target.deadline?.date,
    opensAt: target.opensAt, closesAt: target.closesAt, durationMinutes: target.durationMinutes,
    condition: target.condition, latePolicy: target.policy?.late,
    attempts: target.policy?.attempts, scoring: target.policy?.scoring };
  for (const [field, old] of Object.entries(known)) if (item[field] != null && same(item[field], old)) item[field] = null;
  if (same([...(item.sections || [])].sort(), [...(target.sections || [])].sort())) item.sections = [];
  item.requirements = (item.requirements || []).filter(r => !target.requirements.includes(r));
}

export function compileAnalysis(value, documents, state, runId) {
  if (!value || !Array.isArray(value.items) || typeof value.summary !== 'string') throw new Error('AI 返回的任务结构无效。');
  state = structuredClone(state);
  const events = [], decisions = [], questions = [...(value.questions || [])];
  const record = event => { state = applyEvent(state, event); events.push(event); };
  for (const [index, raw] of value.items.entries()) {
    const item = structuredClone(raw);
    const eventId = `${runId}:item:${index}`;
    try {
      if (typeof item.title !== 'string' || !item.title.trim() || !(item.kind in KIND_LABELS) || !['bb', 'external', 'offline'].includes(item.channel)) throw new Error('任务名称或类型无效。');
      if (!['new', 'update', 'supplement', 'cancel', 'reinstate', 'conflict', 'ignore'].includes(item.operation)) throw new Error('未知的信息关系。');
      const evidence = evidenceFor(item, documents), doc = evidence[0].doc;
      if (evidence.some(e => e.doc.courseCode !== doc.courseCode || e.doc.term !== doc.term)) throw new Error('一项任务不能混用不同课程或学期的证据。');
      const sources = evidence.map(e => ({ path: e.doc.sourcePath, locator: e.doc.locator, quote: e.quote,
        role: 'ai_grounded', documentId: e.doc.id, documentVersion: e.doc.version,
        contentId: e.doc.contentId, publishedAt: e.doc.publishedAt, aiRunId: runId }));
      const supported = field => evidence.some(e => (e.fields || []).includes(field));
      const needsEvidence = field => { if (!supported(field)) throw new Error(`${field} 缺少字段对应的来源证据。`); };
      let target = item.targetTaskId ? state.tasks.find(t => t.id === item.targetTaskId) : null;
      if (item.targetTaskId && !target) throw new Error('引用了不存在的旧任务。');
      if (target && (target.courseCode !== doc.courseCode || target.term !== doc.term)) throw new Error('目标任务不属于本课程学期。');
      if (!target && item.operation === 'new') {
        const stableId = doc.contentId && `${doc.courseCode}:${doc.term}:${doc.contentId}`;
        target = state.tasks.find(t => (t.id === stableId && t.kind === item.kind && slug(t.title) === slug(item.title)) || (t.courseCode === doc.courseCode && t.term === doc.term && t.kind === item.kind && slug(t.title) === slug(item.title) && t.sources.some(s => s.documentId === doc.id)));
      }
      if (!target && !['new', 'ignore', 'conflict', 'cancel', 'reinstate'].includes(item.operation)) throw new Error('尚未匹配到被修改的任务，需确认关联。');
      if (item.operation === 'ignore') { decisions.push({ title: item.title, operation: 'ignore', outcome: 'ignored', reason: item.reason, sources }); continue; }
      if (item.operation === 'conflict') throw new Error(item.reason || '新旧信息冲突，无法自动裁决。');
      const latest = target?.sources.map(s => s.publishedAt).filter(validTime).sort((a, b) => ms(b) - ms(a))[0];
      const newestInput = evidence.map(e => e.doc.publishedAt).filter(validTime).sort((a, b) => ms(b) - ms(a))[0];
      if (target && latest && newestInput && ms(newestInput) < ms(latest)) throw new Error('输入早于已知正式信息，不自动覆盖较新的安排。');
      changesOnly(item, target);
      if (['cancel', 'reinstate'].includes(item.operation)) {
        needsEvidence(item.operation);
      }
      const patch = {}, unclear = new Set((item.uncertainties || []).map(u => u.field));
      for (const u of item.uncertainties || []) questions.push(`${item.title}：${u.question}`);
      if (item.deadlineAt && !unclear.has('deadlineAt')) {
        needsEvidence('deadlineAt');
        if (!timeOK(item.deadlineAt)) throw new Error('截止时刻无效或没有明确时区。');
        patch.deadline = { at: item.deadlineAt, date: item.deadlineAt.slice(0, 10), precision: 'minute', origin: 'ai_grounded' };
      } else if (item.deadlineDate && !target?.deadline?.at && !unclear.has('deadlineDate')) {
        needsEvidence('deadlineDate');
        if (!dateOK(item.deadlineDate)) throw new Error('截止日期无效。');
        patch.deadline = { at: null, date: item.deadlineDate, precision: 'date', origin: 'ai_grounded' };
      }
      for (const field of ['opensAt', 'closesAt']) if (item[field] && !unclear.has(field)) {
        needsEvidence(field); if (!timeOK(item[field])) throw new Error(`${field} 无效。`); patch[field] = item[field];
      }
      if ((item.fixedStart || item.fixedEnd) && !unclear.has('fixedStart') && !unclear.has('fixedEnd')) {
        needsEvidence('fixedStart'); needsEvidence('fixedEnd');
        if (!timeOK(item.fixedStart) || !timeOK(item.fixedEnd) || ms(item.fixedEnd) <= ms(item.fixedStart)) throw new Error('固定事件时段不完整或无效。');
        patch.fixed = { start: item.fixedStart, end: item.fixedEnd, location: item.location || null, origin: 'ai_grounded' };
      } else if (item.location && target?.fixed) {
        needsEvidence('location'); patch.fixed = { ...target.fixed, location: item.location };
      }
      if (item.sectionOptions?.length && !unclear.has('sectionOptions')) {
        needsEvidence('sectionOptions'); patch.sectionOptions = {};
        for (const option of item.sectionOptions) {
          if (!timeOK(option.start) || !timeOK(option.end) || ms(option.start) >= ms(option.end)) throw new Error('分班时段无效。');
          for (const section of option.sections) patch.sectionOptions[section] = { start: option.start, end: option.end, location: option.location || null };
        }
      }
      if (item.sections?.length) { needsEvidence('sections'); patch.sections = item.sections; }
      if (item.condition) { needsEvidence('condition'); patch.condition = item.condition; }
      if (item.optional) needsEvidence('optional');
      const oldRequirements = target?.requirements || [];
      if (item.requirements?.length || item.removeRequirements?.length) {
        needsEvidence('requirements');
        if ((item.removeRequirements || []).some(r => !oldRequirements.includes(r))) throw new Error('被撤销的旧要求无法匹配，需确认。');
        patch.requirements = unique([...oldRequirements.filter(r => !(item.removeRequirements || []).includes(r)), ...(item.requirements || [])]);
      }
      for (const field of item.clearFields || []) {
        if (!['deadline', 'fixed', 'condition', 'sections', 'sectionOptions'].includes(field)) throw new Error('不支持清空该字段。');
        needsEvidence(field); patch[field] = field === 'sections' ? [] : null;
      }
      const policy = { ...(target?.policy || {}) };
      for (const [key, field] of [['late', 'latePolicy'], ['attempts', 'attempts'], ['scoring', 'scoring']]) {
        if (key === 'late' && !['assignment', 'upload', 'quiz'].includes(item.kind)) continue;
        if (item[field] && item[field] !== 'unknown') {
          if (!supported(field) && !supported('policy')) throw new Error(`${field} 缺少字段对应的来源证据。`);
          policy[key] = item[field];
        }
      }
      if (Object.keys(policy).length) patch.policy = policy;
      if (item.durationMinutes !== null && item.durationMinutes !== undefined) { needsEvidence('durationMinutes'); patch.durationMinutes = item.durationMinutes; }
      const estimate = calibratedEstimate(item, state);
      if (item.kind === 'tutorial' && !item.estimatedMinutes) estimate.minutes = 0;
      if (!target) {
        const task = createTask({ id: doc.contentId ? `${doc.courseCode}:${doc.term}:${doc.contentId}` : `ai:${doc.courseCode}:${doc.term}:${hash([doc.id, item.title, item.kind])}`,
          courseCode: doc.courseCode, term: doc.term, title: item.title, kind: item.kind, channel: item.channel,
          ...patch, sources, remainingMinutes: estimate.minutes, initialEstimateMinutes: estimate.initial,
          estimateOrigin: estimate.origin, estimateReason: item.estimateReason || '未给出 AI 估计，使用可修改的默认值。',
          estimateSamples: estimate.samples, splittable: item.kind === 'quiz' ? false : item.splittable !== false,
          optional: item.optional === true, aiUncertainties: item.uncertainties || [], issues: (item.uncertainties || []).map(u => u.question) });
        if (state.tasks.some(t => t.id === task.id)) throw new Error('同一入口已有其他任务，请确认关联后更新。');
        record({ id: eventId, type: 'TASKS_UPSERTED', tasks: [task] });
        target = task;
      } else {
        const addressed = new Set(Object.keys(patch));
        if (patch.deadline) { addressed.add('deadlineAt'); addressed.add('deadlineDate'); }
        if (patch.fixed) { addressed.add('fixedStart'); addressed.add('fixedEnd'); }
        const previousUnknown = target.aiUncertainties || [];
        patch.aiUncertainties = [...previousUnknown.filter(u => !addressed.has(u.field)), ...(item.uncertainties || [])];
        patch.issues = unique([...(target.issues || []).filter(q => !previousUnknown.some(u => u.question === q)), ...patch.aiUncertainties.map(u => u.question)]);
        const changed = Object.keys(patch).some(key => JSON.stringify(target[key]) !== JSON.stringify(patch[key]));
        if (changed) record({ id: eventId, type: 'TASK_CHANGED', taskId: target.id, patch, source: sources[0], message: item.reason });
      }
      if (['cancel', 'reinstate'].includes(item.operation)) record({ id: `${eventId}:status`, type: 'STATUS_RECORDED', taskId: target.id,
        value: item.operation === 'cancel' ? 'cancelled' : 'unknown', origin: 'course_announcement', source: sources[0], note: item.reason });
      decisions.push({ title: item.title, taskId: target.id, operation: item.operation, outcome: 'applied', reason: item.reason, sources,
        estimate: target.estimateOrigin === 'user' ? null : estimate });
    } catch (error) {
      const question = `${item.title || '任务'}：${error.message}`;
      questions.push(question);
      decisions.push({ title: item.title || '未命名事项', operation: item.operation, outcome: 'needs_review', reason: error.message });
    }
  }
  return { events, decisions, questions: unique(questions), summary: value.summary };
}

export function applyAnalysis(state, compiled, run) {
  let next = structuredClone(state);
  for (const event of compiled.events) next = applyEvent(next, event);
  next.aiRuns = [...(next.aiRuns || []), { ...run, ...compiled }];
  for (const doc of run.documents) next.aiSources = { ...(next.aiSources || {}), [doc.id]: { ...doc } };
  // Each incremental update must not erase unresolved questions from other
  // courses. A resolved task also clears its earlier document's question.
  const questionSources = structuredClone(next.aiQuestionSources || {});
  for (const doc of run.documents) questionSources[doc.id] = compiled.questions;
  const resolved = compiled.decisions.filter(d => d.outcome === 'applied').map(d => next.tasks.find(t => t.id === d.taskId)).filter(t => t && !t.issues.length);
  for (const key of Object.keys(questionSources)) questionSources[key] = questionSources[key].filter(q => !resolved.some(t =>
    next.aiSources[key]?.courseCode === t.courseCode && next.aiSources[key]?.term === t.term && q.startsWith(`${t.title}：`)) || compiled.questions.includes(q));
  next.aiQuestionSources = questionSources;
  next.aiQuestions = unique(Object.values(questionSources).flat());
  next.sync = { state: 'ai_local', checkedAt: next.now, message: '选中的本地资料已经 AI 处理；这不是实时 BB 同步。' };
  next.imported = { ...(next.imported || {}), source: 'ai', courses: new Set(next.tasks.map(t => t.courseCode)).size };
  return reconcile(next);
}
