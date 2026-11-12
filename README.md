# BB Companion · 时间规划与动态提醒

公开仓库：[rlqxsys/mis3011-bb-ai-assistant](https://github.com/rlqxsys/mis3011-bb-ai-assistant)。

[详细交接文档](docs/HANDOFF.md) · [公开展示说明](docs/PUBLIC_DEMO.md)。公开展示页正在发布到 GitHub Pages；本机完整后台使用 [http://localhost:4174/](http://localhost:4174/)。

当前验收直接读取 BB_Source_Feed，不创建自拟课程或作业。原包包含：

| 课程 | 原始学期年份 |
| --- | --- |
| CSC1001 | 2024 |
| ECO2021 | 2024 |
| ECO3121 | 2024 |
| ENG1001 | 2023 |
| MAT1001 | 2023 |

年份保持原值。页面标为“历史资料回放”，不是假装这些任务发生在 2026 年。

## 当前验收结果

真实 DeepSeek 后台处理了 5 条原始公告，15 项检查通过。包括 CSC1001 考试由 11 月 1 日改为 11 月 10 日、Tutorial 取消后恢复，以及 ECO3121 Problem Set 2 的 11 月 2 日 15:00 截止和不接受迟交。没有手动调用分析或生成计划接口，模型输入逐字段对应原文 ID、课程、学期、正文、发布时间、来源路径及定位。

报告：artifacts/live-automation-report.json。原文、模型 JSON、事件、任务、计划和提醒：examples/automation-live-output.json。本轮只验证这些原文，不代表已完整解析五门课的全部材料。

## 怎么看

主界面只有任务、计划、提醒三页。任务详情包含要求、原文来源与预计用时。自动跟进范围默认来自原始包的五门课程。模型连接和运行记录放在右上角设置，所有内容共用一个弹窗。

公开页初始载入本轮真实原文形成的考试、Tutorial 和作业；本机页面保留使用者最近的工作状态。打开“计划”看准备安排；打开任务的“来源”可查看 courses/*.json 原文件。正式时间来自原文，准备时长是模型估计，可调整。

## 自动处理方式

资料进入本地源 → 比较版本 → 后台调用 AI 识别任务和新旧关系 → 更新统一任务 → 排程和提醒联动。一次设置课程范围和空闲时间，后续无需逐份勾选或手动分析。明确的个人安排变更直接执行，假设问题只试算。

历史回放开启 replaySources 时，仅在发布时间到达后处理原公告，未标明发布时间的材料不冒充当时已发布。实际运行使用真实时钟，增量输入可以更新课程包、放入 .local/course-inbox/，或 POST /api/feed/documents。

当前没有实时登录 BB，也没有邮件／手机推送。Node 服务需保持运行，关闭浏览器不影响后台；key 仅在进程中，服务重启后重新填写。

## 启动与复跑

Node.js 22+，无第三方运行依赖：

```bash
cd "$HOME/CUHKSZ课程/MIS3011/MIS3011_GroupProject_BBAIAssistant"
BB_ASSISTANT_STATE_FILE=.local/ai-review.json PORT=4174 npm start
```

原始公告回放，实际调用已配置模型：

```bash
node scripts/automation-demo.mjs new
node scripts/automation-demo.mjs update
node scripts/automation-demo.mjs eco
```

new 备份并替换验收工作区，以原始公告出现前为起点；后续命令只推进回放时钟，不编写材料、不调用 /api/ai/analyze。完整真实验收用 node scripts/live-automation-eval.mjs。只读导出样例用 node scripts/export-ai-example.mjs。

## 验证与代码

- npm test：129 项程序回归，包含原包指纹、排期约束、状态语义、版本去重、原文回放与公开页工作区。
- node scripts/browser-smoke.mjs：8 组真实课程经典交互。
- node scripts/browser-native-feed.mjs：原始包数据的自动跟进界面检查，模型为明确测试替身；不同于真实模型验收。
- 浏览器脚本需要已有 Playwright 与 Chromium，可设置 PLAYWRIGHT_MODULE、PLAYWRIGHT_BROWSERS_PATH。

core/ 为通用任务、规划和提醒；ai/ 为模型理解及后台队列；demo/ 为来源于原始包的固定回归场景；tests/ 为隔离单元测试，测试夹具不导入用户工作区。旧合成验证材料已移出项目，不再作为交付证据或默认示例。

[验收说明](docs/ACCEPTANCE.md) · [AI 集成](docs/AI_INTEGRATION.md) · [核心接口](docs/INTEGRATION.md)
