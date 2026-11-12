import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFeed } from '../core/load-feed.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
await mkdir(join(out, 'data'), { recursive: true });
for (const directory of ['demo', 'public']) await cp(join(root, directory), join(out, directory), { recursive: true });
await mkdir(join(out, 'core'), { recursive: true });
for (const name of ['engine', 'model', 'planner', 'reminders', 'time']) await cp(join(root, `core/${name}.mjs`), join(out, `core/${name}.mjs`));
await cp(join(root, 'BB_Source_Feed'), join(out, 'sources'), { recursive: true });
await cp(join(root, 'web/style.css'), join(out, 'style.css'));
await cp(join(root, 'public/browser-api.mjs'), join(out, 'browser-api.mjs'));
await cp(join(root, 'public/browser-panel.mjs'), join(out, 'ai-panel.mjs'));
const feed = await loadFeed(join(root, 'BB_Source_Feed'));
await writeFile(join(out, 'data/feed.json'), JSON.stringify(feed));
for (const name of ['automation-live-output.json', 'task-input.json']) await cp(join(root, 'examples', name), join(out, 'data', name));
await cp(join(root, 'artifacts/live-automation-report.json'), join(out, 'data/live-automation-report.json'));
let app = await readFile(join(root, 'web/app.mjs'), 'utf8');
const start = app.indexOf('async function request(path, body) {');
const end = app.indexOf('\nfunction toast(', start);
if (start < 0 || end < 0) throw new Error('页面请求接口已改变，请同步公开页构建脚本。');
app = app.slice(0, start) + app.slice(end);
app = "import { request } from './browser-api.mjs';\n" + app;
app = app.replaceAll("from '/", "from './")
  .replace(/<form id="ai-command-form"[\s\S]*?<\/form>/, '')
  .replace('href="/api/source?path=${encodeURIComponent(s.path)}"', 'href="./sources/${s.path.split(\'/\').map(encodeURIComponent).join(\'/\')}"');
await writeFile(join(out, 'app.mjs'), app);
let html = await readFile(join(root, 'web/index.html'), 'utf8');
html = html.replaceAll('href="/style.css"', 'href="./style.css"').replaceAll('src="/app.mjs"', 'src="./app.mjs"')
  .replace('<div class="workspace">', '<div class="workspace"><p class="hint" style="padding:20px 0 0">公开交互展示 · 真实 AI 运行记录与实时排程 · 操作保存在当前浏览器</p>')
  .replace('BB Companion · Group 12</footer>', 'BB Companion · Group 12 · <a href="https://github.com/rlqxsys/mis3011-bb-ai-assistant" target="_blank" rel="noopener">项目仓库</a></footer>');
await writeFile(join(out, 'index.html'), html);
await writeFile(join(out, '.nojekyll'), '');
console.log(JSON.stringify({ output: out, courses: feed.stats.courses, initialTasks: 3, runtime: 'browser core engine; captured AI run' }));
