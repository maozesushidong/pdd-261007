import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { classifyReturnRefundUnexpectedFailure } from '../packages/adapters/src/pdd/return-refund.mjs';

const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE || new URL('../workflow.mjs',import.meta.url),'utf8').replace(/\r\n/gu,'\n');
const start=source.indexOf('const runReturnRefundClaimOnly = async');
const end=source.indexOf('\nlet residentOmsWarmupPromise',start);
assert(start>=0&&end>start);
const command={requestId:'request-current',action:'run-refund',aftersaleNumber:'after-current',detailUrl:'https://example.invalid/refund',autoApproveEnabled:true};
let outputs=[];
let processing=0;
let preflightFailure=null;
let failAt='login';
let validIdentity=true;
let afterReservationFailure=false;
const confirmLiveSession=async()=>true;
const sandbox={
 activeReturnRefundCommand:command,shopId:'test-shop',requestedOrderNumber:'order-current',
 context:{},pddPage:{},listUrl:'https://example.invalid/list',process:{env:{}},rateLimitWaitMs:180000,
 assertActiveResidentCommandIdentity(){if(!validIdentity)throw new Error('RESIDENT_COMMAND_IDENTITY_MISMATCH');},
 focusSystemPage:async()=>{if(failAt==='focus'&&preflightFailure)throw preflightFailure;},
 ensurePddLogin:async()=>{if(failAt==='login'&&preflightFailure)throw preflightFailure;},
 pddBusinessPageMatchesExpectedMall:confirmLiveSession,
 processReturnRefund:async(_page,_context,options)=>{
  assert.equal(options.confirmLivePddSession,confirmLiveSession);
  processing++;
  if(afterReservationFailure){await options.reserveEffect({effectType:'pdd-return-refund'});throw new Error('submit response unavailable');}
  return {outcome:'waiting-logistics'};
 },
 sendExternalEffectRequest:async()=>({effectId:'effect-current',alreadySucceeded:false}),
 classifyReturnRefundUnexpectedFailure,returnRefundVisibleStep:async()=>{},checkForHumanVerification:async()=>{},
 writeReturnRefundOutput:output=>outputs.push(output),logRunStep(){},
};
vm.runInNewContext(source.slice(start,end)+'\nglobalThis.run=runReturnRefundClaimOnly;',sandbox);
for(const [where,error,expected] of [
 ['login',Object.assign(new Error('检测到人工验证'),{name:'HumanVerificationRequiredError'}),'verification-required'],
 ['login',Object.assign(new Error('检测到人工验证'),{code:'HUMAN_VERIFICATION_TIMEOUT',name:'HumanVerificationTimeoutError'}),'verification-required'],
 ['login',Object.assign(new Error('登录状态已失效'),{code:'PDD_LOGIN_REQUIRED'}),'verification-required'],
 ['login',Object.assign(new Error('平台限流'),{code:'PDD_RATE_LIMITED',retryAfterMs:180000}),'page-error'],
 ['focus',new Error('target page unavailable'),'page-error'],
]){
 outputs=[];processing=0;failAt=where;preflightFailure=error;
 await assert.doesNotReject(sandbox.run,'preflight interruption must publish a result instead of stranding the worker');
 assert.equal(processing,0,'refund actions must not start after a failed preflight');
 assert.equal(outputs.length,1);
 assert.equal(outputs[0].requestId,command.requestId);
 assert.equal(outputs[0].mode,'claim');
 assert.equal(outputs[0].result.outcome,expected);
 assert.equal(outputs[0].result.facts.orderNumber,'order-current');
 assert.equal(outputs[0].result.facts.aftersaleNumber,command.aftersaleNumber);
}
preflightFailure=null;outputs=[];processing=0;
await sandbox.run();
assert.equal(processing,1);assert.equal(outputs[0].result.outcome,'waiting-logistics');
outputs=[];afterReservationFailure=true;
await sandbox.run();
assert.match(outputs[0].result.reasons[0],/待只读复核/);
outputs=[];validIdentity=false;
await assert.rejects(sandbox.run,/RESIDENT_COMMAND_IDENTITY_MISMATCH/);
assert.equal(outputs.length,0,'a mismatched command must never receive another command result');
console.log('Return/refund preflight result regression passed (CAPTCHA, timeout, login, rate limit, focus, identity, uncertain effect)');
