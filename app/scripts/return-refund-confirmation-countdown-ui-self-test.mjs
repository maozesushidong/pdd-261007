import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { findReturnRefundConfirmationAction, clickReturnRefundConfirmationActionOnce }
 from '../packages/adapters/src/pdd/return-refund.mjs';

const paths=[process.env.TEST_CHROME_PATH,'D:/pdd-native/runtime/chrome/chrome.exe',
 'C:/Program Files/Google/Chrome/Application/chrome.exe'];
const executablePath=paths.find(x=>x&&fs.existsSync(x));
const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
try{
 const page=await browser.newPage();
 // This standalone page is intercepted; no merchant service/session is used.
 await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<html><body></body></html>'}));
 await page.goto('https://refund-confirmation.invalid/');
 const load=async html=>page.setContent(html);
 await load(`<div role="dialog"><h3 id="title" onclick="window.titleClicks=(window.titleClicks||0)+1">同意退款</h3>
 <p>识别到该快递单号已在以下订单中使用，请验收包裹无误后再处理退款</p>
 <div>我已验收包裹无误并同意退款</div>
 <button id="confirm" disabled onclick="window.confirmClicks=(window.confirmClicks||0)+1">确认退款(9s)</button><button>取消</button></div>`);
 const countdown=await findReturnRefundConfirmationAction(page,{timeoutMs:0});
 assert.ok(countdown,'the actual confirmation button must remain identifiable during countdown');
 assert.equal(await countdown.action.getAttribute('id'),'confirm',
  'a static approve heading must never be mistaken for confirmation during countdown');
 let dispatches=0;
 await assert.rejects(()=>clickReturnRefundConfirmationActionOnce(countdown,{timeoutMs:100,
  resolveConfirmation:()=>findReturnRefundConfirmationAction(page,{timeoutMs:0}),onDispatch:()=>dispatches++}),
  e=>e.code==='PDD_RETURN_REFUND_CONFIRMATION_NOT_DISPATCHED');
 assert.equal(dispatches,0,'a disabled countdown cannot mark dispatch');
 await page.locator('#confirm').evaluate(button=>button.disabled=false);
 await assert.rejects(()=>clickReturnRefundConfirmationActionOnce(countdown,{timeoutMs:100,
  resolveConfirmation:()=>findReturnRefundConfirmationAction(page,{timeoutMs:0}),onDispatch:()=>dispatches++}),
  e=>e.code==='PDD_RETURN_REFUND_CONFIRMATION_NOT_DISPATCHED');
 assert.equal(dispatches,0,'countdown text still prevents dispatch if disabled attributes are missing');
 assert.equal(await page.evaluate(()=>window.titleClicks||0),0);
 assert.equal(await page.evaluate(()=>window.confirmClicks||0),0);

 await load('<div role="dialog"><h3>同意退款</h3><div>确认退款操作</div><button id="confirm" disabled onclick="window.confirmClicks=(window.confirmClicks||0)+1">确认退款（1秒）</button><button>取消</button></div>');
 const transitioning=await findReturnRefundConfirmationAction(page,{timeoutMs:0});
 assert.equal(await transitioning?.action.getAttribute('id'),'confirm');
 await page.evaluate(()=>setTimeout(()=>{const b=document.querySelector('#confirm');b.textContent='确认退款';b.disabled=false;},150));
 dispatches=0;
 await clickReturnRefundConfirmationActionOnce(transitioning,{timeoutMs:2000,
  resolveConfirmation:()=>findReturnRefundConfirmationAction(page,{timeoutMs:0}),onDispatch:()=>dispatches++});
 assert.equal(dispatches,1);
 assert.equal(await page.evaluate(()=>window.confirmClicks||0),1,'the real button is dispatched exactly once after countdown');

 for(const html of [
  '<div role="dialog"><h3>同意退款</h3><p>确认退款操作</p><button id="confirm">同意退款</button></div>',
  '<div role="dialog"><p>确认退款操作</p><a id="confirm" href="#">确认</a></div>',
  '<div role="dialog"><p>确认退款操作</p><span role="button" id="confirm">确定</span></div>',
 ]){
  await load(html);const c=await findReturnRefundConfirmationAction(page,{timeoutMs:0});
  assert.equal(await c?.action.getAttribute('id'),'confirm','existing semantic actions must retain their behavior');
 }
 await load('<div role="dialog"><h3>同意退款</h3><p>确认退款操作</p><span>确认退款</span><button>取消</button></div>');
 assert.equal(await findReturnRefundConfirmationAction(page,{timeoutMs:0}),null,
  'non-action headings/text alone are not an irreversible confirmation control');
 await load('<div role="dialog"><p>售后编号：22123456789012 订单编号：260930-111111111111111 售后类型：退货退款 退货物流 确认退款</p><button id="approve">同意退款</button></div>');
 assert.equal(await findReturnRefundConfirmationAction(page,{timeoutMs:0}),null,'detail overlays remain excluded');
 console.log('Refund confirmation countdown UI self-test passed (7 fixtures, countdown with/without disabled attribute, exact-once dispatch and existing action semantics)');
}finally{await browser.close();}
