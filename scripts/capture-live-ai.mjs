import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Read-only capture of a running application. Does not call any model or change state.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const base = process.env.BB_AI_REVIEW_URL || 'http://127.0.0.1:4174';
const state = await (await fetch(`${base}/api/state`)).json();
assert.ok(state.aiRuns?.some(r => r.transport === 'live_http'), 'No live model records to capture');
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } }), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${base}/#tasks`);
  await page.locator('main h1').waitFor();
  await page.screenshot({ path: fileURLToPath(new URL('../artifacts/automation-live-tasks.png', import.meta.url)), fullPage: true });
  await page.locator('[data-tab="plan"]').click();
  await page.screenshot({ path: fileURLToPath(new URL('../artifacts/automation-live-plan.png', import.meta.url)), fullPage: true });
  await page.locator('[data-action="settings"]').click();
  await page.locator('[data-ai-action="records"]').click();
  const panel = page.locator('#task-dialog');
  await panel.waitFor();
  for (const summary of await panel.locator('.source > summary').all()) await summary.click();
  await panel.screenshot({ path: fileURLToPath(new URL('../artifacts/ai-live-records.png', import.meta.url)) });
  assert.deepEqual(errors, []);
  assert.match(await panel.innerText(), /live_http/);
  console.log(JSON.stringify({ source: 'running-application-live-model-records', additionalModelCalls: 0, browserErrors: errors, screenshot: 'artifacts/ai-live-records.png' }));
} finally { await browser.close(); }
