import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../packages/adapters/src/oms/reissue.mjs',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const start=source.indexOf('export const submitOmsFlatBatchReissue = async');
const end=source.indexOf('\n};',start)+3;
assert(start>=0&&end>start);
const fnSource=source.slice(start,end).replace(/^export /,'');
for(const mode of ['pre-click-timeout','dispatch-error-no-receipt','dispatch-error-with-request']){
 const handlers=new Map();let attempted=0,trials=0;
 const clickError=new Error('fixture timeout');
 const button={
  isEnabled:async()=>true,scrollIntoViewIfNeeded:async()=>{},
  click:async options=>{
   if(options.trial){trials++;if(mode==='pre-click-timeout')throw clickError;return}
   attempted++;
   if(mode==='dispatch-error-with-request')handlers.get('request')({method:()=> 'POST',url:()=> 'https://fixture.jeoms.com/reissue',postData:()=> '{}'});
   throw clickError;
  },
 };
 const locator={locator(){return this},getByRole(){return this},filter(){return this},last(){return this}};
 const page={on:(event,fn)=>handlers.set(event,fn),off:(event)=>handlers.delete(event)};
 const bindings={
  firstVisible:async()=>button,
  inspectOmsFlatBatchReissueForm:async()=>({valid:true,blockingItems:[]}),
  describeElement:async()=>({tag:'button',text:'确定'}),
  describeVisibleElements:async()=>[],
 };
 const run=new Function(...Object.keys(bindings),`${fnSource};return submitOmsFlatBatchReissue;`)(...Object.values(bindings));
 await assert.rejects(run(page,locator,{timeoutMs:50}),error=>{
  const before=mode==='pre-click-timeout';
  assert.equal(error.externalEffectStatus,before?'failed':'unknown');
  assert.equal(error.externalEffectReceipt.clickAttempted,!before);
  if(mode==='dispatch-error-with-request')assert.equal(error.externalEffectReceipt.requests.length,1,'retain request evidence for read-only reconciliation');
  return true;
 });
 assert.equal(trials,1);
 assert.equal(attempted,mode==='pre-click-timeout'?0:1,'never repeat the business click');
 assert.equal(handlers.size,0,'always remove network/dialog listeners');
}
console.log('OMS reissue click outcome regression passed: preflight failure vs uncertain dispatch, retained receipt, no repeat click');
