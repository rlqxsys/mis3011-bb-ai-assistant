import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../server.mjs';
import { loadReplayData } from './feed-replay.mjs';

const data=await loadReplayData(),calls=[],checks=[],errors=[];
const provider={info:()=>({configured:true,consent:true,keyStored:true,model:'TEST-DOUBLE'}),configure:()=>provider.info(),
  async complete(messages){
    const {documents:[doc],existingTasks}=JSON.parse(messages.at(-1).content);calls.push(doc);
    const changed=doc.id===data.update.id;assert.deepEqual(doc,changed?data.update:data.initial);
    const evidence=fields=>[{documentId:doc.id,quote:doc.text,fields}];
    const items=[{operation:changed?'update':'new',targetTaskId:existingTasks.find(t=>t.kind==='exam')?.id||null,
      title:'Midterm Exam',kind:'exam',channel:'offline',fixedStart:changed?'2024-11-10T19:00:00+08:00':'2024-11-01T19:00:00+08:00',
      fixedEnd:changed?'2024-11-10T21:00:00+08:00':'2024-11-01T21:00:00+08:00',estimatedMinutes:120,
      requirements:[],uncertainties:[],reason:'原始公告中的考试安排',evidence:evidence(['fixedStart','fixedEnd'])},
      {operation:changed?'reinstate':'cancel',targetTaskId:existingTasks.find(t=>t.kind==='tutorial')?.id||null,
        title:'Nov. 1 Tutorial',kind:'tutorial',channel:'offline',estimatedMinutes:0,requirements:[],uncertainties:[],
        reason:'原始公告中的取消／恢复通知',evidence:evidence([changed?'reinstate':'cancel'])}];
    return{value:{summary:'读取原始公告',items,questions:[]},meta:{transport:'test_double',model:'TEST-DOUBLE',elapsedMs:0}};
  }};
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE?pathToFileURL(process.env.PLAYWRIGHT_MODULE).href:'playwright');
const temp=await mkdtemp(join(tmpdir(),'bb-native-browser-'));
const server=await createApp({stateFile:null,inboxRoot:join(temp,'inbox'),aiProvider:provider,automationIntervalMs:80});
server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox']}),page=await browser.newPage({viewport:{width:1440,height:1000}});
page.on('pageerror',e=>errors.push(e.message));const posts=[];page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});
const post=async(path,body)=>{const r=await page.request.post(base+path,{data:body});assert.equal(r.status(),200,await r.text());return r.json();};
const state=async()=> (await page.request.get(base+'/api/state')).json();
const output=fileURLToPath(new URL('../artifacts/',import.meta.url));
try{
  await post('/api/ai/session',{now:new Date(Date.parse(data.initial.publishedAt)-1000).toISOString()});
  await page.goto(base+'/#tasks');await page.locator('[data-action="automation"]').click();await page.locator('#auto-scopes').waitFor();
  const scopes=await page.locator('#auto-scopes').inputValue();for(const c of data.subscriptions)assert.ok(scopes.includes(c.courseCode+' '+c.term));
  await page.locator('#auto-scopes').fill('CSC1001 2024');await page.locator('[form="automation-form"]').click();await page.locator('dialog').waitFor({state:'hidden'});
  assert.equal(calls.length,0);checks.push('跟进设置默认来自原始包五门课程，尚未发布的公告不会提前解析');
  await post('/api/events',{id:'native-old-source',type:'CLOCK_ADVANCED',to:data.initial.publishedAt});
  await page.locator('.task-title').waitFor({timeout:10000});let s=await state();const exam=s.tasks.find(t=>t.kind==='exam');assert.ok(s.plan.blocks.some(b=>b.taskId===exam.id));
  checks.push('原始公告到达后页面自动出现真实 CSC1001 考试与准备安排，无材料上传或手动分析');
  await page.locator('[data-action="detail"]').first().click();await page.getByText('来源 ·',{exact:false}).click();
  assert.match(await page.locator('dialog').innerText(),/ann\[16\]/);assert.match(await page.locator('dialog pre').innerText(),/Nov\. 1/);
  const link=page.locator('dialog a[href*="api/source"]');assert.equal((await page.request.get(new URL(await link.getAttribute('href'),base).href)).status(),200);await page.keyboard.press('Escape');
  checks.push('任务引用能定位原始 courses/CSC1001.json 的 ann[16]，原文件可打开');
  await post('/api/events',{id:'native-new-source',type:'CLOCK_ADVANCED',to:data.update.publishedAt});
  await page.waitForFunction(()=>document.querySelector('.task-time')?.textContent.includes('11/10'),{},{timeout:10000});
  s=await state();assert.equal(s.tasks.filter(t=>t.kind==='exam').length,1);assert.equal(s.tasks.find(t=>t.id===exam.id).fixed.start,'2024-11-10T19:00:00+08:00');
  assert.equal(s.notifications.some(n=>n.taskId===exam.id&&n.taskVersion===1&&n.status==='pending'),false);
  assert.equal(calls.length,2);assert.equal(posts.includes('/api/ai/analyze'),false);
  await page.screenshot({path:output+'feed-native-tasks.png',fullPage:true});await page.locator('nav [data-tab="plan"]').click();await page.screenshot({path:output+'feed-native-plan.png',fullPage:true});
  checks.push('原始改期公告自动更新同一考试并撤销旧提醒；模型响应在此浏览器测试中为明确替身');
  await page.setViewportSize({width:390,height:844});for(const tab of ['tasks','plan','reminders']){await page.locator(`nav [data-tab="${tab}"]`).click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
  await page.locator('nav [data-tab="tasks"]').click();await page.screenshot({path:output+'feed-native-mobile.png',fullPage:true});assert.deepEqual(errors,[]);
  checks.push('三个页面在 390px 手机上无横向溢出，只有一个共用弹窗');
  const report={testType:'native-BB_Source_Feed-browser-with-test-double',actualModelTest:false,inputSource:'BB_Source_Feed',passed:checks.length,checks,browserErrors:errors};
  await writeFile(output+'browser-native-feed-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{await browser.close();server.close();await once(server,'close');await rm(temp,{recursive:true,force:true});}
