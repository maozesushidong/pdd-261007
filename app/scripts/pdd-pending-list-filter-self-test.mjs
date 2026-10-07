import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const { ensurePddPendingListFilter, ensurePddAllListStatuses } = await import(process.env.PENDING_FILTER_TEST_MODULE
  ? pathToFileURL(process.env.PENDING_FILTER_TEST_MODULE).href
  : new URL('../packages/adapters/src/pdd/pending-list-filter.mjs', import.meta.url).href);
import { hasVisiblePddLoadingState, hasExactPddOrderQueryEmptyResult } from '../packages/adapters/src/pdd/render-wait.mjs';

const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE || new URL('../workflow.mjs',import.meta.url),'utf8');
const begin=source.indexOf('const pddListEmptyStatePattern =');
const end=source.indexOf('const waitForOrdinaryListRenderState =',begin);
assert(begin>0&&end>begin);
const sandbox={hasVisiblePddLoadingState,hasExactPddOrderQueryEmptyResult,
  firstVisible:async locators=>{for(const locator of locators){for(let i=0;i<await locator.count();i++){if(await locator.nth(i).isVisible())return locator.nth(i);}}return null;},
  locateWorkOrderAction:async()=>{throw new Error('not used by these unfiltered fixtures');},
  ordinaryListPageSignature:async page=>page.getByText('立即处理',{exact:true}).allTextContents().then(items=>items.join('|')),
};
vm.runInNewContext(source.slice(begin,end)+'\nglobalThis.inspect=inspectOrdinaryListRenderState;',sandbox);
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROME_PATH?{executablePath:process.env.TEST_CHROME_PATH}:{})});
try {
  const page=await browser.newPage();
  const native=`<div><label>问题类型<select id="other"><option>全部</option><option>待处理</option></select></label></div>
    <div><label>工单状态</label><select id="status"><option>全部</option><option>待处理</option></select></div>
    <section id="results">已完结 立即查看</section>
    <script>window.changes=0;statusControl=document.getElementById('status');
      statusControl.onchange=()=>{window.changes++;document.getElementById('results').innerHTML='共查询到 1 个工单<button>立即处理</button>';};</script>`;
  await page.setContent(native);
  assert.equal(await sandbox.inspect(page),null,'a completed-only first page is not evidence of an empty pending queue');
  assert.equal((await ensurePddPendingListFilter(page)).changed,true);
  assert.equal(await page.locator('#status').inputValue(),'待处理');
  assert.equal(await page.locator('#other').inputValue(),'全部','do not select another field that has the same values');
  assert.equal((await sandbox.inspect(page)).kind,'items');
  assert.equal((await ensurePddPendingListFilter(page)).changed,false);
  assert.equal(await page.evaluate(()=>window.changes),1,'already-selected status must not be toggled or queried again');
  await page.setContent(native);
  await ensurePddPendingListFilter(page);
  assert.equal(await page.locator('#status').inputValue(),'待处理','a reload resets all filters and needs fresh confirmation');
  await page.locator('#results').evaluate(el=>{el.textContent='共查询到 0 个工单 暂无工单';});
  assert.equal((await sandbox.inspect(page)).kind,'empty','rendered empty pending list should finish without a pointless reload');
  await page.locator('#results').evaluate(el=>{el.setAttribute('aria-busy','true');});
  assert.equal(await sandbox.inspect(page),null,'loading must not be mistaken for a completed empty query');

  await page.setContent(`<button id="quick">待处理</button><div><span>工单状态</span>
    <div class="select-control" data-testid="beast-core-select" role="combobox">全部</div></div>
    <div id="portal" style="display:none"><div role="option">全部</div><div role="option">待处理</div></div>
    <script>const control=document.querySelector('[role=combobox]');const portal=document.getElementById('portal');
      document.getElementById('quick').onclick=()=>window.wrongClicked=true;
      control.onclick=()=>portal.style.display='block';
      document.querySelectorAll('[role=option]').forEach(el=>el.onclick=()=>{control.textContent=el.textContent;portal.style.display='none';});</script>`);
  await ensurePddPendingListFilter(page);
  assert.equal(await page.getByRole('combobox').innerText(),'待处理');
  assert.equal(await page.evaluate(()=>!!window.wrongClicked),false,'portal option must not match the similar quick-filter button');

  await page.setContent(`<div><span>工单状态</span><div data-testid="beast-core-select"><span id="selected">全部</span>
    <input role="combobox" readonly /></div></div><div id="portal" style="display:none"><div role="option">待处理</div></div>
    <script>(()=>{const portal=document.getElementById('portal');document.querySelector('input').onclick=()=>portal.style.display='block';
    document.querySelector('[role=option]').onclick=()=>{document.getElementById('selected').textContent='待处理';portal.style.display='none';};})();</script>`);
  await ensurePddPendingListFilter(page);
  assert.equal(await page.locator('#selected').innerText(),'待处理','a search input can leave its selected label on a sibling');

  await page.setContent(`<div data-testid="beast-core-grid-row"><div label="工单状态">工单状态</div><div>
    <div data-testid="beast-core-select" tabindex="0"><div data-testid="beast-core-select-header">
      <input readonly data-testid="beast-core-select-htmlInput" value="全部"><div style="display:none">全部</div>
    </div></div></div></div><div id="portal" style="display:none"><div role="option">待处理</div></div>
    <script>(()=>{const portal=document.getElementById('portal');const control=document.querySelector('[data-testid=beast-core-select]');
    control.onclick=()=>portal.style.display='block';document.querySelector('[role=option]').onclick=()=>{
      document.querySelector('input').value='待处理';portal.style.display='none';};})();</script>`);
  await ensurePddPendingListFilter(page,{timeoutMs:100});
  assert.equal(await page.locator('input').inputValue(),'待处理','live Beast input value is selected state; hidden mirror text is not');

  const exactStart=source.indexOf('const submitPendingOrderQuery =');
  const exactEnd=source.indexOf('const queryPendingOrderPresence =',exactStart);
  assert(exactStart>0&&exactEnd>exactStart);
  const exactSandbox={ensureOrdinaryListQueryControls:async()=>{},
    ensurePddAllListStatuses,checkForHumanVerification:async()=>{},
    pacedAction:async(_page,_stage,action)=>action()};
  vm.runInNewContext(source.slice(exactStart,exactEnd)+'\nglobalThis.query=submitPendingOrderQuery;',exactSandbox);
  await page.setContent(`<div><label>工单状态</label><select id="status"><option>全部</option><option selected>待处理</option></select></div>
    <input placeholder="请输入订单编号"><button>查询</button><section id="results"></section>
    <script>window.queries=0;document.querySelector('button').onclick=()=>{window.queries++;
      document.getElementById('results').innerHTML=document.getElementById('status').value==='全部'
        ?'260917-123456789012345 处理中 <button>立即处理</button>':'共查询到 0 个工单 暂无工单';};</script>`);
  await exactSandbox.query(page,'260917-123456789012345','completion');
  assert.equal(await page.locator('#status').inputValue(),'全部','exact-order checks must clear discovery filters before querying');
  assert.match(await page.locator('#results').innerText(),/处理中/u,'a processing case must remain visible during completion checks');
  await page.locator('#status').selectOption({label:'待处理'});
  exactSandbox.checkForHumanVerification=async()=>{throw new Error('slider-present');};
  await assert.rejects(()=>exactSandbox.query(page,'260917-123456789012345','completion'),/slider-present/);
  assert.equal(await page.evaluate(()=>window.queries),1,'a blocked status reset must not submit an exact-order query');

  await page.setContent(native);
  await assert.rejects(()=>ensurePddPendingListFilter(page,{beforeAction:async()=>{throw new Error('slider-present');}}),/slider-present/);
  assert.equal(await page.locator('#status').inputValue(),'全部','CAPTCHA guard must run before selection');
  await page.setContent('<div><label>问题类型</label><select><option>全部</option><option>待处理</option></select></div>');
  await assert.rejects(()=>ensurePddPendingListFilter(page,{timeoutMs:30}),{code:'PDD_PENDING_LIST_FILTER_UNCONFIRMED'});
  assert.equal(await page.locator('select').inputValue(),'全部');
  console.log('pending list filter browser regression passed (completed first page, reload, empty/loading, native/custom select, duplicate labels, CAPTCHA guard)');
}finally{await browser.close();}
