import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';
const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE||new URL('../workflow.mjs',import.meta.url),'utf8').replace(/\r\n/gu,'\n');
const section=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a);return source.slice(a,b);};
const declarations=[
 section('class HumanVerificationRequiredError extends Error','\nconst recordPddLoginRequired ='),
 section('class RateLimitPauseError extends Error','\nclass ManualReviewRequiredError extends Error'),
 section('const pacedAction = async','\nconst firstVisible ='),
 section('const runPddShippingAction = async','\nconst openExpandedShippingLogistics ='),
].join('\n');
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROME_PATH?{executablePath:process.env.TEST_CHROME_PATH}:{})});
try{
 const page=await browser.newPage();
 let attempts=0,failures=0,handled=false,suspension=null,suspendAt='before',emptyOnRetry=false,diagnostics=0;
 const actionError=new Error('locator.click: Timeout 8000ms exceeded; modal intercepts pointer events');
 const sandbox={console,browserHeadless:false,claimedHumanVerificationTimeoutMs:120000,
  workflowSystemForAction:()=> 'pdd',waitForPddPostLoginBarrier:async()=>{},
  clickVisiblePddStalePageRefresh:async()=>({handled:false}),logRunStep(){},
  dismissEmptyPddModal:async(_page,stage)=>stage.endsWith('-retry')&&emptyOnRetry,
  checkForHumanVerification:async(_page,stage)=>{
   if(suspension&&(suspendAt==='before'||stage.endsWith('-action-error')))throw suspension;
   return stage.endsWith('-action-error')&&handled;
  },
  actionDelayFor:()=>0,isRateLimited:async()=>false,
  saveWorkflowDiagnostics:async()=>{diagnostics++;},
 };
 vm.runInNewContext(declarations+'\nglobalThis.api={runPddShippingAction,HumanVerificationRequiredError,HumanVerificationTimeoutError,PddLoginRequiredError,RateLimitPauseError};',sandbox);
 const {api}=sandbox;
 const render=async()=>{
  attempts=0;failures=0;handled=false;suspension=null;suspendAt='before';emptyOnRetry=false;diagnostics=0;
  await page.setContent('<button onclick="document.querySelector(\'#history\').hidden=false;this.remove()">展开全部</button><ol id="history" hidden><li>已揽收</li><li>运输中</li><li>正在派送</li></ol>');
 };
 const action=async()=>{attempts++;if(failures-->0)throw actionError;await page.getByRole('button',{name:'展开全部'}).click();};
 const run=()=>api.runPddShippingAction(page,'expand-all-logistics',action);
 await render();failures=1;handled=true;
 await run();
 assert.equal(await page.locator('#history').isVisible(),true,'verification clearance must retry the interrupted logistics expansion');
 assert.equal(attempts,2);
 await render();await run();assert.equal(attempts,1,'do not repeat a successful logistics click');
 await render();failures=2;handled=true;
 await assert.rejects(run,error=>error===actionError,'bounded recovery must not report success after a second interrupted click');
 assert.equal(attempts,2);assert.equal(diagnostics,1,'save the actual failing detail page');
 await render();failures=1;
 await assert.rejects(run,error=>error===actionError);assert.equal(attempts,1,'do not retry unknown nonempty overlays');
 await render();failures=1;emptyOnRetry=true;
 await run();assert.equal(attempts,2,'existing empty-shell retry remains available');
 for(const type of ['HumanVerificationRequiredError','HumanVerificationTimeoutError','PddLoginRequiredError','RateLimitPauseError']){
  for(const after of [false,true]){
   await render();suspension=new api[type]('expand-all-logistics','https://example.invalid/detail');
   suspendAt=after?'error':'before';failures=1;
   await assert.rejects(run,error=>error===suspension,`${type} must propagate without another click`);
   assert.equal(attempts,after?1:0);
  }
 }
 console.log('PDD shipping interrupted-action regression passed (actual pacedAction, bounded read-only retry after clearance, suspension preserved, diagnostics)');
}finally{await browser.close();}
