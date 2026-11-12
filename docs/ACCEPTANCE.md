# 验收入口

打开 http://localhost:4174/。当前保留真实原始公告形成的 CSC1001 考试、Tutorial 和 ECO3121 作业；页面明确标为历史资料回放。

## 检查顺序

1. 任务页查看课程、要求和时间。点击任务 → 来源，核对 courses/CSC1001.json 或 courses/ECO3121.json 中的公告位置与原文。
2. 计划页查看准备块和固定考试。准备估计与正式时间分开；排程不重叠、不超过每天上限或正式截止。
3. 提醒页查看改期后的新提醒与已撤销的旧提醒。
4. 自动跟进中查看五门真实课程和原始学期。日后原文更新后由后台处理，不需要逐份选文件。

## 从头回放真实公告

保存模型连接后运行：

```bash
node scripts/automation-demo.mjs new
node scripts/automation-demo.mjs update
node scripts/automation-demo.mjs eco
```

这些命令只切换回放时钟，资料由后台直接从 BB_Source_Feed 读取。new 会备份并替换当前验收工作区；实际调用模型，不是规则模拟。

## 自动检查

```bash
npm test
node scripts/browser-smoke.mjs
node scripts/browser-native-feed.mjs
```

单元和浏览器测试使用隔离工作区；替身响应只用于测试程序和界面，不导入学生工作区，不计为模型质量。真实模型结果看 artifacts/live-automation-report.json。

四类固定回归仍在“体验演示”，任务均有原始包来源；容量场景不再附加编造测验。示例中的空闲、用时和本人操作是测试条件，不是从 BB 推断的学生行为。
