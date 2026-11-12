# 时间规划和动态提醒集成接口

核心为纯 ES modules，实际链路是 `课程原文 → ai/automation → ai/analysis → task events → core/engine → planner/reminders`。HTTP 和 UI 是外层，后续可保留核心、替换框架。没有全局数据库依赖或大模型 SDK。

2026-11-12 增加运行时 AI 输入链：`课程原文 → ai/service → 模型 → analysis/commands → core events`。通用 AI 不再是未来占位；连接、范围边界和新接口请见 [AI_INTEGRATION.md](AI_INTEGRATION.md)。下文旧规则接口继续兼容，不能把它们的测试通过计为模型质量通过。

## 任务记录

```json
{
  "id": "CSC1001:2024:_502000_1",
  "courseCode": "CSC1001",
  "term": "2024",
  "title": "Assignment 2",
  "kind": "assignment",
  "channel": "bb",
  "deadline": {
    "at": "2024-11-24T23:59:00+08:00",
    "date": "2024-11-24",
    "precision": "minute",
    "yearInferred": true
  },
  "fixed": null,
  "remainingMinutes": 120,
  "estimateOrigin": "demo_default",
  "splittable": true,
  "status": { "value": "unknown", "origin": "no_evidence", "at": null },
  "sources": [{
    "path": "courses/CSC1001.json",
    "locator": "pages[0].rows[0]",
    "quote": "来源原文",
    "role": "course"
  }],
  "requirements": [],
  "issues": [],
  "version": 1
}
```

最少需要稳定 id、courseCode、title。使用 `createTask` 补齐默认字段，预计用时必须是非负分钟数。标准任务导入也会补默认字段。id 不含可变日期，课程应带学期／实例标识，不能只按课程代码跨学期合并。

- kind：assignment、quiz、exam、presentation、upload、tutorial。
- channel：bb、external、offline。
- deadline.at：准确带时区的时刻；只有日期则 at 为 null，precision 为 date。不推定 23:59。
- fixed：不可移动事件 `{start,end,location?,arrivalMinutes?}`。sectionOptions 可按班级映射到不同 fixed，未选正确班级前不落一场事件。
- opensAt／closesAt：已知的开放和关闭时刻。执行安排不早于开放时刻、不晚于关闭或正式截止两者中较早的一项；未知时不推断。durationMinutes 可记录已知测验时长，预计执行时间不能低于它。
- condition：classroom-computer 表示只在使用教室电脑时需要上传。
- sections：只适用于这些分班；空缺班级时为 unknown，不匹配时为 not_applicable。
- policy：late 为 not_allowed／penalty／unknown；attempts 和 scoring 按单项实际规则保存。不从迟交扣分规则推断真实关闭入口时间。
- status：unknown／draft／submitted／graded／user_confirmed／cancelled／exempt。
- origin：bb_snapshot 仅表示完整历史快照；bb_adapter 表示接入器确认；demo_bb 表示模拟；user 表示学生自行确认。
- remainingMinutes 是保守的剩余估计，不是实际学习计时；页面修改后 estimateOrigin 为 user。
- optional 任务默认不进入自动计划和催办；接入方可通过 profile.includeOptional 显式选择纳入。

上传幻灯片和口头展示是独立任务。外部 VeriGuide 没有接入凭据时只能 user_confirmed。GRADED 表示停止按未交催促，不代表还原了线上提交回执；最后活动不是 submittedAt。

## 直接调用核心

读取本轮真实任务样例，不自行编写任务或日期：

```js
import { readFile } from 'node:fs/promises';
import { createState, applyEvent } from './core/engine.mjs';

const input = JSON.parse(await readFile('./examples/task-input.json', 'utf8'));
let state = createState({ now: input.now, mode: 'replay' });
state = applyEvent(state, {
  id: 'source-snapshot-1', type: 'TASKS_UPSERTED', tasks: input.tasks
});
state = applyEvent(state, { id: 'plan-1', type: 'PLAN_REQUESTED' });
```

`applyEvent` 返回新状态；输入状态不变。相同事件 id 重放返回原状态。调用方应使用来源稳定标识及版本／内容指纹生成事件 id，而不是每次轮询都随机换一个 id。

`demo/feed-adapter.mjs` 的 `normalizeFeed(feed,capturedAt)` 仅供旧历史快照和演示，`reviewedTasks` 是其中明确列出的课程解释。它们和固定场景都已移出通用 core；实际自动跟进不依赖这些规则。后台或 `/api/ai/analyze` 理解原文后转换为同一组核心任务／事件。

## HTTP

默认 http://127.0.0.1:4173 ，Content-Type 为 application/json。错误返回 400 和 `{ "error": "说明" }`。只适用于本机单学生原型；bb_adapter 标记是接入协议，不是鉴权机制。

