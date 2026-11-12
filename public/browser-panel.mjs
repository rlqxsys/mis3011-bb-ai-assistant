export function createAIPanel(ui) {
  const { getState, run, openModal, closeModal, go, toast, esc, btn } = ui;
  const links = '<a href="https://github.com/rlqxsys/mis3011-bb-ai-assistant" target="_blank" rel="noopener">项目仓库 ↗</a> · <a href="./data/live-automation-report.json" target="_blank">验收报告 ↗</a>';
  function openSettings() {
    openModal('展示设置', `<p>任务、空闲设置、排程和提醒在当前浏览器中运行，刷新后保留。</p><div class="subtle-menu" style="margin-top:20px"><button class="button" data-public="records">查看真实 AI 运行记录</button><button class="button" data-public="restore">恢复真实 AI 验收任务</button><button class="button" data-public="export">导出当前状态</button></div><p class="hint" style="margin-top:20px">新资料的 AI 自动处理使用仓库中的 Node 服务。此页展示已完成的五次原文调用，并实时计算你的排程调整。</p><p style="margin-top:20px">${links}</p>`, btn('close', '返回'));
  }
  function records() {
    const runs = getState().aiRuns || [];
    openModal('真实 AI 运行记录', runs.length ? runs.map(r => `<details class="source"><summary>${esc(r.documents?.map(d => d.title).join('；') || r.summary)}</summary><p>${esc(r.model)} · ${esc(r.elapsedMs)} ms</p><p>${esc(r.summary)}</p><details><summary>原文与模型输出</summary><pre>${esc(JSON.stringify(r, null, 2))}</pre></details></details>`).join('') : '<p>当前是经典演示，可在设置中恢复真实 AI 验收任务。</p>', btn('close', '返回'));
  }
  function openImport() {
    openModal('导入标准任务', '<p>选择仓库导出的任务 JSON；文件包含 tasks 和历史回放时间 now。</p><input style="margin-top:20px" id="public-task-file" type="file" accept=".json" aria-label="任务 JSON">', btn('close', '返回'));
  }
  function openAutomation() {
    openModal('AI 自动跟进', `<p>后台流程：发现资料变化 → 调用模型理解 → 更新任务 → 重排计划与提醒。</p><p style="margin-top:16px">此公开页载入的是 BB_Source_Feed 五条公告的实际模型结果。组员启动仓库中的 Node 服务、设置模型连接后，可以复跑完整自动处理。</p><p style="margin-top:16px">${links}</p>`, btn('close', '返回'));
  }
  document.addEventListener('click', async e => {
    const action = e.target.closest('[data-public]')?.dataset.public;
    if (!action) return;
    try {
      if (action === 'records') return records();
      if (action === 'restore') { await run('/public/restore', {}, '已恢复真实 AI 验收任务'); closeModal(); return go('tasks'); }
      if (action === 'export') {
        const url = URL.createObjectURL(new Blob([JSON.stringify(getState(), null, 2)], { type: 'application/json' }));
        const a = document.createElement('a'); a.href = url; a.download = 'bb-companion-state.json'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) { toast(error.message); }
  });
  document.addEventListener('change', async e => {
    if (e.target.id !== 'public-task-file' || !e.target.files[0]) return;
    try { await run('/api/tasks/import', JSON.parse(await e.target.files[0].text()), '任务已导入'); closeModal(); go('tasks'); }
    catch (error) { toast(error.message); }
  });
  return {
    openImport, openSettings, openAutomation, automationLine: () => '',
    showQuestions: () => openModal('待补充信息', `<ul>${(getState().aiQuestions || []).map(q => `<li>${esc(q)}</li>`).join('')}</ul>`, btn('close', '返回')),
    previewCommand: () => openAutomation()
  };
}
