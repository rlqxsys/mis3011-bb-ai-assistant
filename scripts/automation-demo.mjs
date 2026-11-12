import { loadReplayData, createReplayClient } from './feed-replay.mjs';

// No materials are written, no /ai/analyze or PLAN_REQUESTED request is made.
const data = await loadReplayData(), client = createReplayClient(), stage = process.argv[2];
if (stage === 'new') {
  await client.begin(data); await client.release(data.initial);
} else if (stage === 'update') {
  await client.release(data.update);
} else if (stage === 'eco') {
  await client.includeEconometrics(data);
} else throw new Error('用法：node scripts/automation-demo.mjs new | update | eco；仅回放 BB_Source_Feed 原始公告，会调用已配置模型。');
console.log('原始公告已由后台处理，打开 http://localhost:4174/ 查看任务、计划和提醒。');
