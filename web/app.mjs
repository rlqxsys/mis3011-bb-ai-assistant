import { CLOSED, KIND_LABELS, applicability, fixedFor, taskEnd } from '/core/model.mjs';
import { localDate, localClock, atLocal, nextDate, ms, iso, MINUTE, duration } from '/core/time.mjs';
import { createAIPanel } from '/ai-panel.mjs';

const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmt = v => v ? new Intl.DateTimeFormat('zh-CN', { timeZone:'Asia/Shanghai', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(v)) : '时间待补充';
const inputTime = v => v ? `${localDate(v)}T${localClock(v)}` : '';
const localISO = v => v ? `${v}:00+08:00` : null;
const btn = (action, label, id = '', cls = '') => `<button class="button ${cls}" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
const textBtn = (action, label, id = '') => `<button class="text-button" data-action="${action}" data-id="${esc(id)}">${label}</button>`;
const empty = (title, subtitle = '') => `<div class="empty"><h2>${title}</h2><p>${subtitle}</p></div>`;
const statusNames = { unknown:'待处理', draft:'草稿', submitted:'BB 已提交', graded:'已评分', user_confirmed:'已确认完成', cancelled:'已取消', exempt:'已豁免' };
let state, busy = false, tab = 'tasks', search = '', taskFilter = 'open', noticeFilter = 'inbox', toastTimer;
const taskOf = id => state.tasks.find(t => t.id === id);
const timeMode = t => Boolean(fixedFor(t, state.profile)) || ['exam','tutorial'].includes(t.kind) || (t.kind === 'presentation' && !t.deadline?.at);

async function request(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作未完成，请重试。');
  return data;
}
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 4500); }
function guard(fn) { Promise.resolve().then(fn).catch(error => toast(error.message)); }
async function run(path, body, message = '') {
  if (busy) throw new Error('正在处理，请稍候。');
  busy = true; document.body.dataset.busy = 'true'; $('#main').setAttribute('aria-busy','true'); $('#operation-status').textContent = path.startsWith('/api/ai/') && !path.endsWith('/config') ? 'AI 处理中…' : '更新中…';
  try {
    state = await request(path, body);
    render(); if (message) toast(message); return state;
  } finally { busy = false; document.body.dataset.busy = 'false'; $('#main').setAttribute('aria-busy','false'); $('#operation-status').textContent = ''; }
}
const event = (type, values = {}, message = '已更新') => run('/api/events', { id:crypto.randomUUID(), type, ...values }, message);
function openModal(title, body, foot = '') {
  $('#dialog-content').innerHTML = `<div class="dialog-head"><h2 id="dialog-title">${esc(title)}</h2><button class="close" data-action="close" aria-label="关闭">×</button></div><div class="dialog-body">${body}</div>${foot ? `<div class="dialog-foot">${foot}</div>` : ''}`;
  if (!$('#task-dialog').open) $('#task-dialog').showModal();
}
const closeModal = () => $('#task-dialog').close();
function go(next) { tab = next; location.hash = next; render(); }
const ai = createAIPanel({ getState:() => state, request, run, event, openModal, closeModal, go, toast, esc, fmt, inputTime, localISO, btn, textBtn });

function officialTime(t) {
  const fixed = fixedFor(t, state.profile);
  return fixed ? `${fmt(fixed.start)}–${localClock(fixed.end)}` : t.deadline?.at ? fmt(t.deadline.at) : t.deadline?.date ? `${t.deadline.date} · 时刻待补充` : '时间待补充';
}
function status(t) {
  const applies = applicability(t, state.profile);
  if (t.status.value === 'submitted' && t.status.origin === 'demo_bb') return '演示已提交';
  return applies === 'not_applicable' ? '无需处理' : applies === 'unknown' && !CLOSED.has(t.status.value) ? '条件待补充' : statusNames[t.status.value];
}
function scenarioStep() {
  if (!state.scenario) return null;
  if (!state.planningEnabled) return { action:'plan', label:'下一步：生成计划' };
  const id = state.scenario.id;
  const finished = id === 'submission' ? state.tasks.some(t => t.status.origin === 'demo_bb')
    : id === 'exam-change' ? state.events.some(e => e.id === 'replay:notice-1017:exam')
    : id === 'capacity' ? state.events.some(e => e.id === 'replay:capacity:postpone') : state.tasks.some(t => t.status.origin === 'demo_bb');
  if (finished) return { label:'这组演示已完成', action:null };
  if (id === 'submission' && !state.notifications.some(n => n.type === 'plan' && ['read','delivered'].includes(n.status))) return { action:'next-notice', label:'下一步：触发提醒' };
  return { action:'demo-event', label:{ submission:'下一步：模拟提交', 'exam-change':'下一步：接收改期通知', capacity:'下一步：推迟准备', english:'下一步：模拟上传幻灯片' }[id] };
}
function render() {
  if (!state) return;
  const hash = location.hash.slice(1);
  tab = ['plan','reminders'].includes(hash) ? hash : 'tasks';
  $('#main').dataset.tab = tab;
  document.querySelectorAll('nav [data-tab]').forEach(el => { el.classList.toggle('active', el.dataset.tab === tab); el.setAttribute('aria-current', el.dataset.tab === tab ? 'page' : 'false'); });
  const unread = state.notifications.filter(n => n.status === 'delivered').length;
  $('#nav-unread').textContent = unread || '';
  const step = scenarioStep(), mode = state.scenario?.title || ({ replay:'历史资料回放', snapshot:'历史数据', live:'当前安排', empty:'课程工作台' }[state.mode]);
  $('#context').innerHTML = `<span class="mode">${esc(mode)}</span>${state.mode !== 'empty' ? `<span>${esc(localDate(state.now))} ${localClock(state.now)}</span>` : ''}${step && !(step.action === 'plan' && tab === 'plan') ? (step.action ? textBtn(step.action, step.label) : `<span>${step.label}</span>`) : ''}${state.mode === 'replay' ? textBtn('clock', '时间控制') : ''}`;
  $('#main').innerHTML = ({ tasks:tasksPage, plan:planPage, reminders:remindersPage })[tab]();
}
function tasksPage() {
  const active = state.tasks.filter(t => !CLOSED.has(t.status.value) && applicability(t,state.profile) !== 'not_applicable').length;
  const list = state.tasks.filter(t => `${t.title} ${t.courseCode}`.toLowerCase().includes(search.toLowerCase()) && (taskFilter === 'all' || (taskFilter === 'closed') === CLOSED.has(t.status.value)));
  const questions = state.aiQuestions || [];
  return `<div class="heading"><div><h1>课程任务</h1><p>${state.tasks.length ? `${active} 项待处理` : '连接课程资料，自动跟进变化。'}</p></div><div class="actions">${textBtn('import', '手动导入')}${btn('automation', '自动跟进', '', 'primary')}</div></div>
    ${ai.automationLine()}
    ${questions.length ? `<div class="issue-line"><span>${questions.length} 项信息待补充</span>${textBtn('questions','查看')}</div>` : ''}
    ${state.tasks.length ? `<div class="toolbar"><input id="search" aria-label="搜索任务" placeholder="搜索任务或课程" value="${esc(search)}"><select id="task-filter" aria-label="筛选任务" style="width:auto">${[['open','待处理'],['all','全部'],['closed','已完成／取消']].map(([v,t]) => `<option value="${v}" ${taskFilter === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>` : ''}
    ${list.length ? `<div class="task-list">${list.map(t => `<article class="task-row ${CLOSED.has(t.status.value) ? 'done' : ''}" data-task="${esc(t.id)}"><div><button class="task-title" data-action="detail" data-id="${esc(t.id)}">${esc(t.title)}</button><small>${esc(t.courseCode)} · ${KIND_LABELS[t.kind]}</small></div><div class="task-time">${officialTime(t)}</div><span class="status ${CLOSED.has(t.status.value) ? 'done' : ''}">${status(t)}</span><div class="actions">${btn('detail','查看',t.id,'small')}</div></article>`).join('')}</div>` : `<div class="panel empty"><h2>${state.tasks.length ? '当前没有待处理任务' : '先体验一次完整流程'}</h2><p>${state.tasks.length ? '可切换筛选，查看其他任务。' : '从两项作业开始，看看计划和提醒如何一起变化。'}</p><div class="actions">${state.tasks.length ? textBtn('show-all','显示全部任务') : btn('quick-demo','体验演示','','primary')}</div></div>`}
    ${state.tasks.length ? `<div class="list-footer"><span>共 ${state.tasks.length} 项任务</span><a href="#plan">去安排时间 →</a></div>` : ''}`;
}
function planPage() {
  const rows = [...state.plan.blocks.map(b => ({ ...b, type:'prep', title:taskOf(b.taskId)?.title })), ...state.plan.fixed.map(f => ({ ...f, type:'fixed' })), ...state.profile.busy.filter(b => ms(b.end) > ms(state.now)).map((b,i) => ({ ...b, type:'busy', index:state.profile.busy.indexOf(b) }))].sort((a,b) => ms(a.start)-ms(b.start));
  const dates = [...new Set(rows.map(r => localDate(r.start)))];
  const risks = state.plan.risks;
  return `<div class="heading"><div><h1>时间计划</h1><p>${state.planningEnabled ? '查看准备安排，随时调整。' : '设好空闲时间，再生成计划。'}</p></div><div class="actions">${btn('profile','空闲设置')}${state.tasks.length && state.mode !== 'snapshot' ? btn('plan',state.planningEnabled ? '重新安排' : '生成计划','','primary') : ''}</div></div>
    ${risks.length ? `<div class="risk-list">${risks.map(r => `<p>${esc(taskOf(r.taskId)?.title || '')}：${esc(r.message)}</p>`).join('')}</div>` : ''}
    ${state.tasks.length && state.mode !== 'snapshot' ? `<form id="ai-command-form" class="adjust-form"><input id="ai-instruction" name="instruction" aria-label="用一句话调整计划" placeholder="例如：明晚 7 点到 9 点有小组会，帮我重新排" required><button class="button" type="submit">调整安排</button><label class="check"><input name="previewOnly" type="checkbox">只试算</label></form>` : ''}
    <div class="plan-summary">${state.plan.blocks.reduce((n,b) => n+duration(b),0)} 分钟准备 · ${state.plan.blocks.length} 个时段　${textBtn('busy','＋ 添加已有安排')}</div>
    ${dates.length ? dates.map(date => `<section class="day"><h2 class="day-heading">${date}</h2>${rows.filter(r => localDate(r.start) === date).map(r => `<div class="schedule-row ${r.type}" data-block="${esc(r.id || '')}"><time>${localClock(r.start)}–${localClock(r.end)}</time><div><strong>${esc(r.title || '已有安排')}</strong><small>${r.type === 'fixed' ? '固定活动' : r.type === 'busy' ? '已有安排' : `${duration(r)} 分钟准备${r.locked ? ' · 已锁定' : ''}`}</small></div>${r.type === 'prep' ? textBtn('lock',r.locked ? '解锁' : '锁定',r.id) : r.type === 'busy' ? textBtn('remove-busy','移除',String(r.index)) : ''}</div>`).join('')}</section>`).join('') : `<div class="panel">${empty('还没有时间安排', state.tasks.length ? '点击“生成计划”，或先设置空闲时间。' : '先导入资料或体验演示。')}</div>`}
    `;
}
function remindersPage() {
  const list = state.notifications.filter(n => noticeFilter === 'all' ? ['delivered','read'].includes(n.status) : noticeFilter === 'inbox' ? n.status === 'delivered' : n.status === noticeFilter).sort((a,b) => ms(b.deliverAt)-ms(a.deliverAt));
  const readable = value => String(value).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g, fmt);
  const message = n => {
    const t = taskOf(n.taskId);
    if (n.type === 'deadline' && t) return `${fixedFor(t,state.profile) ? '活动时间' : '截止时间'}：${officialTime(t)}`;
    if (n.type === 'verify') return '完成情况待确认，可在任务中更新。';
    if (n.type === 'plan') {
      const times = n.body.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})/g);
      if (times?.length >= 2) return `准备时间：${fmt(times[0])}–${fmt(times[1])}`;
    }
    return readable(n.body).replace('这是本任务的证据，不代表其他关联事项已经完成。','').replace('；完成情况仍需核实，未判定漏交。','。请核对完成情况。');
  };
  return `<div class="heading"><div><h1>提醒</h1><p>准备、截止和任务变化，都在这里。</p></div>${state.mode === 'replay' ? btn('next-notice','触发下一条') : ''}</div>
    <div class="tabs">${[['inbox','未读'],['all','全部'],['pending','待提醒'],['cancelled','已撤销']].map(([v,t]) => `<button data-action="notice-filter" data-id="${v}" class="${noticeFilter === v ? 'active' : ''}">${t}</button>`).join('')}</div>
    <div>${list.length ? list.map(n => `<article class="notice ${n.status === 'delivered' ? 'unread' : ''}"><h3>${esc(n.title)}</h3><p>${esc(message(n))}</p><div class="notice-foot"><span>${fmt(n.deliveredAt || n.deliverAt)}${n.silent ? ' · 静默' : ''}</span><div class="actions">${n.taskId ? textBtn('detail','查看任务',n.taskId) : ''}${n.status === 'delivered' ? textBtn('read','已读',n.id) : ''}${n.taskId && n.status !== 'cancelled' ? textBtn('snooze','稍后提醒',n.taskId) : ''}</div></div></article>`).join('') : `<div class="panel">${empty(noticeFilter === 'pending' ? '暂无待提醒事项' : '这里暂时没有提醒')}</div>`}</div>`;
}
function scenariosModal() {
  openModal('选择一个演示', `<form id="scenario-form">${state.scenarios.map((s,i) => `<label class="scenario-option"><input name="scenario" type="radio" value="${s.id}" ${i ? '' : 'checked'}><span><strong>${s.title}</strong><small>${{submission:'两项作业：排期 → 提醒 → 提交','exam-change':'改期后重新安排，更新提醒',capacity:'推迟准备，检查时间是否够用',english:'按班级与设备决定需要做什么'}[s.id]}</small></span></label>`).join('')}</form>`, `<span class="hint">载入后替换当前任务</span><button form="scenario-form" class="button primary" type="submit">开始演示</button>`);
}
function taskModal(id) {
  const t = taskOf(id); if (!t) return;
  const estimate = {user:'你填写',ai_estimate:'AI 建议',feedback_calibrated:'用时反馈校准',default_estimate:'默认估计'}[t.estimateOrigin] || '可调整';
  openModal(t.title, `<div class="detail-meta"><span>${esc(t.courseCode)}</span><span>${KIND_LABELS[t.kind]}</span><span>${status(t)}</span></div><h3>时间</h3><p>${officialTime(t)}</p><p class="hint" style="margin-top:6px">预计还需 ${t.remainingMinutes} 分钟 · ${estimate}　${textBtn('edit-task','修改',id)}</p>${t.requirements.length ? `<h3 style="margin-top:22px">任务要求</h3><ul class="requirements">${t.requirements.map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}${t.issues.length ? `<div class="risk-list" style="margin-top:18px">${t.issues.map(r => `<p>${esc(r)}</p>`).join('')}</div>` : ''}<details><summary>来源 · ${t.sources.length} 条</summary>${t.sources.map(s => `<div class="source"><p>${esc(s.locator || s.path)}</p><pre>${esc(s.quote)}</pre>${/^(courses|attachment_text|attachment_files)\//.test(s.path) ? `<a href="/api/source?path=${encodeURIComponent(s.path)}" target="_blank" rel="noopener">原文件 ↗</a>` : ''}</div>`).join('')}<small>记录 ID：${esc(t.id)} · v${t.version}</small></details><details><summary>实际用时（选填）</summary><form id="feedback-form" data-task="${esc(id)}" class="actions"><input type="number" name="actualMinutes" min="1" max="20000" placeholder="实际总分钟" aria-label="实际用时" required style="max-width:180px"><button class="button small" type="submit">保存反馈</button></form></details>${!CLOSED.has(t.status.value) ? `<div class="detail-actions">${textBtn('defer','推迟准备',id)}${textBtn('pause',t.paused ? '恢复提醒' : '暂停提醒',id)}</div>` : ''}`, `${btn('close','返回')}${!CLOSED.has(t.status.value) && applicability(t,state.profile) !== 'not_applicable' ? btn('confirm','我已完成／提交',id,'primary') : ''}`);
}
function editModal(id) {
  const t = taskOf(id), fixed = fixedFor(t,state.profile), isFixed = timeMode(t);
  openModal('调整任务', `<form id="edit-task-form" data-task="${esc(id)}"><div class="field"><label for="remaining">预计还需／分钟</label><input id="remaining" name="remainingMinutes" type="number" min="0" max="10000" value="${t.remainingMinutes}" required></div><details><summary>修改时间</summary><div class="field"><label for="task-when">${isFixed ? '开始时间' : '截止时间'}</label><input id="task-when" name="when" type="datetime-local" value="${inputTime(fixed?.start || t.deadline?.at)}"></div>${isFixed ? `<div class="field"><label for="task-end">结束时间</label><input id="task-end" name="end" type="datetime-local" value="${inputTime(fixed?.end)}"></div>` : ''}</details></form>`, `${btn('detail','返回',id)}<button class="button primary" type="submit" form="edit-task-form">保存</button>`);
}
function profileModal() {
  const p = state.profile, courses = [...new Set([...state.tasks.map(t => t.courseCode),...Object.keys(p.sections),...Object.keys(p.devices)])], week = ['日','一','二','三','四','五','六'];
  openModal('我的空闲时间', `<form id="profile-form">${[1,2,3,4,5,6,0].map(day => { const row = p.availability.find(a => a.day === day); return `<div class="week-row"><label><input type="checkbox" name="day-${day}" ${row ? 'checked' : ''}>周${week[day]}</label><input type="time" aria-label="周${week[day]}开始" name="start-${day}" value="${row?.start || '19:00'}"><span>–</span><input type="time" aria-label="周${week[day]}结束" name="end-${day}" value="${row?.end || '21:30'}"></div>`; }).join('')}<div class="divider"></div><div class="field"><label for="daily-limit">每天最多安排／分钟</label><input id="daily-limit" name="dailyLimitMinutes" type="number" min="15" max="1440" value="${p.dailyLimitMinutes}" required></div><details><summary>班级与设备</summary>${courses.map(c => `<div class="course-row"><span>${esc(c)}</span><input name="section:${esc(c)}" placeholder="班级" aria-label="${esc(c)}班级" value="${esc(p.sections[c] || '')}"><select name="device:${esc(c)}" aria-label="${esc(c)}设备">${[['','设备未定'],['classroom','教室电脑'],['own','自带设备']].map(([v,t]) => `<option value="${v}" ${p.devices[c] === v ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`).join('') || '<p class="hint">导入任务后可设置班级</p>'}</details><details><summary>安排与提醒偏好</summary><div class="form-grid">${[['blockMinutes','每段最长／分钟',p.blockMinutes],['bufferMinutes','截止前缓冲／分钟',p.bufferMinutes],['breakMinutes','段间休息／分钟',p.breakMinutes]].map(([n,t,v]) => `<div class="field"><label for="${n}">${t}</label><input id="${n}" name="${n}" type="number" min="${n === 'blockMinutes' ? 15 : 0}" max="480" value="${v}" required></div>`).join('')}<div class="field"><label for="quiet-start">安静时段开始</label><input id="quiet-start" name="quietStart" type="time" value="${p.quiet.start}" required></div><div class="field"><label for="quiet-end">安静时段结束</label><input id="quiet-end" name="quietEnd" type="time" value="${p.quiet.end}" required></div></div></details></form>`, `<button class="button primary" type="submit" form="profile-form">保存</button>`);
}
function busyModal() { openModal('添加已有安排', `<form id="busy-form"><div class="field"><label for="busy-title">事项</label><input id="busy-title" name="title" placeholder="例如：小组会议" required></div><div class="form-grid"><div class="field"><label for="busy-start">开始</label><input id="busy-start" name="start" type="datetime-local" value="${inputTime(atLocal(localDate(state.now),'19:00'))}" required></div><div class="field"><label for="busy-end">结束</label><input id="busy-end" name="end" type="datetime-local" value="${inputTime(atLocal(localDate(state.now),'20:00'))}" required></div></div></form>`, `<button class="button primary" type="submit" form="busy-form">添加</button>`); }
function clockModal() { openModal('回放时间', `<p class="hint">当前 ${localDate(state.now)} ${localClock(state.now)}</p><div class="actions" style="margin-top:20px">${btn('advance','前进 1 小时','60')}${btn('advance','前进一天','1440')}${btn('next-notice','跳到下一条提醒')}</div>`); }

document.addEventListener('click', e => {
  const target = e.target.closest('[data-action]'); if (!target) return;
  const { action:a, id } = target.dataset;
  guard(async () => {
    if (a === 'close') return closeModal();
    if (a === 'scenarios') return scenariosModal();
    if (a === 'import') return ai.openImport();
    if (a === 'automation') return ai.openAutomation();
    if (a === 'settings') return ai.openSettings();
    if (a === 'questions') return ai.showQuestions();
    if (a === 'detail') return taskModal(id);
    if (a === 'edit-task') return editModal(id);
    if (a === 'profile') return profileModal();
    if (a === 'busy') return busyModal();
    if (a === 'clock') return clockModal();
    if (a === 'show-all') { taskFilter = 'all'; return render(); }
    if (a === 'notice-filter') { noticeFilter = id; return render(); }
    if (a === 'quick-demo') { await run('/api/import',{scenario:'submission'}); closeModal(); taskFilter='open'; return go('tasks'); }
    if (a === 'plan') { await event('PLAN_REQUESTED',{},'计划已更新'); closeModal(); return go('plan'); }
    if (a === 'demo-event') { await run('/api/demo/event',{},'演示事件已更新'); return; }
    if (a === 'next-notice') {
      const n = state.notifications.filter(n => n.status === 'pending' && ms(n.deliverAt)>ms(state.now)).sort((a,b) => ms(a.deliverAt)-ms(b.deliverAt))[0];
      if (!n) return toast('暂无待触发提醒');
      await event('CLOCK_ADVANCED',{to:n.deliverAt},'提醒已触发'); closeModal(); return go('reminders');
    }
    if (a === 'advance') { await event('CLOCK_ADVANCED',{minutes:Number(id)}); return clockModal(); }
    if (a === 'confirm') { await event('STATUS_RECORDED',{taskId:id,value:'user_confirmed',origin:'user'},'已记录完成，安排和提醒已更新'); return closeModal(); }
    if (a === 'defer') { await event('TASK_DEFERRED',{taskId:id,until:atLocal(nextDate(localDate(state.now)),'19:00')},'已推迟准备'); return taskModal(id); }
    if (a === 'pause') { await event('REMINDER_PREFERENCE',{taskId:id,paused:!taskOf(id).paused}); return taskModal(id); }
    if (a === 'read') return event('NOTICE_READ',{notificationId:id});
    if (a === 'snooze') return event('REMINDER_PREFERENCE',{taskId:id,until:iso(ms(state.now)+120*MINUTE)},'后续提醒延后 2 小时');
    if (a === 'lock') return event('BLOCK_LOCKED',{blockId:id,locked:!state.plan.blocks.find(b => b.id===id).locked});
    if (a === 'remove-busy') return event('PROFILE_UPDATED',{profile:{busy:state.profile.busy.filter((_,i) => i!==Number(id))}});
  });
});
document.addEventListener('submit', e => {
  const form = e.target, ids = ['scenario-form','profile-form','busy-form','edit-task-form','feedback-form','ai-command-form'];
  if (!ids.includes(form.id)) return;
  e.preventDefault(); const data = new FormData(form);
  guard(async () => {
    if (form.id === 'scenario-form') { await run('/api/import',{scenario:data.get('scenario')}); closeModal(); taskFilter='open'; search=''; return go('tasks'); }
    if (form.id === 'ai-command-form') return ai.previewCommand(data.get('instruction'),data.has('previewOnly'));
    if (form.id === 'profile-form') {
      const p = state.profile, profile = { availability:[0,1,2,3,4,5,6].filter(d => data.has(`day-${d}`)).map(day => ({day,start:data.get(`start-${day}`),end:data.get(`end-${day}`)})), sections:{...p.sections}, devices:{...p.devices}, quiet:{start:data.get('quietStart'),end:data.get('quietEnd')} };
      for (const key of ['dailyLimitMinutes','blockMinutes','bufferMinutes','breakMinutes']) profile[key] = Number(data.get(key));
      for (const [key,value] of data.entries()) { if (key.startsWith('section:')) profile.sections[key.slice(8)] = value.trim(); if (key.startsWith('device:')) profile.devices[key.slice(7)] = value; }
      await event('PROFILE_UPDATED',{profile},'空闲时间已保存'); return closeModal();
    }
    if (form.id === 'busy-form') { await event('PROFILE_UPDATED',{profile:{busy:[...state.profile.busy,{title:data.get('title'),start:localISO(data.get('start')),end:localISO(data.get('end'))}]}},'已有安排已添加'); return closeModal(); }
    if (form.id === 'feedback-form') { await event('EFFORT_FEEDBACK_RECORDED',{taskId:form.dataset.task,actualMinutes:Number(data.get('actualMinutes'))},'用时反馈已保存'); return taskModal(form.dataset.task); }
    const id = form.dataset.task, t = taskOf(id), fixed = fixedFor(t,state.profile), patch = {remainingMinutes:Number(data.get('remainingMinutes'))}, when = data.get('when'), end = data.get('end');
    if (timeMode(t)) {
      if ((when&&!end)||(!when&&end)) throw new Error('请填完整的开始和结束时间');
      if (when && (ms(localISO(when))!==ms(fixed?.start) || ms(localISO(end))!==ms(fixed?.end))) { patch.fixed={start:localISO(when),end:localISO(end),origin:'user_confirmed'}; patch.sectionOptions=null; }
    } else if (when && ms(localISO(when))!==ms(t.deadline?.at)) patch.deadline={at:localISO(when),date:when.slice(0,10),precision:'minute',origin:'user_confirmed'};
    await event('TASK_CHANGED',{taskId:id,patch,message:'任务安排已调整'}); taskModal(id);
  });
});
document.addEventListener('input', e => { if (e.target.id === 'search') { search=e.target.value; const start=e.target.selectionStart; render(); $('#search').focus(); $('#search').setSelectionRange(start,start); } });
document.addEventListener('change', e => { if (e.target.id === 'task-filter') { taskFilter=e.target.value; render(); } });
$('#task-dialog').addEventListener('click', e => { if (e.target === $('#task-dialog')) { const r=e.target.getBoundingClientRect(); if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal(); } });
window.addEventListener('hashchange', render);
try { state = await request('/api/state'); render(); }
catch(error) { $('#main').innerHTML=empty('暂时没有连上服务',esc(error.message)); }
setInterval(async () => {
  if (!state || busy || $('#task-dialog').open) return;
  try { const next=await request('/api/state'); if (JSON.stringify(next)!==JSON.stringify(state) && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)) {state=next;render();} } catch { /* Keep the current view until the next poll. */ }
}, 3000);
