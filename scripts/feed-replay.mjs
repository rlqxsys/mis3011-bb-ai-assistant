import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadFeed } from '../core/load-feed.mjs';
import { buildDocuments } from '../ai/documents.mjs';
import { fileURLToPath } from 'node:url';

// Acceptance input is read from the original package, never authored here.
export async function loadReplayData() {
  const feed = await loadFeed(fileURLToPath(new URL('../BB_Source_Feed/', import.meta.url)));
  const documents = buildDocuments(feed);
  const find = (courseCode, title) => {
    const doc = documents.find(d => d.courseCode === courseCode && d.title === title && d.type === 'announcement');
    assert.ok(doc, `原始包缺少公告：${courseCode} ${title}`); return doc;
  };
  const originals = documents.filter(d => d.type === 'announcement').map(doc => {
    const course = feed.courses.find(c => c.code === doc.courseCode), row = course.ann[Number(doc.locator.match(/^ann\[(\d+)\]$/)[1])];
    assert.equal(doc.title, row.title); assert.equal(doc.text, row.body.trim());
    return { id: doc.id, courseCode: doc.courseCode, term: doc.term, title: doc.title, sourcePath: doc.sourcePath,
      locator: doc.locator, publishedAt: doc.publishedAt, version: doc.version,
      textSHA256: createHash('sha256').update(doc.text).digest('hex') };
  });
  return { feed, documents, originals,
    initial: find('CSC1001', 'Time of Midterm and No Tutorial for that Day'),
    update: find('CSC1001', 'Important Update of Midterm Date and Time'),
    assignment: find('ECO3121', 'Assignment 2'),
    subscriptions: [...new Map(documents.map(d => [`${d.courseCode}:${d.term}`, { courseCode: d.courseCode, term: d.term }])).values()] };
}

export function createReplayClient(base = process.env.BB_AI_REVIEW_URL || 'http://127.0.0.1:4174') {
  const call = async (path, body) => {
    const response = await fetch(base + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
  };
  async function begin(data) {
    const before = await call('/api/state');
    if (!before.aiConnection.configured || !before.aiConnection.consent) throw new Error('请先在设置中保存模型连接和调用选项。');
    await call('/api/ai/session', { now: new Date(Date.parse(data.initial.publishedAt) - 1000).toISOString() });
    return call('/api/automation/config', { subscriptions: [{ courseCode: data.initial.courseCode, term: data.initial.term }], replaySources: true });
  }
  async function release(doc) {
    let state = await call('/api/state');
    if (Date.parse(doc.publishedAt) > Date.parse(state.now)) {
      await call('/api/events', { id: `source-time:${doc.id}:${doc.version}`, type: 'CLOCK_ADVANCED', to: doc.publishedAt });
    }
    const expires = Date.now() + 115000;
    while (Date.now() < expires) {
      state = await call('/api/state');
      const failure = state.automation.pending.find(p => p.error);
      if (failure) throw new Error(failure.error);
      if (state.aiSources?.[doc.id]?.version === doc.version && !state.automation.pending.length && !state.automationRuntime.running) return state;
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    throw new Error(`等待原始公告处理超时：${doc.title}`);
  }
  async function includeEconometrics(data) {
    const state = await call('/api/state');
    await call('/api/automation/config', { subscriptions: [
      { courseCode: data.initial.courseCode, term: data.initial.term },
      { courseCode: data.assignment.courseCode, term: data.assignment.term }
    ], replaySources: true });
    const arrivals = data.documents.filter(d => d.type === 'announcement' && ['CSC1001', 'ECO3121'].includes(d.courseCode)
      && d.publishedAt > state.now && d.publishedAt <= data.assignment.publishedAt).sort((a, b) => a.publishedAt.localeCompare(b.publishedAt));
    let next = state;
    for (const doc of arrivals) { console.log(`读取原始公告：${doc.courseCode} · ${doc.title}`); next = await release(doc); }
    return next;
  }
  return { call, begin, release, includeEconometrics };
}
