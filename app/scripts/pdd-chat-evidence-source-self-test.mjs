import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright';
const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE||new URL('../workflow.mjs',import.meta.url),'utf8').replace(/\r\n/gu,'\n');
const between=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert(a>=0&&b>a);return source.slice(a,b);};
const declarations=between('class HumanVerificationRequiredError extends Error','\nconst recordPddLoginRequired =')
 +between('class RateLimitPauseError extends Error','\nclass ManualReviewRequiredError extends Error')
 +between('const expectedChatEvidencePath =','\nconst resolveOrdinaryPddEvidence =');
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROME_PATH?{executablePath:process.env.TEST_CHROME_PATH}:{})});
const order='260911-099677704563048',quote='找到了，两盒都在，没有少发';
const rangeTest=process.argv.includes('--range');
const decision={evidence:{chatAnalysis:{caseId:'case',jobId:'job',snapshotId:'snapshot',
 messages:[{id:'message-on-page-2',speaker:'买家***',role:'buyer',timestamp:'2026-09-11 12:00:00',text:quote,
  source:{page:2,range:{from:'2026-09-11',to:'2026-09-18'}}}],
 analysis:{evidence:[{messageId:'message-on-page-2',quote}]}}}};
if(rangeTest)decision.evidence.chatAnalysis.messages[0].source.range.to='2026-09-17';
try{
 const context=await browser.newContext();
 await context.route('https://mms.pinduoduo.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`
 <style>main{width:800px;min-height:500px}button{margin:10px}</style><main>
 <label><input type="radio" checked>按订单/违规会话编号查询</label>
 <input placeholder="订单/违规会话编号" value="${order}"><button id="query">查询</button>
 <input placeholder="开始日期" value="2026-09-11"><input placeholder="结束日期" value="2026-09-18">
 <ul><li class="ant-pagination-item-1" onclick="render(1)">1</li><li class="ant-pagination-item-2" onclick="render(2)">2</li></ul>
 <section id="messages"></section></main><script>window.pageVisits=[];window.queries=[];window.queryTo='2026-09-18';function render(n){window.pageVisits.push(n);document.querySelector('#messages').innerHTML=n===2&&(!${rangeTest}||window.queryTo==='2026-09-17')?'<div class="chat-item buyer"><span>买家***</span><time>2026-09-11 12:00:00</time><p>${quote}</p></div>':'<div>当前查询范围或页码没有对应证据</div>'}document.querySelector('#query').onclick=()=>{window.queryTo=document.querySelector('[placeholder="结束日期"]').value;window.queries.push(window.queryTo);render(1)};render(1);</script>`}));
 const page=await context.newPage();await page.goto('https://mms.pinduoduo.com/mms-chat/search');
 let writes=0,closed=0,failure=null;const progress=[];
 const sandbox={path,console,shopId:'test-shop',evidenceScreenshotDir:'C:/codex-test-evidence',workflowDataDir:'C:/codex-test',
  browserHeadless:false,claimedHumanVerificationTimeoutMs:120000,
  reusableChatPage:page,context,
  fs:{mkdirSync(){},writeFileSync(_path,buffer){assert(Buffer.isBuffer(buffer));writes++;},chmodSync(){}},
  toPortableRelativePath:(_root,file)=>file,
  inspectPngBuffer:buffer=>({width:buffer.readUInt32BE(16),height:buffer.readUInt32BE(20),sizeBytes:buffer.length}),
  checkForHumanVerification:async()=>{if(failure)throw failure;},ensurePddLogin:async()=>{},writeProgress(patch){progress.push(patch);},
  createBackgroundPage:async()=>context.newPage(),registerDerivedPage:p=>p,
  closeDerivedPage:async p=>{closed++;await p.close();},
 };
 vm.runInNewContext(declarations+'\nglobalThis.api={capturePddChatEvidenceScreenshot,HumanVerificationRequiredError,HumanVerificationTimeoutError,PddLoginRequiredError,RateLimitPauseError};',sandbox);
 if(process.argv.includes('--captcha')){
  for(const type of ['HumanVerificationRequiredError','HumanVerificationTimeoutError','PddLoginRequiredError','RateLimitPauseError']){
   sandbox.reusableChatPage=null;
   failure=new sandbox.api[type]('chat-evidence-open','https://mms.pinduoduo.com/mms-chat/search');
   await assert.rejects(()=>sandbox.api.capturePddChatEvidenceScreenshot(page,order,decision),e=>e===failure);
   assert.equal(closed,0,'a chat evidence CAPTCHA must retain its original tab');
   assert(sandbox.reusableChatPage&&!sandbox.reusableChatPage.isClosed(),'reuse the exact retained tab after suspension');
   assert.equal(progress.length,0,'do not overwrite the verification/login checkpoint as screenshot-failed');
   assert.equal(writes,0);
  }
 }else{
  const result=await sandbox.api.capturePddChatEvidenceScreenshot(page,order,decision).catch(error=>{
   if(String(error.message).includes('聊天证据原话未在对应分页中找到')){
    throw new Error(rangeTest?'CHAT_EVIDENCE_RANGE_PROVENANCE_FAILED':'CHAT_EVIDENCE_PAGE_PROVENANCE_FAILED',{cause:error});
   }
   throw error;
  });
  assert.equal(writes,1);
  assert.equal(result.evidence[0].messageId,'message-on-page-2');
  assert.equal(result.evidence[0].page,2,'resolve page provenance from the snapshot message, not model output');
  assert((await page.evaluate(()=>window.pageVisits)).includes(2));
  if(rangeTest){
   assert.equal(result.evidence[0].range.to,'2026-09-17');
   assert.equal(await page.locator('[placeholder="结束日期"]').inputValue(),'2026-09-17');
   assert.deepEqual(await page.evaluate(()=>window.queries),['2026-09-17'],'same-order tab must be queried again using snapshot range');
   assert.equal(result.chatCaseId,'case');assert.equal(result.chatJobId,'job');assert.equal(result.chatSnapshotId,'snapshot');
   await page.evaluate(()=>{
    document.querySelector('[placeholder="开始日期"]').remove();
    const range=document.querySelector('[placeholder="结束日期"]');
    range.placeholder='日期范围';range.value='2026-09-11 ~ 2026-09-18';
    document.querySelector('#query').onclick=()=>{
     window.queryTo=range.value.match(/20\d\d-\d\d-\d\d/g)?.[1];
     window.queries.push(window.queryTo);render(1);
    };
   });
   const combined=await sandbox.api.capturePddChatEvidenceScreenshot(page,order,decision);
   assert.equal(combined.evidence[0].range.to,'2026-09-17');
   assert.equal(await page.locator('[placeholder="日期范围"]').inputValue(),'2026-09-11 ~ 2026-09-17');
   const multi=structuredClone(decision);
   multi.evidence.chatAnalysis.messages.unshift({id:'older-window',text:'旧窗口的一段原文',source:{page:2,range:{from:'2026-09-11',to:'2026-09-16'}}});
   multi.evidence.chatAnalysis.analysis.evidence.unshift({messageId:'older-window',quote:'旧窗口的一段原文'});
   const fromSecondWindow=await sandbox.api.capturePddChatEvidenceScreenshot(page,order,multi);
   assert.equal(fromSecondWindow.evidence[0].messageId,'message-on-page-2');
   assert.deepEqual(await page.evaluate(()=>window.queries.slice(-2)),['2026-09-16','2026-09-17'],'identical page numbers from different ranges must be queried independently');
  }
  await page.locator('.ant-pagination-item-1').click();
  const wrongModelPage=structuredClone(decision);
  wrongModelPage.evidence.chatAnalysis.analysis.evidence[0].source={page:1};
  const recovered=await sandbox.api.capturePddChatEvidenceScreenshot(page,order,wrongModelPage);
  assert.equal(recovered.evidence[0].page,2,'ignore untrusted model UI coordinates');
  const successfulWrites=writes;
  for(const invalid of [{messageId:'not-in-snapshot',quote},{messageId:'message-on-page-2',quote:'杜撰的原话'}]){
   const mismatch=structuredClone(decision);mismatch.evidence.chatAnalysis.analysis.evidence=[invalid];
   await assert.rejects(()=>sandbox.api.capturePddChatEvidenceScreenshot(page,order,mismatch),/无法与采集原文对应/);
   assert.equal(writes,successfulWrites,'do not emit unverifiable evidence');
  }
  if(rangeTest){
   for(const range of [undefined,{from:'2026-02-30',to:'2026-03-01'},{from:'2026-09-18',to:'2026-09-11'}]){
    const invalid=structuredClone(decision);invalid.evidence.chatAnalysis.messages[0].source.range=range;
    await assert.rejects(()=>sandbox.api.capturePddChatEvidenceScreenshot(page,order,invalid),/查询日期范围/);
    assert.equal(writes,successfulWrites);
   }
  }
 }
 console.log(`PDD chat evidence ${process.argv.includes('--captcha')?'CAPTCHA retention':rangeTest?'snapshot date range provenance':'snapshot page provenance'} regression passed`);
}finally{await browser.close();}
