import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {chromium} from 'playwright';
const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE||new URL('../workflow.mjs',import.meta.url),'utf8').replace(/\r\n/gu,'\n');
const start=source.indexOf('const dismissEmptyPddModal = async'),end=source.indexOf('\nconst isPddShippingTabActive =',start);
assert(start>=0&&end>start);
const sandbox={logRunStep(){}};
vm.runInNewContext(source.slice(start,end)+'\nglobalThis.dismiss=dismissEmptyPddModal;',sandbox);
const browser=await chromium.launch({headless:true,...(process.env.TEST_CHROME_PATH?{executablePath:process.env.TEST_CHROME_PATH}:{})});
try{
 const page=await browser.newPage();
 const render=async extra=>page.setContent(`
  <style>[data-testid="beast-core-modal"]{display:block;min-width:200px;min-height:100px}
  [data-testid="beast-core-modal-container"]{width:100px;height:30px}</style>
  <div data-testid="beast-core-modal" id="outer">
   <div data-testid="beast-core-modal-container"></div>${extra}
   <button id="close" aria-label="关闭" data-testid="beast-core-modal-close-button" onclick="window.closes=(window.closes||0)+1;document.getElementById('outer').hidden=true;document.getElementById('outer').style.display='none'"></button>
  </div><script>window.closes=0;window.escapes=0;document.addEventListener('keydown',e=>{if(e.key==='Escape')window.escapes++});</script>`);
 for(const [name,content] of [
  ['business sibling','<h2>问题反馈</h2><textarea></textarea>'],
  ['verification sibling','<div>请向右滑块完成拼图</div><iframe title="安全验证" srcdoc="<p>verify</p>"></iframe>'],
  ['textless image','<img alt="" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2250%22 height=%2250%22/%3E">'],
  ['textless slider','<div role="slider" aria-valuenow="0"></div>'],
  ['textless canvas','<canvas width="80" height="40"></canvas>'],
  ['background challenge','<div style="height:40px;background-image:linear-gradient(red,blue)"></div>'],
  ['unlabelled business control','<button aria-label="确认"></button>'],
  ['close-named business area','<div class="close-business-content"><textarea></textarea></div>'],
  ['loading state','<div aria-busy="true"></div>'],
  ['pseudo-element challenge','<style>#challenge::before{content:"";display:block;height:40px;background-image:linear-gradient(red,blue)}</style><div id="challenge"></div>'],
 ]){
  await render(content);
  assert.equal(await sandbox.dismiss(page,'test'),false,`${name}: an empty child must not dismiss a nonempty modal`);
  assert.equal(await page.locator('#outer').isVisible(),true,`${name}: outer modal preserved`);
  assert.equal(await page.evaluate(()=>window.closes),0);
  assert.equal(await page.evaluate(()=>window.escapes),0);
 }
 await render('');
 assert.equal(await sandbox.dismiss(page,'empty-shell'),true);
 assert.equal(await page.locator('#outer').isVisible(),false,'a truly empty shell is still recoverable');
 assert.equal(await page.evaluate(()=>window.closes),1,'use the outer wrapper close button');
 assert.equal(await page.evaluate(()=>window.escapes),0,'do not send an unscoped Escape');
 await render('');
 await page.locator('#close').evaluate(button=>{button.textContent='×';button.innerHTML+='<svg width="10" height="10"><path d="M0 0L10 10M0 10L10 0"/></svg>';});
 assert.equal(await sandbox.dismiss(page,'close-icon'),true,'a real close icon is not business content');
 assert.equal(await page.evaluate(()=>window.closes),1);
 await render('');
 await page.evaluate(()=>setTimeout(()=>{
  const input=document.createElement('input');
  document.getElementById('outer').appendChild(input);
 },80));
 assert.equal(await sandbox.dismiss(page,'mounting-content'),false,'allow content to mount before clearing a shell');
 assert.equal(await page.evaluate(()=>window.closes),0);
 await render('');
 await page.locator('#close').evaluate(button=>button.remove());
 assert.equal(await sandbox.dismiss(page,'empty-no-close'),true,'empty wrapper fallback remains bounded');
 assert.equal(await page.evaluate(()=>window.escapes),0);
 await render('');
 await page.locator('#close').evaluate(button=>button.onclick=()=>{
  window.closes++;
  const frame=document.createElement('iframe');frame.title='安全验证';
  document.getElementById('outer').appendChild(frame);
 });
 assert.equal(await sandbox.dismiss(page,'late-content'),false,'content arriving during close must prevent fallback hiding');
 assert.equal(await page.locator('#outer').isVisible(),true);
 await render('');
 await page.locator('#close').evaluate(button=>button.onclick=()=>{
  window.closes++;
  setTimeout(()=>{
   const frame=document.createElement('iframe');
   document.getElementById('outer').appendChild(frame);
  },60);
 });
 assert.equal(await sandbox.dismiss(page,'async-content'),false,'asynchronously mounted content must prevent hiding');
 assert.equal(await page.locator('#outer').isVisible(),true);
 await render('<h2>不得关闭的业务表单</h2>');
 await page.evaluate(()=>{
  const empty=document.createElement('div');empty.id='other';empty.setAttribute('role','dialog');
  empty.style.cssText='width:200px;height:100px';document.body.appendChild(empty);
 });
 assert.equal(await sandbox.dismiss(page,'separate-shell'),true);
 assert.equal(await page.locator('#other').isVisible(),false);
 assert.equal(await page.locator('#outer').isVisible(),true,'leave other dialogs untouched');
 assert.equal(await page.evaluate(()=>window.closes+window.escapes),0);
 console.log('PDD empty-modal scope regression passed (business/CAPTCHA/media preserved, exact empty wrapper recovery, no Escape, late-content recheck)');
}finally{await browser.close();}
