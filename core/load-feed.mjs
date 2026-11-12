import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export async function loadFeed(root) {
  const readJSON = async name => JSON.parse(await readFile(join(root, name), 'utf8'));
  const courses = await Promise.all((await readdir(join(root, 'courses'))).filter(n => n.endsWith('.json')).sort().map(n => readJSON(`courses/${n}`)));
  const attachments = await readJSON('attachments.json');
  const texts = {};
  for (const item of Object.values(attachments).flat()) {
    if (item.contentFile) texts[item.contentFile] = await readJSON(item.contentFile);
  }
  const all = Object.values(attachments).flat();
  return {
    courses, attachments, texts,
    stats: {
      courses: courses.length, pages: courses.reduce((n, c) => n + c.pages.length, 0),
      rows: courses.reduce((n, c) => n + c.pages.reduce((m, p) => m + p.rows.length, 0), 0),
      announcements: courses.reduce((n, c) => n + c.ann.length, 0),
      gradeRows: courses.reduce((n, c) => n + c.grades.length, 0),
      details: courses.reduce((n, c) => n + c.details.length, 0), attachments: all.length,
      textFiles: Object.keys(texts).length,
      contentStatuses: all.reduce((out, a) => { out[a.contentStatus] = (out[a.contentStatus] || 0) + 1; return out; }, {})
    }
  };
}
