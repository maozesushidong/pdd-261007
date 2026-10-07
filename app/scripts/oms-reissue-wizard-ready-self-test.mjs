import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';
const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE||new URL('../workflow.mjs',import.meta.url),'utf8').replace(/\r\n/gu,'\n');
const between=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a);return source.slice(a,b);};
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROME_PATH?{executablePath:process.env.TEST_CHROME_PATH}:{})});
try{
 const page=await browser.newPage();
 const order='260904-231840213430110';
 const sandbox={
  Date,
  ensureOmsOrderManagementPage:async()=>{},
  queryOmsOrderRow:async()=>({orderCell:page.locator('#order'),rowScope:page.locator('#row')}),
  omsSalesOrderCodeFromRow:async()=> 'SO20260904000001',
  selectOmsOrderRow:async()=>page.locator('#selection').check(),
 };
 vm.runInNewContext([
  between('const firstVisible = async','\n// PDD\'s QR code expires'),
  between('const waitForFirstVisible = async','\nconst readOmsOrderStatus ='),
  between('const openOmsReissueWizard = async','\nconst runOmsReissueCreationUnlocked ='),
  'globalThis.open=openOmsReissueWizard;',
 ].join('\n'),sandbox);
 for(const variant of ['flat','wizard']){
  await page.setContent(`
   <div id="row"><input id="selection" type="checkbox"><span id="order">${order}</span></div>
   <button id="more">更多操作</button><div id="menu" hidden><button role="menuitem" id="reissue">补发</button></div>
   <div id="host"></div>
   <script>
    document.getElementById('more').onclick=()=>document.getElementById('menu').hidden=false;
    document.getElementById('reissue').onclick=()=>setTimeout(()=>{
     document.getElementById('host').innerHTML=${JSON.stringify(variant==='flat'
      ? '<div class="el-dialog"><h2>批量补发</h2><label>补发原因<input value="快递责任补发"></label><p>说明：补发订单不会带原单强制仓信息</p><button onclick="window.submits=(window.submits||0)+1">确定</button></div>'
      : '<div><h2>销售订单-新增</h2><h3>基本信息</h3><button onclick="window.submits=(window.submits||0)+1">下一步</button></div>')};
    },150);
   </script>`);
  const started=Date.now();
  const result=await sandbox.open(page,null,order);
  assert.equal(result.originalSalesOrderCode,'SO20260904000001');
  assert(Date.now()-started<5000,`${variant}: ready form must not wait 30 seconds for an absent heading`);
  assert.equal(await page.locator('#selection').isChecked(),true);
  assert.equal(await page.evaluate(()=>window.submits||0),0,'opening a wizard does not submit an OMS order');
 }
 console.log('OMS reissue wizard readiness passed (flat and multi-step, delayed render, exact source order, no submission)');
}finally{await browser.close();}