| 方法与路径 | 用途 |
| --- | --- |
| GET /api/state | 当前任务、偏好、plan、notifications、events、summary 和场景列表 |
| GET /api/catalog | 全包数量、课程和规则候选数量，不改变工作状态 |
| POST /api/import | `{scenario:"submission"}` 载入回放，或 `{mode:"snapshot"}` 载入只读语义的历史快照 |
| POST /api/tasks/import | `{tasks:[...], now?, profile?}` 替换当前工作状态；有 now 为回放，无 now 使用真实钟 |
| POST /api/events | 单事件或 `{events:[...]}`；批次全成功才持久化 |
| POST /api/demo/event | 触发当前场景的下一组预设事件，稳定 ID 保证幂等 |
| GET /api/export | 下载当前状态 JSON |
| GET /api/source?path=... | 打开包内 JSON、TXT 或 PDF，不允许跳出原始包 |
| POST /api/reset | 清空工作状态，不删除原始包 |

用户输入最终只操作状态，不操作 BB 页面。任何将来提交、开始测验等动作都不属于当前接入接口。

## 事件

所有事件必须有 `id`、`type`。引擎记录 observedAt；来源发布时间和事件实际发生时间应由 source 或接入方单独保留，不把采集时间冒充发布时间。

| type | 其他字段 | 效果 |
| --- | --- | --- |
| PROFILE_UPDATED | profile 的局部顶层字段 | 更新空闲、分班、设备、忙碌等；sections/devices 对象由调用方合并 |
| PLAN_REQUESTED | 无 | 开启／检查规划；历史快照模式拒绝 |
| TASKS_UPSERTED | tasks 数组 | 按 id 更新／添加，未出现的任务不视为删除；不清除用户确认和偏好 |
| TASK_CHANGED | taskId、patch、source?、message? | 改期或个人确认时间；任务升版，撤销旧待发提醒 |
| STATUS_RECORDED | taskId、value、origin、note?、source? | 更新完成证据，调整相关准备时间和催办 |
| TASK_DEFERRED | taskId、until | 只改最早准备时间，不改正式 DDL |
| REMINDER_PREFERENCE | taskId、paused?、until? | 暂停／恢复催办、稍后提醒；不改完成状态 |
| BLOCK_LOCKED | blockId、locked | 锁定／解锁准备块；与新硬约束冲突时报告并移出有效计划 |
| NOTICE_READ | notificationId | 仅标记通知已读 |
| CLOCK_ADVANCED | to 或 minutes | 仅用于回放，不能倒退 |
| SYNC_FAILED | message? | 标记过期，保留上次可靠数据 |

成功提交示例：

```json
{
  "id": "adapter:task-1:receipt-version-1",
  "type": "STATUS_RECORDED",
  "taskId": "CSC1001:2024:_502000_1",
  "value": "submitted",
  "origin": "bb_adapter",
  "note": "接入器已识别成功提交证据，而非仅凭提交历史页面标题"
}
```

取消／恢复课程事件应发显式状态事件，不能靠某次列表缺失推断。若有新的重交要求，应保留旧提交证据并建立明确的新要求，再将当前处理状态改为 unknown；不能把无关的说明更新当成重交。

## 计划输出和提醒输出

plan.blocks 是可移动准备时间，包含 id、taskId、taskVersion、start、end、locked、reason；plan.fixed 是不可移动事件；plan.risks 提供 code、message、missingMinutes?。

风险 code 包括 insufficient_time、needs_time、past_deadline、beyond_horizon、fixed_conflict、locked_conflict。beyond_horizon 只表示当前窗口未排全，不等于最终一定来不及。

notifications 包含 id、taskId、taskVersion、type、scheduledAt、deliverAt、status。状态为 pending、delivered、read、cancelled。旧已送达通知保留为历史，不伪装成从未发过；待发的失效提醒撤销。

状态服务串行处理变更，写入 `.local/state.json.tmp` 后原子替换；重启读取已保存状态。这个实现不是多进程共享数据库。以后接数据库时，应保留事件幂等和每个学生的状态隔离，而不是把单学生服务直接公开部署。

## UI 接入建议

任务卡同时显示官方时刻、证据状态和建议准备时间。未知、用户确认和 demo_bb 标签不要隐藏。通知已读与完成按钮分开。推迟操作应说明改的是准备时间，不是官方截止。

实时接入优先发规范化增量事件；不要把完整历史成绩快照投入早期回放。需要按学生分班和课程实例过滤。接口来源引用只接受交接包相对路径或未来授权来源，不能依赖唐电脑的 Windows cachePath。
