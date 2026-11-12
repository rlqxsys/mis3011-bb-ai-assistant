# AI 任务理解、时间规划与提醒联动

此版本将模型放进实际运行链，不使用模型回答预设的演示结果。传统规则场景仍保留作回归基准；`npm start` 不加载测试替身。运行需要 Node.js 22+，无需模型 SDK 或 npm 运行依赖。

## 工作流和职责

```text
授权获得的课程原文／本地 BB_Source_Feed
  → 文档整理：课程、学期、来源定位、发布时间、内容版本
  → 一次订阅课程／学期 → 后台发现新版本、排队 → 运行时模型提取与关系判断
  → 程序核对结构、原文引用、课程归属与旧任务身份
  → 统一任务／变更事件 → 现有规划器与提醒引擎
  → 学生查看、补充个人条件、直接表达变更或试算
  → 真实提交证据／本人确认／新公告 → 重排与撤销过期提醒
```

| 工作 | 模型 | 程序与学生 |
| --- | --- | --- |
| 从新原文理解交什么、时间和条件 | 提取字段、逐字引用、指出关键未知 | 核对引用确实存在、字段格式及课程实例；学生核查语义 |
| 新旧关系 | 判断独立新事项、更新、补充、取消、恢复或冲突，引用旧任务 ID | 保留稳定任务 ID；早于已知正式信息的资料不自动覆盖；冲突待确认 |
| 准备用时 | 可给带理由的建议，不把估计当课程规定 | 未给估计时使用标明的默认值；个人可修改；测验执行时长不能低于已知要求 |
| 排日程 | 不直接生成正式准备块 | 确定性规划器执行空闲、固定事件、每日容量、连续测验、DDL 和缓冲约束 |
| 自然语言调整 | 将“明晚有会”“再需 90 分钟”等转成支持操作，并判断 apply／preview／clarify 意图 | 明确变更直接执行；假设只试算；存在歧义先提问。不能更改老师的 DDL、考试或提交事实 |
| 动态提醒 | 解释意图；不自行发送、决定用户已经完成 | 事件引擎计算站内队列，提交后停止普通催办、释放时段；改期撤销旧待发提醒 |
| 个性化 | 不声称已经训练个人模型 | 可选用时反馈，同类型至少 3 个不同任务后用中位数比例校准新任务；提醒偏好只按明确设置处理 |

引用核对不等于证明模型的语义理解必然正确。模型可能漏提或错判；应对照原文验收，不能用结构检查替代质量评估。没有实时 BB 抓取，也没有在公共网络检索私人课程资料：目前“更新”指新输入的公告／课程正文。后续接入器需要负责获得新资料。

## 本机连接

页面右上角「设置」中选择模型服务。DeepSeek 官方预设为：

- 完整 URL：`https://api.deepseek.com/chat/completions`，不是只填 base URL。
- 模型：`deepseek-flash`，可按账号支持的模型修改。
- 响应格式：JSON Object；服务端对 DeepSeek 使用非思考模式。
- 自己的 API key 仅填本地密码框，保存发送范围后再测试连接。保存不自动调用模型。

