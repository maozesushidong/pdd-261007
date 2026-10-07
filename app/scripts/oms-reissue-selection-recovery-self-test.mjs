import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {chromium} from 'playwright';
const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE||new URL('../workflow.mjs',import.meta.url),'utf8').replace(/\r\n/gu,'\n');
const section=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a);return source.slice(a,b);};
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROME_PATH?{executablePath:process.env.TEST_CHROME_PATH}:{})});
try{
 const page=await browser.newPage();
 const sourceDeclarations=[
  section('const assertSingleOmsBatchReissueSelection = async','\nconst omsGridRowsForOrder ='),
  section('const runOmsReissueCreationUnlocked = async','\nconst runOmsReissueCreation ='),
 ].join('\n');
 const order='260904-231840213430110';
 const beforeEffect=new Error('stopped at effect boundary');
 let counts=[],opens=0,reloads=0,effects=0;
 const sandbox={Date,console,ORDINARY_SCENARIO_CODES:{DELIVERY_RISK_CONCERN:'delivery-risk-concern'},
  ensureOmsWarehouseMutationAllowed:async()=>{},ordinaryExecutionFor:()=>({}),
  openOmsReissueWizard:async(_page,_context,actualOrder)=>{
   assert.equal(actualOrder,order);const count=counts[Math.min(opens++,counts.length-1)];
   await page.setContent(`<div id="count">已选择${count}条</div><div class="el-dialog">批量补发</div>`);
   return {originalSalesOrderCode:'SO20260904000001'};
  },
  selectOmsReissueReason:async()=>{},findOmsFlatBatchReissueDialog:async()=>page.locator('.el-dialog'),
  writeProgress(){},readProgress:()=>({}),saveWorkflowDiagnostics:async()=>{},
  ensureOmsOrderManagementPage:async()=>{},
  guardedExternalEffect:async(effect)=>{
   effects++;assert.equal(effect.request.productCount,1);assert.equal(effect.request.orderNumber,order);
   assert.equal(effect.request.originalSalesOrderCode,'SO20260904000001');throw beforeEffect;
  },
 };
 vm.runInNewContext(sourceDeclarations+'\nglobalThis.api={assertSingleOmsBatchReissueSelection,runOmsReissueCreationUnlocked};',sandbox);
 // Only reload is replaced; rendered counts and the full production preflight
 // execute in Chromium. No submit action is ever called by this regression.
 const target=new Proxy(page,{get(object,key){
  if(key==='reload')return async()=>{reloads++;};
  const value=Reflect.get(object,key);return typeof value==='function'?value.bind(object):value;
 }});
 const run=values=>{counts=values;opens=0;reloads=0;effects=0;return sandbox.api.runOmsReissueCreationUnlocked(target,null,order);};
 await assert.rejects(run([0,1]),error=>error===beforeEffect,'zero selection should requery once before the effect boundary');
 assert.equal(opens,2);assert.equal(reloads,1);assert.equal(effects,1);
 await assert.rejects(run([0,0]),/OMS 批量补发已选择数量异常: 0/u);
 assert.equal(opens,2,'permanent zero cannot retry indefinitely');assert.equal(effects,0);
 await assert.rejects(run([2]),/OMS 批量补发已选择数量异常: 2/u);
 assert.equal(opens,1,'multiple orders must stop, not reselect or submit');assert.equal(effects,0);assert.equal(reloads,0);
 await assert.rejects(run([1]),error=>error===beforeEffect);
 assert.equal(opens,1);assert.equal(reloads,0);assert.equal(effects,1);
 await page.setContent('<div id="count">已选择0条</div><script>setTimeout(()=>document.getElementById("count").textContent="已选择1条",150);</script>');
 assert.equal(await sandbox.api.assertSingleOmsBatchReissueSelection(page),1,'wait for the grid count to finish rendering');
 console.log('OMS selection recovery passed (0→1 recovery, persistent zero bounded, multi-order stop, normal selection, delayed count, no submission)');
}finally{await browser.close();}
