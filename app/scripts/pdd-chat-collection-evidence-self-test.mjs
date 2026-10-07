import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { chromium } from 'playwright';

const sourceFile=process.env.CHAT_COLLECTOR_SOURCE_FILE || 'packages/adapters/src/chat-analysis/collector.mjs';
const source=fs.readFileSync(path.resolve(sourceFile),'utf8').replace(/^import .*?;\r?\n/u,'').replaceAll('export function ','function ').replaceAll('export async function ','async function ');
const {collectConversation}=vm.runInNewContext(`${source}\n;({collectConversation})`,{
 Date,Map,Set,URL,Buffer,Error,Number,JSON,RegExp,String,Math,
 digest:value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'),
});
const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
const from=new Date(Date.parse(`${day}T00:00:00Z`)-86400000).toISOString().slice(0,10);
const order=`${from.slice(2).replaceAll('-','')}-123456789012345`;
const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROME_PATH?{executablePath:process.env.TEST_CHROME_PATH}:{})});
const mode=process.argv.includes('--range')?'range':process.argv.includes('--images')?'images':process.argv.includes('--readonly')?'readonly':process.argv.includes('--pddugc')?'pddugc':process.argv.includes('--roles')?'roles':'all';
async function fixture({image=false,combined=false,readonly=false,narrow=false,rejectDates=false,failures=0,forbidden=false,interrupt=false,sourceHost='img.pddpic.com',sellerAlias=false,expectedShopName=''}={}){
 const p=await browser.newPage();
 p.setDefaultTimeout(1000);
 const imgUrl=forbidden?'https://unrelated.invalid/image.png':`https://${sourceHost}/test-chat-evidence.png`;
 await p.route('https://mms.pinduoduo.com/**',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><meta charset="utf-8">
 <label><input type="radio">按订单/违规会话编号查询</label><input placeholder="订单/违规会话编号">
 ${combined?`<input id="range" ${readonly?'readonly':''} value="${narrow?`${day} ~ ${day}`:'2026-01-01 ~ 2026-12-31'}">`:`<input placeholder="开始日期" value="${from}"><input placeholder="结束日期" value="${day}">`}
 <button id="query">查询</button><div id="chat"></div><script>
 ${rejectDates?`document.querySelector('#range').onkeydown=e=>{if(e.key==='Enter')e.target.value='2026-01-01 ~ 2026-12-31'};`:''}
 document.querySelector('#query').onclick=()=>{
 window.queriedRange=document.querySelector('#range')?.value;
 document.querySelector('#chat').innerHTML='<div class="chat-item buyer"><div>买家***</div><span>${from} 12:00:00</span><p>收到的两盒商品在这张图片里</p>${image?`<img style="width:180px;height:120px" data-original="${imgUrl}">`:''}</div>'
   + ${JSON.stringify(sellerAlias ? `<div class="message-content"><div class="message-header"><span>${from} 12:01:00</span><div>PANAPOPO防护用品小颜</div></div><p>已核对订单</p></div>` : '')};
 };</script>`}));
 let requests=0;
 const page=new Proxy(p,{get(target,key){
  if(key==='request')return{get:async url=>{
   requests++;assert.equal(url,imgUrl);
   const ok=requests>failures;
   return{ok:()=>ok,status:()=>ok?200:503,headers:()=>({'content-type':'image/png'}),body:async()=>bytes};
  }};
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 class VerificationRequiredError extends Error{}
 let result,error;
 try{result=await collectConversation({page,shopId:'test-only-shop',orderNumber:order,platformCaseKey:'fixture-only',expectedShopName,
  orderFacts:{orderDate:from},beforeAction:async(_page,stage)=>{
   if(interrupt&&stage==='chat-image-read')throw new VerificationRequiredError('fixture slider');
  }});}catch(e){error=e;}
 const queriedRange=await p.evaluate(()=>window.queriedRange||null);
 await p.close();return{result,requests,queriedRange,error};
}
try{
 if(mode==='roles'||mode==='all'){
  const matched=await fixture({sellerAlias:true,expectedShopName:'PANAPOPO防护用品官方旗舰店'});
  assert.equal(matched.result.snapshot.messages.length,2);
  assert.equal(matched.result.snapshot.messages.find(message=>message.rawText.includes('PANAPOPO防护用品小颜'))?.role,'seller');
  assert.equal(matched.result.snapshot.completeness.complete,true,JSON.stringify(matched.result.snapshot.completeness));
  const otherShop=await fixture({sellerAlias:true,expectedShopName:'PANAPOPO个护健康官方旗舰店'});
  assert.equal(otherShop.result.snapshot.messages.find(message=>message.rawText.includes('PANAPOPO防护用品小颜'))?.role,'unknown');
  assert.equal(otherShop.result.snapshot.completeness.complete,false);
  console.log('CHAT_COLLECTOR_EXACT_SHOP_ALIAS_ROLE_OK');
 }
 if(mode==='pddugc'||mode==='all'){
  const actual=await fixture({image:true,sourceHost:'chat-img.pddugc.com'});
  assert.equal(actual.result.images.length,1,'CHAT_PDDUGC_IMAGE_SOURCE_REJECTED');
  assert(actual.result.snapshot.completeness.complete);assert.equal(actual.requests,1);
  assert.equal(actual.result.snapshot.messages[0].attachments[0].status,'ready');
  assert.equal(actual.result.snapshot.messages[0].attachments[0].failure,undefined);
  const impostor=await fixture({image:true,sourceHost:'chat-img.pddugc.com.unrelated.invalid'});
  assert.equal(impostor.requests,0);assert.equal(impostor.result.snapshot.completeness.complete,false);
  assert.equal(impostor.result.snapshot.messages[0].attachments[0].failure?.code,'UNSUPPORTED_IMAGE_SOURCE');
  console.log('CHAT_COLLECTOR_PDDUGC_SOURCE_OK');
 }
 if(mode==='readonly'||mode==='all'){
  const r=await fixture({combined:true,readonly:true});
  assert.equal(r.result.snapshot.messages.length,1,'CHAT_COLLECTOR_READONLY_RANGE_LOST_MESSAGES');
  assert.equal(r.queriedRange,'2026-01-01 ~ 2026-12-31');
  assert.equal(r.result.snapshot.messages[0].source.range.from,'2026-01-01');
  assert.equal(r.result.snapshot.messages[0].source.range.to,'2026-12-31');
  assert.equal(r.result.snapshot.completeness.requested.from,from);
  assert(r.result.snapshot.completeness.complete);
  const missing=await fixture({combined:true,readonly:true,narrow:true});
  assert.equal(missing.queriedRange,null);assert.equal(missing.result.snapshot.completeness.complete,false);
  assert(missing.result.snapshot.completeness.issues.includes('CHAT_READONLY_DATE_RANGE_DOES_NOT_COVER_ORDER'));
  console.log('CHAT_COLLECTOR_READONLY_RANGE_PROVENANCE_OK');
 }
 if(mode==='range'||mode==='all'){
  const r=await fixture({combined:true});
  assert.equal(r.queriedRange,`${from} ~ ${day}`,'CHAT_COLLECTOR_DATE_PROVENANCE_FAILED');
  assert(r.result.snapshot.completeness.complete,JSON.stringify(r.result.snapshot.completeness));
  assert.equal(r.result.snapshot.messages[0].source.range.from,from);
  const rejected=await fixture({combined:true,rejectDates:true});
  assert.equal(rejected.queriedRange,null,'Do not query when exact dates were rejected');
  assert.equal(rejected.result.snapshot.completeness.complete,false);
  assert(rejected.result.snapshot.completeness.issues.includes('CHAT_DATE_RANGE_NOT_APPLIED'));
  console.log('CHAT_COLLECTOR_EXACT_RANGE_OK');
 }
 if(mode==='images'||mode==='all'){
  const lazy=await fixture({image:true});
  assert.equal(lazy.result.images.length,1,'CHAT_COLLECTOR_LAZY_IMAGE_LOST');
  assert.equal(lazy.requests,1);assert(lazy.result.snapshot.completeness.complete);
  const retry=await fixture({image:true,failures:1});
  assert.equal(retry.requests,2);assert(retry.result.snapshot.completeness.complete,JSON.stringify(retry.result.snapshot.completeness));
  assert.equal(retry.result.snapshot.messages[0].attachments[0].status,'ready');
  const broken=await fixture({image:true,failures:99});
  assert.equal(broken.requests,2,'Bound image retries');assert.equal(broken.result.snapshot.completeness.complete,false);
  assert.equal(broken.result.snapshot.messages[0].attachments[0].status,'missing');
  assert.equal(broken.result.snapshot.messages[0].attachments[0].failure?.code,'IMAGE_HTTP_ERROR','CHAT_IMAGE_FAILURE_CAUSE_MISSING');
  assert.equal(broken.result.snapshot.messages[0].attachments[0].failure?.httpStatus,503);
  assert.equal(broken.result.snapshot.messages[0].attachments[0].failure?.attempt,2);
  assert(!JSON.stringify(broken.result.snapshot.messages[0].attachments[0]).includes('https://'));
  const forbidden=await fixture({image:true,forbidden:true});
  assert.equal(forbidden.requests,0);assert.equal(forbidden.result.snapshot.completeness.complete,false);
  assert.equal(forbidden.result.snapshot.messages[0].attachments[0].failure?.code,'UNSUPPORTED_IMAGE_SOURCE');
  const held=await fixture({image:true,interrupt:true});
  assert.equal(held.error?.constructor.name,'VerificationRequiredError');assert.equal(held.requests,0);
  console.log('CHAT_COLLECTOR_LAZY_RETRY_AND_VERIFICATION_OK');
 }
}finally{await browser.close();}
