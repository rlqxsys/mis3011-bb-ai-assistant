import test from 'node:test';
import assert from 'node:assert/strict';
import { createState, applyEvent } from '../core/engine.mjs';
import { createAutomation } from '../ai/automation.mjs';
import { loadReplayData } from '../scripts/feed-replay.mjs';

const data = await loadReplayData();
const auto = createAutomation({ readDocuments: async () => ({ documents: data.documents, errors: [] }), provider: { info: () => ({ configured: false }) }, ai: null });
test('native feed catalogue contains exactly the five handed-off course instances', () => {
  assert.deepEqual(data.subscriptions, [{courseCode:'CSC1001',term:'2024'},{courseCode:'ECO2021',term:'2024'},{courseCode:'ECO3121',term:'2024'},{courseCode:'ENG1001',term:'2023'},{courseCode:'MAT1001',term:'2023'}]);
  assert.equal(data.originals.length,112);
});
test('source-time replay does not expose future or undated package materials', async () => {
  let state = createState({ mode:'replay', now:new Date(Date.parse(data.initial.publishedAt)-1000).toISOString() });
  state = await auto.configure(state,{subscriptions:[{courseCode:'CSC1001',term:'2024'}],replaySources:true});
  state = await auto.scan(state);assert.equal(state.automation.pending.length,0);
  state = applyEvent(state,{id:'source-arrived',type:'CLOCK_ADVANCED',to:data.initial.publishedAt});
  state = await auto.scan(state);
  assert.deepEqual(state.automation.pending.map(p=>p.document),[data.initial]);
  assert.equal(state.automation.pending.some(p=>!p.document.publishedAt),false);
  assert.equal(state.automation.pending.some(p=>p.document.id===data.update.id),false);
});
test('later original announcement is discovered without replacing its ID, date or body', async () => {
  let state = createState({mode:'replay',now:data.initial.publishedAt});
  state = await auto.configure(state,{subscriptions:[{courseCode:'CSC1001',term:'2024'}],replaySources:true});
  state = applyEvent(state,{id:'later-source-arrived',type:'CLOCK_ADVANCED',to:data.update.publishedAt});
  state = await auto.scan(state);
  assert.deepEqual(state.automation.pending.map(p=>p.document),[data.update]);
  assert.equal(data.update.sourcePath,'courses/CSC1001.json');assert.equal(data.update.locator,'ann[15]');
});