官方文档核对于 2026-11-12：[首次调用](https://api-docs.deepseek.com/)、[Chat Completions 参数](https://api-docs.deepseek.com/api/create-chat-completion)。OpenRouter 或其他兼容服务可以填写自己的完整 URL、模型和格式；仅对明确支持的模型使用 JSON Schema。不会自动切换服务或改用另一付费模型。

key 仅存在本地服务进程环境／内存，GET 状态和导出不返回它，服务重启后需重新填写。切换服务时必须提供该服务的 key，不把另一服务的旧 key 发过去。服务仍只监听本机，不是可公开部署的多用户密钥管理系统。

可选环境变量：`AI_ENDPOINT`、`AI_MODEL`、`AI_API_KEY`（或 `OPENROUTER_API_KEY`）、`AI_FORMAT`。环境提供 key 后仍需在页面确认发送范围。不要将真实 key 写进仓库或提交截图。

## 数据范围与版本

- 课程包整理为公告、内容项和已有抽取文本。目录接口只返回元数据；手动导入发送所选正文，自动跟进发送所订阅课程／学期内的新版本正文。
- 不将 `grades` 表、`details` 提交历史或二进制附件交给模型；任务上下文也排除这两类来源。此过滤不等于自动识别并脱敏正文中的所有个人信息，导入前仍应检查。
- 文档带稳定 id、courseCode、term、publishedAt、sourcePath、locator、version。现有附件抽取文档保留原文件定位；还没有 OCR 或通用二进制 PDF 解析。
- 同一 id、相同正文与发布时间不重复调用；有变更的版本才重新处理。存在待确认结果时，可补充来源或明确勾选强制重试；强制重试可能再次计费。
- 只发送相关课程学期的现有任务上下文，而非整份课程包。单次最多 60,000 字符。后台一次处理一份资料，新版本才调用，不截断超长资料；失败最多 3 次，不无限重试。
- 历史资料使用显式回放时钟；页面可按选中公告的发布时间向前推进。完整历史成绩快照不允许进入 AI 规划。

## 模块与接口

`ai/automation.mjs` 负责增量资料源、课程订阅、版本索引、持久队列和有限重试；`ai/documents.mjs` 整理输入；`prompts.mjs` 每次调用读取 `ai/prompts/` 文本；`contracts.mjs` 定义 JSON 结构；`provider.mjs` 发送 HTTP 请求；`analysis.mjs` 和 `commands.mjs` 编译成核心事件；`service.mjs` 负责模型调用、去重和试算。服务端使用同一串行状态队列处理后台更新和用户操作，避免覆盖彼此的变更。

所有 POST 使用 JSON。成功返回工作状态视图，可能附 `aiResult`；错误返回 400 和 `error`，不会退回旧规则结果假装 AI 成功。

| 接口 | 输入／输出 |
| --- | --- |
| GET `/api/ai/documents` | 可选本地课程文档元数据列表，无正文 |
| GET `/api/ai/document?id=...` | 一份选中文档的原文和来源 |
| POST `/api/ai/config` | endpoint、model、apiKey、format、consent；响应无 key |
| POST `/api/ai/test` | 空对象；真实短调用，不含课程材料；返回 connectionTest 模型、耗时和 usage |
| POST `/api/ai/session` | 可选 now；新工作区保留空闲偏好，最近旧状态保存为同目录 state.before-ai-session.json |
| POST `/api/ai/analyze` | documentIds 或 documents 数组或 upload；可选 force、advanceClock；返回 decisions、questions、runId |
| POST `/api/feed/documents` | documents 数组／一份标准原文／原始课程 JSON；只写入增量输入，后台自行处理。返回 received 数量 |
| POST `/api/automation/config` | subscriptions: [{courseCode, term}]；enabled=false 暂停；includeExisting=true 首次接入时排入现有资料 |
| 历史资料回放 | config 中 replaySources=true：仅在文档明确 publishedAt 不晚于工作区 now 时可见，日期不明的附件不冒充当时已发布 |
| POST `/api/automation/retry` | 重置失败条目的尝试计数，下一轮自动处理 |
| POST `/api/ai/command` | instruction；apply=false 仅试算，true 明确应用，"auto" 根据模型识别的用户意图；有歧义不自动应用 |
| POST `/api/ai/apply-preview` | runId；重新根据当前状态应用预览事件，过期上下文不覆盖新状态 |
| POST `/api/events` | 原核心事件；新增 EFFORT_FEEDBACK_RECORDED，含 taskId、actualMinutes |

接入新资料的例子见 `examples/ai-input.json`，来自原始 CSC1001 公告。`documents` 的最低必需字段是 courseCode、term、text，建议提供稳定 id、资料标题和真实 publishedAt；不要用抓取时间冒充发布时间。

模型分析返回 `items`，每项含 operation、targetTaskId、时间／要求字段、evidence、uncertainties 和 reason。事实字段须能定位到本次原文；准备时长只作为估计。有效事项独立转换成 TASKS_UPSERTED、TASK_CHANGED 或课程取消／恢复的 STATUS_RECORDED；不确定事项会单列 needs_review，不覆盖旧事实。一次调用可以应用有效事项并保留其他疑问。上游失败、截断、无效顶层 JSON 则整次不应用。

自然语言接口只能生成个人偏好事件：忙碌时段、空闲窗口、每日上限、安静时段、本人剩余估计、准备最早时间、暂停／稍后提醒。页面使用自动意图模式，明确变更直接执行；假设仍预览。排程是否足够取决于规划器实际计算的准备块与容量风险，而非模型声称“来得及”。

## 后台闭环与采集端交接

后台每 5 秒重新读取本地课程包及 `.local/course-inbox/*.json`。先比较文档版本，未变化不调用；符合订阅的新版本进入持久 pending 队列。一轮一个文档，按已知发布时间排序；先应用前一份结果，再用新任务上下文分析后一份。成功后保留原文、模型结果、统一事件、处理摘要，排程与提醒自动同步。另一份资料到来不会清空其他课程尚未解决的问题。

首次订阅默认建立当前资料基线，从后续变化开始；includeExisting 只对新加入的课程范围生效。队列、版本和订阅跟随状态文件恢复；key 没有配置时仅排队。失败保留任务，1、2 分钟后重试，累计 3 次后暂停该版本，其他资料继续处理。更改正文会作为新版本重新排队，资料消失不表示取消。进入规则演示、历史快照、新工作区或替换导入时暂停自动跟进，避免两种工作区互相影响。

采集端无需调用 AI，也无需生成规划任务，只要发送以下原文格式；id 稳定标识同一资料，内容修订复用 id，新公告使用新 id。term 必须与订阅一致（当前组内快照使用年份，如 "2024"）。publishedAt 是真实发布时间，不是抓取时间；没有则填 null。附件需由采集端抽取为文字。

```json
{
  "documents": [{
    "id": "MIS3011:2026:announcement:stable-bb-id",
    "courseCode": "MIS3011",
    "term": "2026",
    "title": "Assignment 2 deadline update",
    "publishedAt": "2026-11-12T16:00:00+08:00",
    "text": "Assignment 2 is now due November 20 at 15:00. Other requirements are unchanged.",
    "locator": "Blackboard announcement stable-bb-id"
  }]
}
```

本版本自动化的是“资料已经进入本地入口后的处理”，并非自动登录学校 Blackboard。现有 `/api/events` 的 bb_adapter 提交状态接口仍用于后续可信采集端同步提交记录；AI 不根据阅读、准备时间或缺失记录推测提交。

## 可重复验收

```bash
npm test
node scripts/browser-smoke.mjs
node scripts/browser-native-feed.mjs
node scripts/live-automation-eval.mjs
```

浏览器脚本需要已有 Playwright／Chromium，可设置 PLAYWRIGHT_MODULE、PLAYWRIGHT_BROWSERS_PATH。最后一个脚本进行真实模型调用，重建验收工作区并按原始发布时间推进；默认访问 4174，BB_AI_REVIEW_URL 可指定其他本地服务。

正式输入从 BB_Source_Feed 直接读取，既不重写正文，也不更换文档 ID。当前 124 项程序回归、真实模型 15 项检查通过；浏览器报告的模型替身只证明界面与程序链路，不代替真实模型结果。实际证据是 artifacts/live-automation-report.json；输入、模型输出和事件见 examples/automation-live-output.json。

当前覆盖 CSC1001 的考试通知、改期、进一步说明，以及 ECO3121 的作业公告。五门课均接入目录和订阅，但不声称已完整解析全部材料。历史回放的初始基线排除未来公告；仅推进时钟，后台便会发现原包新出现的版本，无需手动分析或 PLAN_REQUESTED。每次切换工作区会清空旧订阅、队列和活动记录，避免测试课程残留。
