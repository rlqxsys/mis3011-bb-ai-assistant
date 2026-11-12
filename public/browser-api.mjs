import { createPublicWorkspace } from './public/browser-workspace.mjs';

async function read(name) {
  const response = await fetch(new URL(name, import.meta.url));
  if (!response.ok) throw new Error(`加载失败：${name}`);
  return response.json();
}
const [feed, evidence] = await Promise.all([read('data/feed.json'), read('data/automation-live-output.json')]);
let storage;
try { storage = window.localStorage; } catch { /* Use memory for this tab. */ }
export const { request } = createPublicWorkspace({ feed, evidence, storage });
