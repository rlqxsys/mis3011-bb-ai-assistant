import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { loadReplayData } from './feed-replay.mjs';

// Read-only export of native-feed acceptance; never invokes the model.
const report=JSON.parse(await readFile(new URL('../artifacts/live-automation-report.json',import.meta.url),'utf8'));
assert.equal(report.status,'passed');assert.equal(report.source,'BB_Source_Feed');
const data=await loadReplayData(),base=process.env.BB_AI_REVIEW_URL||'http://127.0.0.1:4174';
const state=await(await fetch(base+'/api/state')).json(),ids=new Set(report.runs.map(r=>r.id));
const runs=state.aiRuns.filter(r=>ids.has(r.id));assert.equal(runs.length,ids.size,'当前工作区已变化，缺少该轮真实记录');
for(const run of runs)for(const doc of run.documents||[])assert.deepEqual(doc,data.documents.find(d=>d.id===doc.id));
const output={evidenceType:report.testType,documents:runs.flatMap(r=>r.documents||[]),modelRuns:runs,
  now:state.now,tasks:state.tasks,plan:state.plan,notifications:state.notifications,subscriptions:state.automation.subscriptions};
const save=(name,value)=>writeFile(new URL('../examples/'+name,import.meta.url),JSON.stringify(value,null,2)+'\n');
await save('automation-live-output.json',output);
await save('ai-input.json',{documents:[data.initial]});
await save('task-input.json',{now:state.now,tasks:state.tasks});
await save('events-input.json',{events:[{id:'example:plan-real-tasks',type:'PLAN_REQUESTED'}]});
console.log(JSON.stringify({source:'BB_Source_Feed',files:4,modelCalls:0}));
