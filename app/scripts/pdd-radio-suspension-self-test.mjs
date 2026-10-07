import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';

const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE || new URL('../workflow.mjs',import.meta.url),'utf8').replace(/\r\n/gu,'\n');
const between=(start,end)=>{
 const a=source.indexOf(start),b=source.indexOf(end,a);
 assert(a>=0&&b>a,`Missing ${start}`);return source.slice(a,b);
};
const declarations=[
 between('class HumanVerificationRequiredError extends Error','\nconst recordPddLoginRequired ='),
 between('class RateLimitPauseError extends Error','\nclass ManualReviewRequiredError extends Error'),
 between('const uniqueVisibleElement = async','\nconst waitForPddOption ='),
 between('const findNormalizedOrdinaryPddOption = async','\nconst listVisibleOrdinaryPddOptions ='),
 between('const selectOrdinaryPddOption = async','\nconst ordinaryPddMessageButtonPattern ='),
].join('\n');
const firstVisible=async candidates=>{
 for(const locator of candidates)for(let i=0;i<await locator.count();i++){
  const item=locator.nth(i);if(await item.isVisible())return item;
 }return null;
};
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROME_PATH?{executablePath:process.env.TEST_CHROME_PATH}:{})});
try{
 const page=await browser.newPage();
 const label='已同意退货退款';
 const scope=page.locator('body');
 let failure=null,calls=0,transient=0;
 const sandbox={
  console,browserHeadless:false,claimedHumanVerificationTimeoutMs:120000,pddRenderWaitMs:0,
  escapeRegex:value=>value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&'),firstVisible,
  normalizeOrdinaryPddOptionText:value=>String(value).normalize('NFKC').replace(/[\s，,。；;：:、]/gu,''),
  checkForHumanVerification:async()=>{},
  pacedAction:async(_page,_stage,action)=>{
   calls++;
   if(failure)throw failure;
   if(transient-->0)throw new Error('detached option');
   return action();
  },
  expandOrdinaryPddOptionAliases:labels=>labels,
  ordinaryFormScope:async()=>scope,rememberOrdinaryPddSelectionContext(){},
  findOrdinaryPddDecisionEntryAction:async()=>null,listVisibleOrdinaryPddOptions:async()=>[label],
  writeProgress(){},saveWorkflowDiagnostics:async()=>{},
 };
 vm.runInNewContext(declarations+'\nglobalThis.api={selectPddRadioOnce,selectPddRadio,selectOrdinaryPddOption,HumanVerificationRequiredError,HumanVerificationTimeoutError,PddLoginRequiredError,RateLimitPauseError};',sandbox);
 const {api}=sandbox;
 // Exercise both accessible radios and roleless controlled cards. The selection
 // functions come directly from production, including the real checked readback.
 const render=async custom=>page.setContent(custom
  ? `<div onclick="this.className='selected'"><span>${label}</span></div>`
  : `<label><input type="radio" name="outcome">${label}</label><label><input type="radio" name="outcome">同意退款</label>`);
 for(const custom of [false,true]){
  for(const method of ['selectPddRadioOnce','selectPddRadio','selectOrdinaryPddOption']){
   for(const type of ['HumanVerificationRequiredError','HumanVerificationTimeoutError','PddLoginRequiredError','RateLimitPauseError']){
    await render(custom);calls=0;
    failure=new api[type]('select-test','https://example.invalid/detail');
    const operation=method==='selectOrdinaryPddOption'
     ? ()=>api[method](page,[label],{required:false,waitMs:0,scopeOverride:scope})
     : ()=>api[method](page,scope,label,{required:false});
    await assert.rejects(operation,error=>error===failure,`${method}/${custom}/${type} must preserve the original suspension`);
    assert.equal(calls,1,'no second selection attempt after suspension');
   }
  }
 }
 failure=null;
 for(const custom of [false,true]){
  await render(custom);calls=0;
  assert.equal(await api.selectPddRadio(page,scope,label),true);
  assert.equal(calls,1,'normal option is selected once');
 }
 await render(true);calls=0;transient=1;
 assert.equal(await api.selectPddRadioOnce(page,scope,label),true,'ordinary detached-node recovery remains bounded');
 assert.equal(calls,2);
 console.log('PDD radio suspension regression passed (actual Chromium controls, CAPTCHA, timeout, login, rate limit, normal selection, transient retry)');
}finally{await browser.close();}
