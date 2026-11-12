import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadFeed } from '../core/load-feed.mjs';
import { applyEvent, reconcile } from '../core/engine.mjs';
import { buildDocuments, documentsFromUpload } from './documents.mjs';

// Both adapters yield the same document contract; replacing the collector does not
// change the AI, task engine, scheduler or reminders.
export function createDocumentSource(feedRoot, inboxRoot) {
  return async () => {
    let feed, documents = [], errors = [];
    try { feed = await loadFeed(feedRoot); documents = buildDocuments(feed); }
    catch (e) { errors.push(`课程包读取失败：${e.message}`); }
    await mkdir(inboxRoot, { recursive: true });
    for (const name of (await readdir(inboxRoot)).filter(n => n.endsWith('.json')).sort()) {
      try {
        const uploaded = documentsFromUpload(JSON.parse(await readFile(join(inboxRoot, name), 'utf8')));
        documents.push(...uploaded.map(d => ({ ...d, sourcePath: `course-inbox/${name}` })));
      } catch (e) { errors.push(`${name}：${e.message}`); }
    }
    const unique = new Map(), conflicts = new Set();
    for (const doc of documents) {
      if (unique.has(doc.id) && unique.get(doc.id).version !== doc.version) conflicts.add(doc.id);
      unique.set(doc.id, doc);
    }
    for (const id of conflicts) { unique.delete(id); errors.push(`资料 ID 重复且内容不同：${id}`); }
    return { documents: [...unique.values()], errors, feed };
  };
}

export const emptyAutomation = () => ({ enabled: false, subscriptions: [], known: {}, pending: [], activity: [], lastScanAt: null, lastSuccessAt: null, sourceErrors: [] });
const inScope = (doc, subscriptions) => subscriptions.some(s => s.courseCode === doc.courseCode && s.term === doc.term);
const visible = (doc, state, settings) => !settings.replaySources || (doc.publishedAt && Date.parse(doc.publishedAt) <= Date.parse(state.now));
const note = (a, entry) => { a.activity = [{ id: randomUUID(), ...entry }, ...a.activity].slice(0, 30); };
const keyOf = d => `${d.courseCode}:${d.term}:${d.id}`;

