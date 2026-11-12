import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../server.mjs';

export async function runBrowserChecks() {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
  const server=await createApp({stateFile:null});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`, output=fileURLToPath(new URL('../artifacts/',import.meta.url));
  const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true}), checks=[], errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const click=selector=>page.locator(selector).first().click();
  async function post(selector,path,status=200){
    const [response]=await Promise.all([page.waitForResponse(r=>r.url()===base+path&&r.request().method()==='POST'),click(selector)]);
    const result=await response.json();assert.equal(response.status(),status,JSON.stringify(result));
    await page.waitForFunction(()=>document.body.dataset.busy!=='true');return result;
  }
  async function nav(tab){await click(`nav a[data-tab="${tab}"]`);await page.waitForFunction(t=>document.querySelector('#main').dataset.tab===t,tab);}
  async function scenario(id){await click('[data-action="scenarios"]');await page.locator(`[name="scenario"][value="${id}"]`).check();return post('[form="scenario-form"]','/api/import');}
  async function noOverflow(label){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),label);}
  async function shot(name,selector){await (selector?page.locator(selector):page).screenshot({path:output+name,...(selector?{}:{fullPage:true})});}
  try{
    await mkdir(output,{recursive:true});await page.goto(base+'/#overview');await page.locator('main .heading').waitFor();
    assert.equal(await page.locator('nav a').count(),3);assert.equal(await page.locator('dialog').count(),1);
    assert.equal((await page.locator('main').innerText()).includes('AI 边界'),false);
    await shot('simple-welcome.png');checks.push('三个主导航、一个对话框；首页没有设置、日志和多层说明');
      let s=await post('[data-action="quick-demo"]','/api/import');assert.equal(s.tasks.length,2);
      s=await post('[data-action="plan"]','/api/events');assert.ok(s.plan.blocks.length);await nav('tasks');
      await shot('simple-tasks.png');checks.push('一键体验两项作业，下一步按钮生成实际计划');
      await click('[data-action="detail"]');await page.locator('#task-dialog[open]').waitFor();
      await page.getByText('来源 ·',{exact:false}).click();assert.ok((await page.locator('dialog pre').first().textContent()).length>10);
      await page.keyboard.press('Escape');assert.equal(await page.locator('dialog').evaluate(d=>d.open),false);
      checks.push('任务要求、来源集中在详情中；Escape 返回列表');
      await nav('plan');await click('[data-action="profile"]');await page.locator('#daily-limit').fill('150');
      s=await post('[form="profile-form"]','/api/events');assert.equal(s.profile.dailyLimitMinutes,150);
      await click('[data-action="busy"]');await page.locator('#busy-title').fill('小组会议');
      s=await post('[form="busy-form"]','/api/events');assert.equal(s.profile.busy.length,1);
      s=await post('[data-action="lock"]','/api/events');const locked=s.plan.blocks.find(b=>b.locked).id;
      s=await post('[data-action="plan"]','/api/events');assert.ok(s.plan.blocks.some(b=>b.id===locked&&b.locked));
      await shot('simple-plan.png');checks.push('空闲设置、已有安排和锁定仍联动，计划统一成一条时间线');
      for(let i=0;i<5&&!s.notifications.some(n=>n.type==='plan'&&['delivered','read'].includes(n.status));i++)s=await post('[data-action="next-notice"]','/api/events');
      assert.ok(s.notifications.some(n=>n.type==='plan'&&n.status==='delivered'));
      s=await post('[data-action="demo-event"]','/api/demo/event');const submitted=s.tasks.find(t=>t.status.value==='submitted');assert.ok(submitted);assert.equal(s.plan.blocks.some(b=>b.taskId===submitted.id),false);
      checks.push('演示下一步实际触发提醒，模拟提交后释放对应时段');
      await scenario('exam-change');await post('[data-action="plan"]','/api/events');
      s=await post('[data-action="demo-event"]','/api/demo/event');assert.ok(s.tasks[0].fixed.start.startsWith('2024-11-10'));assert.equal(s.tasks[1].status.value,'unknown');
      await scenario('capacity');await post('[data-action="plan"]','/api/events');s=await post('[data-action="demo-event"]','/api/demo/event');assert.ok(s.plan.risks.some(r=>r.code==='insufficient_time'));
      checks.push('考试改期与推迟容量不足场景均可从单一演示入口操作');
      await scenario('english');await nav('plan');await click('[data-action="profile"]');
      await page.getByText('班级与设备',{exact:true}).click();await page.locator('[name="section:ENG1001"]').fill('L12');await page.locator('[name="device:ENG1001"]').selectOption('own');
      await post('[form="profile-form"]','/api/events');s=await post('[data-action="plan"]','/api/events');assert.equal(s.plan.fixed.length,1);assert.ok(s.plan.fixed[0].start.includes('10:30'));
      await nav('tasks');assert.match(await page.locator('main').innerText(),/无需处理/);
      s=await post('[data-action="demo-event"]','/api/demo/event');assert.equal(s.tasks.find(t=>t.kind==='presentation').status.value,'unknown');
      checks.push('分班、设备和上传／展示分离保留在精简界面中');
    await page.setViewportSize({width:390,height:844});
    for(const t of ['tasks','plan','reminders']){await nav(t);await noOverflow('mobile '+t);}
    await nav('tasks');await shot('simple-mobile.png');await click('[data-action="settings"]');await noOverflow('mobile settings');await page.keyboard.press('Escape');
    await click('[data-action="scenarios"]');await noOverflow('mobile scenarios');await page.keyboard.press('Escape');
    checks.push('390px 手机端三个页面与设置／演示窗口无横向溢出');
    assert.deepEqual(errors,[]);
    const report={testType:'real-course-core-flows',actualModelTest:false,passed:checks.length,checks,browserErrors:errors};
    await writeFile(output+'browser-report.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
  }finally{await browser.close();server.close();await once(server,'close');}
}
