import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadFeed } from '../core/load-feed.mjs';
import { normalizeFeed, reviewedTasks } from '../demo/feed-adapter.mjs';
import { extractDeadline, localClock, parsePosted, quietUntil } from '../core/time.mjs';

const feedRoot = fileURLToPath(new URL('../BB_Source_Feed', import.meta.url));
const feed = await loadFeed(feedRoot);
const catalog = normalizeFeed(feed, '2026-11-12T09:00:00+08:00');

test('source feed moved byte-for-byte without modifying original content', async () => {
  async function walk(dir) {
    const result = [];
    for (const item of await readdir(join(feedRoot, dir), { withFileTypes: true })) {
      const path = dir ? `${dir}/${item.name}` : item.name;
      result.push(...(item.isDirectory() ? await walk(path) : [path]));
    }
    return result;
  }
  const paths = (await walk('')).sort();
  const hash = createHash('sha256');
  for (const path of paths) { hash.update(path); hash.update(createHash('sha256').update(await readFile(join(feedRoot, path))).digest()); }
  assert.equal(paths.length, 232);
  assert.equal(hash.digest('hex'), 'adfbfe5352ea9f84129f0bcb3e9b5aa883bdbbb9daeaed6a6e7954e0c32f4d96');
});
test('all five course coverage counts match the handoff', () => {
  assert.deepEqual([feed.stats.courses, feed.stats.pages, feed.stats.rows, feed.stats.announcements, feed.stats.gradeRows, feed.stats.details, feed.stats.attachments, feed.stats.textFiles], [5, 43, 259, 112, 69, 17, 296, 221]);
});
test('all 221 packaged text references parse; unavailable text is not invented', () => {
  assert.equal(Object.keys(feed.texts).length, 221);
  assert.equal(feed.stats.contentStatuses.metadata_only, 75);
  assert.equal(feed.stats.contentStatuses.no_text_layer, 10);
});
test('date-only DUE remains date-only; no midnight is fabricated', () => {
  const d = extractDeadline('DUE: SEP 15, 2023', 2024);
  assert.equal(d.date, '2023-09-15'); assert.equal(d.at, null); assert.equal(d.precision, 'date');
});
test('15:00 hard deadline is extracted from actual ECO3121 announcement', () => {
  const t = catalog.tasks.find(t => t.courseCode === 'ECO3121' && t.title === 'Assignment 2');
  assert.equal(t.deadline.at, '2024-11-02T15:00:00+08:00');
  assert.equal(t.policy.late, 'not_allowed');
});
test('reverse dates and AM/PM are parsed with explicit inferred-year label', () => {
  const d = extractDeadline('It is due at 11:59 PM, 24 November (Sunday).', 2024);
  assert.equal(d.at, '2024-11-24T23:59:00+08:00'); assert.equal(d.yearInferred, true);
  assert.equal(extractDeadline('The deadline is 12:05AM, December 24.', 2024).at, '2024-12-24T00:05:00+08:00');
});
test('invalid dates and relative Sundays are not silently guessed', () => {
  assert.equal(extractDeadline('Due February 30, 2024 at 3 PM.', 2024), null);
  assert.equal(extractDeadline('Due next Sunday before midnight.', 2024), null);
});
test('posted CST means China time in this feed', () => {
  assert.equal(parsePosted('Posted on: Thursday, October 17, 2024 07:18:52 PM CST'), '2024-10-17T11:18:52.000Z');
});
test('quiet hours work across midnight and during a daytime quiet window', () => {
  assert.equal(quietUntil('2024-11-01T23:00:00+08:00', { start: '22:00', end: '08:00' }), '2024-11-02T08:00:00+08:00');
  assert.equal(localClock(quietUntil('2024-11-01T13:30:00+08:00', { start: '13:00', end: '14:00' })), '14:00');
});
test('task IDs remain stable across repeated source normalization', () => {
  assert.deepEqual(catalog.tasks.map(t => t.id), normalizeFeed(feed, '2026-11-13T00:00:00+08:00').tasks.map(t => t.id));
  assert.equal(new Set(catalog.tasks.map(t => t.id)).size, catalog.tasks.length);
});
test('solutions, old papers, totals and folder rows do not become new upload obligations', () => {
  assert.equal(catalog.tasks.length, 58);
  assert.equal(catalog.tasks.some(t => /^(Total|Weighted Total)$|Assignment \d Answer|Final exam paper of 2022/i.test(t.title)), false);
});
test('grade status is read from the raw display strings, not the empty fourth column', () => {
  const task = catalog.tasks.find(t => t.courseCode === 'CSC1001' && t.title === 'Assignment 4');
  assert.equal(task.status.value, 'submitted'); assert.equal(task.grade, '-');
  assert.equal('submittedAt' in task, false);
});
test('zero points do not automatically mean missing or unsubmitted', () => {
  const task = catalog.tasks.find(t => t.courseCode === 'ECO2021' && t.title === 'Assignment 5');
  assert.equal(task.status.value, 'graded');
});
test('similar MAT grade rows are not fuzzily merged', () => {
  const a = catalog.tasks.find(t => t.title === 'Assignment 1 Submission Link');
  const b = catalog.tasks.find(t => t.title === 'HW 1 submission');
  assert.ok(a && b); assert.notEqual(a.id, b.id);
});
test('quiz scoring policy is per item, not a course-wide assumption', () => {
  assert.equal(catalog.tasks.find(t => t.title === 'MC Quiz 2').policy.scoring, 'last');
  assert.equal(catalog.tasks.find(t => t.title === 'MC Quiz 4').policy.scoring, 'highest');
  assert.equal(catalog.tasks.find(t => /MC Quiz 1 \(/.test(t.title)).optional, true);
});
test('reviewed English interpretation separates presentation, external essay and section exam', () => {
  const k = reviewedTasks(feed);
  assert.equal(k.engPresentation.fixed, null);
  assert.equal(k.engEssay.channel, 'external');
  assert.equal(k.engListening.sectionOptions.L09.start, '2023-11-25T09:00:00+08:00');
  assert.equal(k.engListening.sectionOptions.L12.start, '2023-11-25T10:30:00+08:00');
});