export function createAutomation({ readDocuments, ai, provider, clock = () => new Date().toISOString() }) {
  async function configure(state, input) {
    const next = structuredClone(state), a = next.automation ||= emptyAutomation();
    if (input.enabled === false) { a.enabled = false; return next; }
    const subscriptions = (input.subscriptions || a.subscriptions).map(s => ({ courseCode: String(s.courseCode || '').trim(), term: String(s.term || '').trim() }));
    if (!subscriptions.length || subscriptions.some(s => !s.courseCode || !s.term)) throw new Error('请填写需要跟进的课程和学期。');
    if (state.scenario || state.mode === 'snapshot') throw new Error('当前是演示数据，请在设置中切换到课程工作区再开始跟进。');
    const result = await readDocuments();
    let previous = a.subscriptions;
    if (input.replaySources !== undefined && Boolean(input.replaySources) !== Boolean(a.replaySources)) {
      a.known = {}; a.pending = []; previous = [];
    }
    a.replaySources = input.replaySources ?? a.replaySources ?? false;
    a.subscriptions = subscriptions;
    a.pending = a.pending.filter(p => inScope(p.document, subscriptions) && visible(p.document, state, a));
    for (const doc of result.documents.filter(d => inScope(d, subscriptions) && visible(d, state, a))) {
      if (inScope(doc, previous)) continue;
      if (input.includeExisting && state.aiSources?.[doc.id]?.version !== doc.version) {
        a.pending.push({ document: doc, attempts: 0, retryAt: null, error: null });
      }
      a.known[keyOf(doc)] = doc.version;
    }
    a.enabled = true; a.sourceErrors = result.errors; a.lastScanAt = clock();
    if (next.mode === 'empty') { next.mode = 'live'; next.workspace = 'ai'; next.now = clock(); }
    next.planningEnabled = true;
    note(a, { at: clock(), kind: 'started', message: `正在跟进 ${subscriptions.map(s => `${s.courseCode} ${s.term}`).join('、')}，沿用当前空闲设置。` });
    return reconcile(next);
  }

  async function scan(state) {
    if (!state.automation?.enabled) return state;
    const { documents, errors } = await readDocuments();
    const next = structuredClone(state), a = next.automation;
    a.lastScanAt = clock(); a.sourceErrors = errors;
    for (const doc of documents.filter(d => inScope(d, a.subscriptions) && visible(d, state, a))) {
      const key = keyOf(doc);
      if (a.known[key] === doc.version) continue;
      a.known[key] = doc.version;
      a.pending = a.pending.filter(p => keyOf(p.document) !== key);
      if (state.aiSources?.[doc.id]?.version === doc.version) continue;
      a.pending.push({ document: doc, attempts: 0, retryAt: null, error: null });
    }
    // Missing files are not cancellation notices or submission evidence.
    return next;
  }

  async function processNext(state) {
    const a = state.automation, info = provider.info();
    if (!a?.enabled || !info.configured || !info.consent) return state;
    const entry = [...a.pending].filter(p => p.attempts < 3 && (!p.retryAt || Date.parse(p.retryAt) <= Date.parse(clock())))
      .sort((x, y) => (x.document.publishedAt || '').localeCompare(y.document.publishedAt || ''))[0];
    if (!entry) return state;
    const doc = entry.document;
    let next = structuredClone(state);
    try {
      // One document per call keeps incremental relationships and model output
      // small. Every next call receives the actual result of the previous one.
      if (next.mode === 'live') next.now = clock();
      else if (next.mode === 'replay' && doc.publishedAt && Date.parse(doc.publishedAt) > Date.parse(next.now)) {
        next = applyEvent(next, { id: `auto-clock:${doc.version}`, type: 'CLOCK_ADVANCED', to: doc.publishedAt });
      }
      const before = next.tasks.map(t => [t.id, t.version]);
      const result = await ai.analyze([doc], next);
      next = result.state;
      if (!result.skipped) next.aiRuns.at(-1).trigger = 'source_update';
      const auto = next.automation;
      auto.pending = auto.pending.filter(p => keyOf(p.document) !== keyOf(doc));
      auto.lastSuccessAt = clock();
      const created = next.tasks.filter(t => !before.some(([id]) => id === t.id)).length;
      const updated = next.tasks.filter(t => before.some(([id, v]) => id === t.id && v !== t.version)).length;
      const questions = result.questions?.length || 0;
      note(auto, { at: clock(), kind: 'processed', documentId: doc.id, version: doc.version, runId: result.runId,
        message: `${doc.courseCode} · ${doc.title}：${created ? `新增 ${created} 项` : ''}${created && updated ? '，' : ''}${updated ? `更新 ${updated} 项` : ''}${!created && !updated ? '无任务变更' : '，计划与提醒已同步'}${questions ? `；${questions} 项信息待补充` : ''}。` });
    } catch (error) {
      // Retry transient failures without erasing tasks or endlessly spending on
      // a malformed document. A new version automatically resets this counter.
      next = structuredClone(state);
      const queued = next.automation.pending.find(p => keyOf(p.document) === keyOf(doc));
      queued.attempts++; queued.error = error.message;
      queued.retryAt = new Date(Date.parse(clock()) + 60_000 * 2 ** (queued.attempts - 1)).toISOString();
      note(next.automation, { at: clock(), kind: 'failed', documentId: doc.id, message: `${doc.title}：${error.message}` });
    }
    return next;
  }

  function retry(state) {
    const next = structuredClone(state);
    for (const p of next.automation?.pending || []) { p.attempts = 0; p.retryAt = null; p.error = null; }
    return next;
  }
  return { configure, scan, processNext, retry };
}
