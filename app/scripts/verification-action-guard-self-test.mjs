import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { isSystemLoginUrl } from '../packages/adapters/src/browser-runtime-state.mjs';

const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE
  || new URL('../workflow.mjs',import.meta.url),'utf8');
const section=(start,end)=>{
  const first=source.indexOf(start),last=source.indexOf(end,first+start.length);
  assert(first>=0 && last>first,`Missing section ${start}`);
  return source.slice(first,last);
};
const prelude=section('const pddLoginVerificationOrigins =','const closeDeviceAccessIfPrompted =')
  +section('class HumanVerificationRequiredError extends Error','class PddLoginRequiredError')
  +section('const verificationSurfaceFingerprint =','// A wait deadline is a scheduler boundary');
const start=source.indexOf('const checkForHumanVerification =');
const wrapper=source.slice(start,source.indexOf('\n};',start)+3);
const blockedUrl='https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=100';
const detection={selector:'slider',frameUrl:blockedUrl};
const timeout={status:'closed',system:'pdd',timeoutMs:120_000,
  timedOutAt:new Date().toISOString(),suppressUntil:new Date(Date.now()+600_000).toISOString(),
  surface:{url:blockedUrl},fingerprint:JSON.stringify(['pdd',blockedUrl,'detail',blockedUrl,'slider']),
  closeResult:{closed:false,reason:'non-image-click-verification-preserved'}};

const harness=({raw=detection,checkpoint={verificationTimeout:timeout},wait=null}={})=>{
  const state={checks:0,reads:0,actions:0};
  const scope={waitForPddPostLoginBarrier:async page=>page,isSystemLoginUrl,browserHeadless:false,claimedHumanVerificationTimeoutMs:120_000,
    humanVerificationMaxTimeoutMs:120_000,humanVerificationPostTimeoutSuppressionMs:600_000,
    activeHumanVerificationChecks:new Map(),verificationPageRole:()=> 'detail',
    workflowSystemForAction:()=> 'pdd',readProgress:()=>checkpoint,
    checkForHumanVerificationUnsafe:async()=>{state.checks++;if(wait) await wait;return false;},
    detectHumanVerification:async(page)=>{state.reads++;return page.url()===blockedUrl ? raw:null;},
  };
  const check=vm.runInNewContext(`${prelude}\n${wrapper}\ncheckForHumanVerification;`,scope);
  const page=(url)=>({url:()=>url,isClosed:()=>false});
  const act=async(url)=>{await check(page(url),'select-pdd-refund');state.actions++;};
  return {state,act,check,page};
};

const retained=harness();
await assert.rejects(()=>retained.act(blockedUrl),error=>error.code==='HUMAN_VERIFICATION_TIMEOUT'
  && error.verificationCloseResult.closed===false);
assert.equal(retained.state.actions,0,'A scheduler release cannot authorize a click under a live slider');
assert.equal(retained.state.checks,1,'Do not start another full verification wait');

const clear=harness({raw:null});
await clear.act(blockedUrl);
assert.equal(clear.state.actions,1,'Once the slider is gone the ordinary flow can resume');

const another=harness();
await another.act('https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=200');
assert.equal(another.state.actions,1,'A released challenge on another tab must not fabricate this page result');

let release;
const wait=new Promise(resolve=>{release=resolve;});
const concurrent=harness({wait});
const results=Promise.allSettled([
  concurrent.act('https://mms.pinduoduo.com/aftersales/work_order/list'),
  concurrent.act(blockedUrl),
]);
release();
const shared=await results;
assert.equal(concurrent.state.checks,1,'Keep overlapping normal checks coalesced');
assert.equal(shared[0].status,'fulfilled');
assert.equal(shared[1].status,'rejected','Each caller must still check its own retained challenge');
assert.equal(shared[1].reason.code,'HUMAN_VERIFICATION_TIMEOUT');
assert.equal(concurrent.state.actions,1);

const stale=harness({checkpoint:{verificationTimeout:{...timeout,
  suppressUntil:new Date(Date.now()-1000).toISOString()}}});
await stale.act(blockedUrl);
assert.equal(stale.state.reads,0,'Expired cooldowns are handled by the normal verification check');
const absent=harness({checkpoint:{}});
await absent.act(blockedUrl);
assert.equal(absent.state.reads,0,'Normal clear operations do not need an additional detector pass');
console.log('verification action guard self-test passed');
