import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadFeed } from '../core/load-feed.mjs';
import { applyEvent, summarize } from '../core/engine.mjs';
import { loadScenario, scenarioEvents } from '../demo/scenarios.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const feed = await loadFeed(join(root, 'BB_Source_Feed'));
await mkdir(join(root, 'examples'), { recursive: true });
const results = [];
for (const id of ['submission', 'exam-change', 'capacity', 'english']) {
  let state = loadScenario(feed, id, '2026-11-12T09:00:00+08:00');
  state = applyEvent(state, { id: `${id}:example-plan`, type: 'PLAN_REQUESTED' });
  const before = structuredClone(state), events = scenarioEvents(feed, state);
  for (const event of events) state = applyEvent(state, event);
  const output = { scenario: id, before: { tasks: before.tasks, plan: before.plan, summary: summarize(before) }, events, after: { tasks: state.tasks, plan: state.plan, notifications: state.notifications, summary: summarize(state) } };
  await writeFile(join(root, 'examples', `${id}-output.json`), `${JSON.stringify(output, null, 2)}\n`);
  results.push({ scenario: id, before: summarize(before), after: summarize(state) });
}
console.log(JSON.stringify(results, null, 2));
