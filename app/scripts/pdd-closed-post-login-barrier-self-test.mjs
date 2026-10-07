import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const file=process.argv[2]||new URL('../workflow.mjs',import.meta.url);
const source=fs.readFileSync(file,'utf8');
const start=source.indexOf('const beginPddPostLoginBarrier =');
const end=source.indexOf('const markPddLoginTransition =',start);
assert.ok(start>=0&&end>start);
const page=(closed=false,url='https://mms.pinduoduo.com/aftersales/work_order/list')=>({isClosed:()=>closed,url:()=>url});
const fixture=(initialBarrier=null)=>{
  let now=10_000;
  const writes=[];const sleeps=[];let starts=0;
  class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
  const context={Date:Clock,console:{log(){}},shopId:'isolated-fixture',pddLoginMode:'manual',pddPostLoginStabilityMs:10_000,
    pddPostLoginRecoveryDurationMs:180_000,pddPostLoginRecoveryIntervalMs:3500,
    pddPostLoginRecoveryPacing:{start(){starts++;}},
    readProgress:()=>({pddPostLoginStability:{status:'waiting'}}),writeProgress:p=>writes.push(p),
    pddPostLoginBarrierPendingFromProgress:()=>true,
    isPddBusinessPageForBarrier:p=>Boolean(p&&!p.isClosed()&&p.url().startsWith('https://mms.pinduoduo.com/')&&!p.url().includes('/login/')),
    isSystemLoginUrl:(_system,url)=>url.includes('/login/'),
    PddLoginRequiredError:class extends Error{},
    setTimeout:(callback,ms)=>{sleeps.push(ms);now+=ms;queueMicrotask(callback);return 1;},
    initialBarrier,
  };
  const api=vm.runInNewContext(`let pddPostLoginBarrier=initialBarrier;let pddPostLoginBarrierPromise=null;let pddPostLoginBarrierPromiseBarrier=null;
    ${source.slice(start,end)}
    ({begin:beginPddPostLoginBarrier,wait:waitForPddPostLoginBarrier,
      getBarrier:()=>pddPostLoginBarrier,setPromise:p=>{pddPostLoginBarrierPromise=p;pddPostLoginBarrierPromiseBarrier=p?pddPostLoginBarrier:null;}})`,context);
  return {api,writes,sleeps,get starts(){return starts;},get now(){return now;}};
};

const newPage=page();
const stale=()=>({page:page(true),completed:false,deadlineAt:9_000,startedAt:new Date(0).toISOString()});
{
  const f=fixture(stale());
  const result=await f.api.wait(newPage,'resident-post-login-stability');
  assert.equal(result,newPage,'a closed former detail must not block the live business anchor');
  assert.equal(f.api.getBarrier().page,newPage);
  assert.equal(f.api.getBarrier().completed,true);
  assert.deepEqual(f.sleeps,[10_000],'the replacement must retain the full post-login wait');
  assert.equal(f.starts,1);
}
{
  const f=fixture(stale());
  const result=f.api.begin(newPage,'pdd-mainframe-login-to-business',{force:true});
  assert.equal(result.page,newPage,'a real login navigation must replace a closed unfinished barrier');
  assert.equal(result.deadlineAt,20_000);
}
{
  const live=page();const barrier={page:live,completed:false,deadlineAt:15_000};const f=fixture(barrier);
  assert.equal(f.api.begin(newPage),barrier,'an existing live barrier still coalesces waits');
  await f.api.wait(live,'resident-post-login-stability');
  assert.deepEqual(f.sleeps,[5_000]);
}
{
  const live=page();const barrier={page:live,completed:true,deadlineAt:9_000};const f=fixture(barrier);
  await f.api.wait(live,'resident-post-login-stability');
  assert.equal(f.writes.length,0,'normal completed barriers retain their existing behavior');
  assert.equal(f.starts,0);
}
{
  const barrier=stale();const f=fixture(barrier);
  await assert.rejects(()=>f.api.wait(barrier.page,'return-refund-close-detail-before'),/页面已关闭/);
  assert.equal(f.api.getBarrier(),barrier,'an operation on its own closed page must still fail');
  assert.equal(f.starts,0);
}
{
  const f=fixture(stale());let rejectOld;
  const old=new Promise((_,reject)=>{rejectOld=reject;});
  const owned=old.finally(()=>f.api.setPromise(null));owned.catch(()=>{});f.api.setPromise(owned);
  const waiting=f.api.wait(newPage,'resident-post-login-stability');
  await Promise.resolve();
  assert.equal(f.writes.length,0,'do not overlap a new barrier with an old in-flight waiter');
  rejectOld(new Error('PDD 登录后稳定等待页面已关闭'));
  await waiting;
  assert.equal(f.api.getBarrier().page,newPage);
  assert.deepEqual(f.sleeps,[10_000]);
}
{
  const f=fixture(stale());let rejectOld;
  const old=new Promise((_,reject)=>{rejectOld=reject;});
  const owned=old.finally(()=>f.api.setPromise(null));owned.catch(()=>{});f.api.setPromise(owned);
  f.api.begin(newPage,'pdd-mainframe-login-to-business',{force:true});
  const waiting=f.api.wait(newPage,'resident-post-login-stability');
  await Promise.resolve();
  assert.equal(f.starts,0,'the old in-flight waiter is retained even after a navigation replaces its barrier');
  rejectOld(new Error('PDD 登录后稳定等待页面已关闭'));
  await waiting;
  assert.equal(f.api.getBarrier().page,newPage);
  assert.deepEqual(f.sleeps,[10_000]);
}
console.log('closed post-login barrier self-test passed (7 scenarios)');
