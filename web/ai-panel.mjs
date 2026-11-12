export function createAIPanel(ui) {
  const { getState, request, run, openModal, closeModal, go, toast, esc, fmt, inputTime, localISO, btn, textBtn } = ui;
  let documents=[], selected=new Set(), course='', type='announcement', query='', importTab='catalog', preview=null;
  let options={replace:false,force:false,clock:''};
  const draft={courseCode:'',term:String(new Date().getFullYear()),title:'',publishedAt:'',text:''};
  const aiButton=(action,label,cls='') => `<button class="button ${cls}" data-ai-action="${action}">${label}</button>`;
  const ready=() => getState().aiConnection?.configured && getState().aiConnection?.consent;
  const empty=text => `<p class="empty">${text}</p>`;
  const showError=fn => Promise.resolve().then(fn).catch(e => toast(e.message));
  const filtered=() => documents.filter(d => (!course||d.courseCode===course)&&(!type||d.type===type)&&`${d.title} ${d.courseCode}`.toLowerCase().includes(query.toLowerCase()));
  function saveOptions() {
    if (document.querySelector('#import-replace')) options.replace=document.querySelector('#import-replace').checked;
    if (document.querySelector('#import-force')) options.force=document.querySelector('#import-force').checked;
    if (document.querySelector('#import-clock')) options.clock=document.querySelector('#import-clock').value;
  }
  async function openImport() {
    options={replace:!getState().tasks.some(t => !['submitted','graded','user_confirmed','cancelled','exempt'].includes(t.status.value)) || getState().mode==='snapshot',force:false,clock:''};
    openModal('导入课程资料','<p class="hint">正在读取课程列表…</p>');
    documents=await request('/api/ai/documents');
    renderImport();
  }
  function renderImport() {
    const info=getState().aiConnection||{}, rows=filtered();
    const catalog=`<div class="doc-tools"><select id="ai-course" aria-label="课程">${['',...new Set(documents.map(d=>d.courseCode))].map(c=>`<option value="${esc(c)}" ${c===course?'selected':''}>${esc(c||'全部课程')}</option>`).join('')}</select><select id="ai-doc-type" aria-label="资料类型">${[['announcement','公告'],['attachment','附件'],['content','内容项'],['','全部类型']].map(([v,t])=>`<option value="${v}" ${type===v?'selected':''}>${t}</option>`).join('')}</select><input id="ai-doc-query" aria-label="搜索资料" placeholder="搜索标题" value="${esc(query)}"></div><div id="doc-list" class="doc-list"></div><p id="selected-count" class="hint" style="margin-top:10px">已选 ${selected.size} 份 · ${rows.length} 份资料</p>`;
    const text=`<div class="form-grid"><div class="field"><label for="ai-course-code">课程</label><input id="ai-course-code" data-draft="courseCode" value="${esc(draft.courseCode)}" required></div><div class="field"><label for="ai-term">学期年份</label><input id="ai-term" data-draft="term" value="${esc(draft.term)}" required></div></div><div class="field"><label for="ai-title">资料标题</label><input id="ai-title" data-draft="title" value="${esc(draft.title)}" required></div><div class="field"><label for="ai-text">内容</label><textarea id="ai-text" data-draft="text" rows="7" required placeholder="粘贴作业说明或课程公告">${esc(draft.text)}</textarea></div><details><summary>发布时间／文件导入</summary><div class="field"><label for="ai-published">发布时间</label><input id="ai-published" data-draft="publishedAt" type="datetime-local" value="${esc(draft.publishedAt)}"></div><input id="ai-source-file" type="file" accept=".json,.txt,.md" aria-label="导入课程文件"></details>`;
    openModal('导入课程资料',`${!ready()?`<p class="hint" style="margin-bottom:16px">先连接模型，再解析资料。 <button class="text-button" data-ai-action="settings">去设置 →</button></p>`:''}<div class="tabs"><button data-ai-action="catalog" class="${importTab==='catalog'?'active':''}">已有资料</button><button data-ai-action="text" class="${importTab==='text'?'active':''}">粘贴内容</button></div><form id="import-form">${importTab==='catalog'?catalog:text}<div class="import-options">${getState().tasks.length?`<label class="check"><input id="import-replace" type="checkbox" ${options.replace?'checked':''} ${getState().mode==='snapshot'?'disabled':''}>新建一轮，替换当前任务</label>`:''}<details><summary>导入选项</summary><div class="field"><label for="import-clock">起始时间（留空按资料日期）</label><input id="import-clock" type="datetime-local" value="${esc(options.clock)}"></div><label class="check"><input id="import-force" type="checkbox" ${options.force?'checked':''}>重新解析已处理的资料</label></details></div></form>`,`${btn('close','取消')}<button class="button primary" type="submit" form="import-form" id="import-submit" ${!ready() || (importTab==='catalog'&&!selected.size)?'disabled':''}>添加任务</button>`);
    if (importTab==='catalog') renderDocs();
  }
  function renderDocs() {
    const list=document.querySelector('#doc-list'); if(!list)return;
    const rows=filtered();
    list.innerHTML=rows.slice(0,70).map(d=>`<div class="doc-row"><label><input type="checkbox" data-ai-doc="${esc(d.id)}" ${selected.has(d.id)?'checked':''}><span><strong>${esc(d.title)}</strong><small>${esc(d.courseCode)} · ${d.publishedAt?esc(d.publishedAt.slice(0,10)):esc(d.term)}</small></span></label><button type="button" class="text-button" data-ai-preview="${esc(d.id)}">原文</button></div>`).join('')||empty('没有找到资料');
    document.querySelector('#selected-count').textContent=`已选 ${selected.size} 份 · ${rows.length} 份资料${rows.length>70?'（搜索可查看更多）':''}`;
    document.querySelector('#import-submit').disabled=!ready()||!selected.size;
  }
  async function analyze(body, inputs) {
    if(options.replace || !getState().tasks.length || getState().mode==='snapshot') {
      const first=inputs.map(d=>d.publishedAt).filter(Boolean).sort()[0];
      const year=String(inputs[0]?.term||'').match(/^\d{4}/)?.[0];
      const now=localISO(options.clock)||first||(year?`${year}-01-01T09:00:00+08:00`:getState().now);
      await run('/api/ai/session',{now});
    }
    const result=await run('/api/ai/analyze',{...body,force:options.force,advanceClock:true});
    if(result.aiResult?.skipped)toast('资料没有变化，已保留原任务');
    else toast('任务已更新');
    closeModal(); go('tasks');
  }
  function automationLine() {
    const s=getState(),a=s.automation;
    if(!a?.subscriptions?.length)return '';
    const pending=a.pending||[],failed=pending.filter(p=>p.attempts>=3).length;
    const label=!a.enabled?'自动跟进已暂停':!ready()?'自动跟进 · 等待连接模型':s.automationRuntime?.running?'正在处理课程更新…':failed?`${failed} 份资料处理失败`:a.sourceErrors?.length?'资料读取有问题':pending.length?`${pending.length} 份更新待处理`:'自动跟进中';
    const latest=a.activity?.find(e=>e.kind==='processed');
    return `<div class="auto-line"><button class="text-button" data-ai-action="automation">${esc(label)}</button>${latest?`<span>${esc(latest.message)}</span>`:''}</div>`;
  }
  async function openAutomation() {
    documents=await request('/api/ai/documents');
    const s=getState(),a=s.automation||{},available=[...new Map(documents.map(d=>[`${d.courseCode}:${d.term}`,{courseCode:d.courseCode,term:d.term}])).values()];
    const scopes=a.subscriptions?.length?a.subscriptions:available;
    const lines=scopes.map(c=>`${c.courseCode} ${c.term}`).join('\n');
    openModal('自动跟进',`<p class="hint">课程资料有更新后，AI 自动更新任务，并同步计划和提醒。沿用你在「空闲设置」中的安排。</p>${s.scenario||s.mode==='snapshot'?'<p class="hint" style="margin-top:10px">开始跟进会退出演示，另建课程工作区；保留空闲设置并备份原任务。</p>':''}<form id="automation-form" style="margin-top:20px"><div class="field"><label for="auto-scopes">课程与学期（每行一门）</label><textarea id="auto-scopes" name="subscriptions" rows="3" required placeholder="MIS3011 2026">${esc(lines)}</textarea></div><label class="check"><input name="includeExisting" type="checkbox">首次接入的课程，也处理当前已有资料</label><p class="hint">未勾选时，从后续新增或修改的资料开始。</p></form>${!ready()?'<p class="hint" style="margin-top:16px">尚未连接模型，更新会先排队。 <button class="text-button" data-ai-action="settings">去设置 →</button></p>':''}<details><summary>资料入口与处理记录</summary><p class="hint">读取 BB_Source_Feed 和以下目录中的课程文字资料；当前没有实时登录 BB。</p><pre>${esc(s.automationRuntime?.inboxRoot||'.local/course-inbox')}</pre>${(a.sourceErrors||[]).map(e=>`<p class="hint">${esc(e)}</p>`).join('')}${(a.activity||[]).slice(0,6).map(e=>`<div class="source"><p>${esc(e.message)}</p><small>${fmt(e.at)}</small></div>`).join('')||'<p class="hint">尚无处理记录</p>'}</details>`,`${a.enabled?'<button class="text-button" data-ai-action="auto-pause" style="margin-right:auto">暂停跟进</button>':''}${a.pending?.some(p=>p.error)?'<button class="button" data-ai-action="auto-retry">重试失败资料</button>':''}<button class="button primary" form="automation-form" type="submit">${a.enabled?'保存课程范围':'开始跟进'}</button>`);
  }
  function openSettings() {
    const info=getState().aiConnection||{};
    openModal('设置',`<form id="ai-config-form"><div class="field"><label for="ai-provider">模型服务</label><select id="ai-provider"><option value="deepseek" ${info.endpoint?.includes('deepseek.com')?'selected':''}>DeepSeek</option><option value="openrouter" ${info.endpoint?.includes('openrouter.ai')?'selected':''}>OpenRouter／其他</option></select></div><div class="field"><label for="ai-model">模型</label><input id="ai-model" name="model" value="${esc(info.model||'deepseek-flash')}" required></div><div class="field"><label for="ai-key">API key</label><input id="ai-key" name="apiKey" type="password" autocomplete="off" placeholder="${info.keyStored?'已保存，留空不变':'填写服务商提供的 key'}" ${info.keyStored?'':'required'}></div><label class="check"><input name="consent" type="checkbox" ${info.consent?'checked':''}>使用所选资料调用模型（按账号计费）</label><details><summary>接口选项</summary><div class="field"><label for="ai-endpoint">完整接口地址</label><input id="ai-endpoint" name="endpoint" type="url" value="${esc(info.endpoint||'https://api.deepseek.com/chat/completions')}" required></div><div class="field"><label for="ai-format">响应格式</label><select id="ai-format" name="format">${[['json_object','JSON Object'],['json_schema','JSON Schema'],['text','JSON 文本']].map(([v,t])=>`<option value="${v}" ${info.format===v?'selected':''}>${t}</option>`).join('')}</select></div></details><p class="hint">服务重启后需重新填写 key。</p></form><div class="divider"></div><div class="actions"><button class="text-button" data-ai-action="records">运行记录</button><button class="text-button" data-ai-action="tools">数据工具</button><button class="text-button" data-ai-action="export">导出当前状态</button></div>`,`${info.keyStored?'<button class="text-button" data-ai-action="disconnect" style="margin-right:auto">清除 key</button>':''}<button class="button" data-ai-action="test" ${ready()?'':'disabled'}>测试连接</button><button class="button primary" type="submit" form="ai-config-form">保存</button>`);
  }
  function records() {
    const runs=[...(getState().aiRuns||[])].reverse();
    openModal('运行记录',runs.length?runs.map(r=>`<details class="source"><summary>${esc(r.documents?.map(d=>d.title).join('；')||r.instruction||r.summary)}</summary><p>${esc(r.model)} · ${r.elapsedMs} ms · ${esc(r.transport)}</p><p>${esc(r.summary)}</p>${(r.decisions||[]).map(d=>`<p>${esc(d.title)} · ${d.outcome==='applied'?'已更新':d.outcome==='ignored'?'无新任务':'待补充'}：${esc(d.reason)}</p>`).join('')}<details><summary>技术详情</summary><pre>${esc(JSON.stringify(r,null,2))}</pre></details></details>`).join(''):empty('还没有调用记录'),`<button class="button" data-ai-action="settings">返回设置</button>`);
  }
  async function tools() {
    const catalog=await request('/api/catalog');
    openModal('数据工具',`<p class="hint">课程包：${catalog.stats.courses} 门课 · ${catalog.stats.announcements} 条公告 · ${catalog.stats.attachments} 份附件</p><div class="subtle-menu" style="margin-top:20px">${aiButton('snapshot','查看历史数据')}<label class="button">导入标准任务 JSON<input id="task-file" type="file" accept=".json" hidden></label>${aiButton('sync-failure','模拟读取失败')}</div><details><summary>重新开始／回放时间</summary><form id="session-form"><div class="field"><label for="session-time">起始时间（留空使用当前时间）</label><input id="session-time" name="now" type="datetime-local" value="${inputTime(getState().now)}"></div><button class="button" type="submit">新建工作区</button></form></details><div class="divider"></div><p class="hint">清空只影响当前任务，保留课程文件。</p><button class="text-button danger" data-ai-action="reset">清空当前任务</button>`,`<button class="button" data-ai-action="settings">返回设置</button>`);
  }
  function showQuestions() { openModal('待补充信息',`<ul class="requirements">${(getState().aiQuestions||[]).map(q=>`<li>${esc(q)}</li>`).join('')}</ul>`,btn('close','返回')); }
  async function previewCommand(instruction,previewOnly=false) {
    if(!ready()) {openSettings();return toast('先连接模型，再进行试算');}
    const result=await run('/api/ai/command',{instruction,apply:previewOnly?false:'auto'}); preview=result.aiResult;
    if(preview.applied){go('plan');return toast(preview.preview.summary+' · 计划与提醒已更新');}
    const p=preview.preview, blocks=p.plan.blocks;
    openModal('计划试算',`<p>${esc(p.summary)}</p>${p.plan.risks.length?`<div class="risk-list" style="margin-top:18px">${p.plan.risks.map(r=>`<p>${esc(r.message)}</p>`).join('')}</div>`:''}<p class="hint" style="margin:18px 0 8px">调整后 ${blocks.length} 个准备时段</p><div class="ai-preview-blocks">${blocks.slice(0,12).map(b=>`<div class="result-row"><span>${esc(getState().tasks.find(t=>t.id===b.taskId)?.title||'准备')}</span><time>${fmt(b.start)}–${fmt(b.end)}</time></div>`).join('')||empty('暂无可安排时段')}</div>${p.questions.length?`<ul class="requirements">${p.questions.map(q=>`<li>${esc(q)}</li>`).join('')}</ul>`:''}`,`${btn('close','保持原计划')}<button class="button primary" data-ai-action="apply" ${p.events.length?'':'disabled'}>应用调整</button>`);
  }
  document.addEventListener('input',e=>{
    if(e.target.dataset.draft)draft[e.target.dataset.draft]=e.target.value;
    if(e.target.id==='ai-doc-query'){query=e.target.value;renderDocs();}
  });
  document.addEventListener('change',e=>showError(async()=>{
    if(e.target.dataset.aiDoc){e.target.checked?selected.add(e.target.dataset.aiDoc):selected.delete(e.target.dataset.aiDoc);return renderDocs();}
    if(e.target.id==='ai-course'){course=e.target.value;return renderDocs();}
    if(e.target.id==='ai-doc-type'){type=e.target.value;return renderDocs();}
    if(e.target.id==='ai-provider'){
      const d=e.target.value==='deepseek'; document.querySelector('#ai-endpoint').value=d?'https://api.deepseek.com/chat/completions':'https://openrouter.ai/api/v1/chat/completions';
      document.querySelector('#ai-model').value=d?'deepseek-flash':'';document.querySelector('#ai-format').value=d?'json_object':'json_schema';
      const key=document.querySelector('#ai-key');key.value='';key.required=true;document.querySelector('[name=consent]').checked=false;
    }
    if(e.target.id==='ai-source-file'&&e.target.files[0]){
      saveOptions();const file=e.target.files[0],text=await file.text();
      if(file.name.endsWith('.json')){const upload=JSON.parse(text);await analyze({upload},upload.documents||[upload]);}
      else{draft.text=text;draft.title=draft.title||file.name;renderImport();}
    }
    if(e.target.id==='task-file'&&e.target.files[0]){await run('/api/tasks/import',JSON.parse(await e.target.files[0].text()),'任务已导入');closeModal();go('tasks');}
  }));
  document.addEventListener('click',e=>{
    const source=e.target.closest('[data-ai-preview]');
    if(source)return showError(async()=>{saveOptions();const d=await request(`/api/ai/document?id=${encodeURIComponent(source.dataset.aiPreview)}`);openModal(d.title,`<p class="hint">${esc(d.courseCode)} · ${esc(d.locator)}</p><pre class="ai-source-text">${esc(d.text)}</pre>`,`<button class="button" data-ai-action="back-import">返回列表</button>`);});
    const action=e.target.closest('[data-ai-action]')?.dataset.aiAction;if(!action)return;
    showError(async()=>{
      if(action==='settings')return openSettings();
      if(action==='automation')return openAutomation();
      if(action==='auto-pause'){await run('/api/automation/config',{enabled:false},'自动跟进已暂停');closeModal();return;}
      if(action==='auto-retry'){await run('/api/automation/retry',{},'失败资料已重新排队');return openAutomation();}
      if(action==='catalog'||action==='text'){saveOptions();importTab=action;return renderImport();}
      if(action==='back-import')return renderImport();
      if(action==='records')return records();
      if(action==='tools')return tools();
      if(action==='export'){location.href='/api/export';return;}
      if(action==='test'){const s=await run('/api/ai/test',{});return toast(`连接成功 · ${s.connectionTest.model}`);}
      if(action==='disconnect'){await run('/api/ai/config',{apiKey:null,consent:false},'key 已清除');return openSettings();}
      if(action==='apply'){await run('/api/ai/apply-preview',{runId:preview.runId},'调整已应用');closeModal();return go('plan');}
      if(action==='snapshot'){await run('/api/import',{mode:'snapshot'});closeModal();return go('tasks');}
      if(action==='sync-failure'){await ui.event('SYNC_FAILED',{},'读取失败已模拟，现有任务保留');return tools();}
      if(action==='reset'){await run('/api/reset',{},'当前任务已清空');closeModal();return go('tasks');}
    });
  });
  document.addEventListener('submit',e=>{
    if(!['import-form','ai-config-form','session-form','automation-form'].includes(e.target.id))return;
    e.preventDefault();const data=new FormData(e.target);
    showError(async()=>{
      if(e.target.id==='automation-form'){
        const subscriptions=String(data.get('subscriptions')).trim().split('\n').map(line=>{const [courseCode,term,...rest]=line.trim().split(/\s+/);if(!courseCode||!term||rest.length)throw new Error('每行填写课程代码和学期，例如 MIS3011 2026');return {courseCode,term};});
        if(getState().scenario||getState().mode==='snapshot')await run('/api/ai/session',{});
        await run('/api/automation/config',{enabled:true,subscriptions,includeExisting:data.has('includeExisting'),replaySources:getState().mode==='replay'},'已开始自动跟进，后续资料变化会自行处理');closeModal();return go('tasks');
      }
      if(e.target.id==='ai-config-form'){await run('/api/ai/config',{endpoint:data.get('endpoint'),model:data.get('model'),apiKey:data.get('apiKey'),format:data.get('format'),consent:data.has('consent')},'模型设置已保存');return openSettings();}
      if(e.target.id==='session-form'){await run('/api/ai/session',{now:localISO(data.get('now'))},'工作区已新建');closeModal();return go('tasks');}
      saveOptions();
      if(importTab==='catalog')return analyze({documentIds:[...selected]},documents.filter(d=>selected.has(d.id)));
      const doc={...draft,publishedAt:localISO(draft.publishedAt)};return analyze({documents:[doc]},[doc]);
    });
  });
  return {openImport,openSettings,showQuestions,previewCommand,openAutomation,automationLine};
}
