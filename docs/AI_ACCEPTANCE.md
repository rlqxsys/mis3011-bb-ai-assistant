# 原始 BB 数据验收 · 2026-11-12

输入直接来自 BB_Source_Feed/courses/*.json。没有自拟课程、任务或改写的截止日期；不通过增量目录复制原文、更换 ID 来触发验证。

## 实际模型

北京时间 21:45:58–21:46:28，deepseek-flash 进行了 5 次后台调用，共 15,421 tokens，15 项检查通过。

原始公告：

1. CSC1001 — Time of Midterm and No Tutorial for that Day，courses/CSC1001.json 的 ann[16]。
2. CSC1001 — Important Update of Midterm Date and Time，ann[15]。
3. CSC1001 — Further Clarification for Assignment 1，ann[14]。
4. CSC1001 — Midterm Details，ann[13]。
5. ECO3121 — Assignment 2，courses/ECO3121.json 的 ann[20]。

具体定位与正文 SHA-256 以 artifacts/live-automation-report.json 的 sourceAudit 为准。时间、ID、正文、学期、课程及路径逐字段与原始解析比对；模型结果进入现有规划器和提醒引擎。

## 已核对

- 未发布公告不提前输入；回放时钟到达后自动发现原文。
- 初始 CSC1001 考试为 2024-11-01 19:00–21:00；Tutorial 取消。
- 后续改期为 2024-11-10 19:00–21:00，考试 ID 保持，Tutorial 恢复但不编造缺失课时。
- 自动生成准备安排，并撤销旧版本待发提醒。
- ECO3121 Problem Set 2 截止为 2024-11-02 15:00，不接受迟交；进入真实排程与提醒。
- 所有模型输入都来自原包，所有当前任务都有原文引用。
- 全部调用由后台 source_update 触发，无手动分析或 PLAN_REQUESTED。
- 原始资料不变时不重复调用；增量目录无遗留虚拟资料。
- 当前跟进范围仅为原包五门课程及其原始年份。

本轮是上述历史原文的动态处理验证，不是实时 BB 抓取，也不代表五门课的全部任务已完成解析。未知的个人分班和 Tutorial 时间仍保持待补充。

## 证据与复跑

- artifacts/live-automation-report.json：15 项检查、原文审核、实际模型用量、任务及排程。
- examples/automation-live-output.json：原文、实际模型输出、事件和结果。
- examples/ai-input.json、task-input.json、events-input.json：均从本轮真实资料导出。
- scripts/live-automation-eval.mjs：从原包重新执行；会替换验收工作区并产生模型费用。
- scripts/export-ai-example.mjs：只读导出，不调用模型。

旧合成输入测试不再作为接入成功的证据，相关材料已移出项目。原始课程包未修改。
