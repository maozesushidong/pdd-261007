import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {chromium} from 'playwright';
import {hasVisiblePddLoadingState} from '../packages/adapters/src/pdd/render-wait.mjs';
const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE||new URL('../workflow.mjs',import.meta.url),'utf8').replace(/\r\n/gu,'\n');
const a=source.indexOf('const waitForRenderedShippingAnalysis = async');
const b=source.indexOf('\n// PDD occasionally leaves an empty modal',a);
assert(a>=0&&b>a);
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROME_PATH?{executablePath:process.env.TEST_CHROME_PATH}:{})});
try{
 const page=await browser.newPage();
 let reads=0,verification=null;
 const sandbox={Date,console,hasVisiblePddLoadingState,pddLogisticsSettleMs:1000,
  checkForHumanVerification:async()=>{if(verification)throw verification;},
  hasUsableLogistics:data=>data.records.length>0,
  readRenderedShippingAnalysis:async p=>{reads++;return{records:await p.locator('#trace li').allTextContents()};},
  pauseForTransientRetry:async(_page,stage,code,message)=>{throw Object.assign(new Error(message),{stage,code});},
 };
 vm.runInNewContext(source.slice(a,b)+'\nglobalThis.run=waitForRenderedShippingAnalysis;',sandbox);
 // A populated collapsed record remains rendered throughout an asynchronous
 // expansion, exactly like the captured server evidence.
 await page.setContent('<ul id="trace"><li>按寄件人指定地址投递。</li></ul><div id="mask">加载中...</div>');
 await page.evaluate(()=>setTimeout(()=>{
  document.querySelector('#mask').remove();
  document.querySelector('#trace').innerHTML='<li>已揽收</li><li>离开转运中心</li><li>正在派送</li>';
 },150));
 const expanded=await sandbox.run(page);
 assert.equal(expanded.records.length,3,'SHIPPING_LOADING_MUST_NOT_RETURN_COLLAPSED_RECORD');
 assert.equal(reads,1,'read only once the loading mask clears');
 // Real loading class without text must also block stale evidence.
 sandbox.pddLogisticsSettleMs=100;
 await page.setContent('<ul id="trace"><li>old record</li></ul><div class="beast-core-loading" style="height:50px;width:50px"></div>');
 reads=0;
 await assert.rejects(()=>sandbox.run(page),error=>error.code==='PDD_LOGISTICS_ANALYSIS_TEMPORARILY_UNAVAILABLE');
 assert.equal(reads,0);assert.equal(await page.locator('.beast-core-loading').isVisible(),true,'never dismiss loading overlays');
 await page.setContent('<ul id="trace"><li>已揽收</li></ul><div hidden>加载中...</div>');
 assert.equal((await sandbox.run(page)).records.length,1,'hidden loading text does not block ready data');
 await page.setContent('<ul id="trace"></ul>');
 assert.equal((await sandbox.run(page)).records.length,0,'settled empty logistics preserves existing waiting behavior');
 for(const name of ['HumanVerificationRequiredError','HumanVerificationTimeoutError','PddLoginRequiredError','RateLimitPauseError']){
  verification=Object.assign(new Error(name),{name});reads=0;
  await page.setContent('<ul id="trace"><li>old record</li></ul><div id="slider" role="slider">验证码</div>');
  await assert.rejects(()=>sandbox.run(page),error=>error===verification);
  assert.equal(reads,0);assert.equal(await page.locator('#slider').isVisible(),true);
 }
 console.log('PDD shipping loading regression passed (actual browser loading overlays, delayed timeline, timeout, empty data, typed interruptions preserved)');
}finally{await browser.close();}
