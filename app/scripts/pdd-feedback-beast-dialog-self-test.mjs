import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {chromium} from 'playwright';
const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE||new URL('../workflow.mjs',import.meta.url),'utf8').replace(/\r\n/gu,'\n');
const start=source.indexOf('const prepareGoodDeedFeedback = async');
const end=source.indexOf('\nconst submitGoodDeedFeedback =',start);
assert(start>=0&&end>start);
const firstVisible=async candidates=>{
 for(const locator of candidates)for(let i=0;i<await locator.count();i++){
  const item=locator.nth(i);if(await item.isVisible())return item;
 }return null;
};
const sandbox={
 focusSystemPage:async()=>{},firstVisible,
 waitForFirstVisible:async(page,candidates)=>{
  for(let attempt=0;attempt<3;attempt++){
   const found=await firstVisible(candidates);if(found)return found;await page.waitForTimeout(20);
  }return null;
 },
 pacedAction:async(_page,_stage,action)=>action(),updateOrdinaryExecution(){},
 HumanVerificationRequiredError:class extends Error{},PddLoginRequiredError:class extends Error{},RateLimitPauseError:class extends Error{},
};
vm.runInNewContext(source.slice(start,end)+'\nglobalThis.prepare=prepareGoodDeedFeedback;',sandbox);
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROME_PATH?{executablePath:process.env.TEST_CHROME_PATH}:{})});
try{
 const page=await browser.newPage();
 await page.setContent(`
 <button id="entry" onclick="document.getElementById('feedback').style.display='block';window.opens++">对此订单有疑问？点此反馈后自行处理</button>
 <div data-testid="beast-core-modal" class="MDL_outerWrapper_5-155-0 MDL_modal_5-155-0" id="unrelated"><div data-testid="beast-core-modal-container">物流轨迹</div></div>
 <div data-testid="beast-core-modal" class="MDL_outerWrapper_5-155-0 MDL_modal_5-155-0 MDL_showCloseIcon_5-155-0" id="feedback" style="display:none">
  <div data-testid="beast-core-modal-container" class="MDL_container_5-155-0">
   <h2>问题反馈</h2><label>问题类型 <input type="radio" name="reason">其他原因</label>
   <label>问题描述 <textarea></textarea></label><label>手机号（选填）<input type="text" value=""></label>
   <button>确认提交</button>
  </div>
 </div><script>window.opens=0;</script>`);
 const result=await sandbox.prepare(page,'order-one','product-shortage');
 assert.equal(await result.dialog.getAttribute('id'),'feedback','must scope to the visible feedback modal');
 assert.equal(await page.evaluate(()=>window.opens),1,'an already-open Beast feedback modal must not be reopened');
 assert.equal(result.platformPrefilledPhone,'','shortage feedback optional phone stays empty');
 const again=await sandbox.prepare(page,'order-one','product-shortage');
 assert.equal(await again.dialog.getAttribute('id'),'feedback');
 assert.equal(await page.evaluate(()=>window.opens),1,'reuse the existing dialog');
 console.log('PDD Beast feedback dialog regression passed (roleless modal, title scope, reuse, optional phone)');
}finally{await browser.close();}
