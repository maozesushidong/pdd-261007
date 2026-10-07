import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawn} from 'node:child_process';

const source=readFileSync(new URL('../apps/worker/src/postgres-playwright-runner.mjs',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const start=source.lastIndexOf('if (sessionTimer) clearTimeout(sessionTimer);');
assert(start>=0);
const stopStart=source.indexOf('async function stopActiveChildGracefully(');
const stopEnd=source.indexOf('\n}\n',stopStart)+2;
assert(stopStart>=0&&stopEnd>stopStart);
const script=`
  import {EventEmitter} from 'node:events';
  process.on('message',()=>{});
  const sessionTimer=null,completedCount=0,maxOrders=0;
  const browserHealthMonitor={detach:()=>{}};
  const activeChild=new EventEmitter();
  Object.assign(activeChild,{exitCode:null,signalCode:null,connected:true,
    send:()=>setTimeout(()=>{activeChild.exitCode=0;activeChild.emit('exit',0);},5),
    kill:()=>{throw Error('clean child must not be force-killed');}});
  ${source.slice(stopStart,stopEnd)}
  const heartbeat=async state=>process.send({state});
  const finalizeStop=async()=>{await stopActiveChildGracefully(90000);process.send({state:'cleanup-finished'});};
  ${source.slice(start)}
`;
const child=spawn(process.execPath,['--input-type=module','-e',script],{
  stdio:['ignore','ignore','pipe','ipc'],windowsHide:true,
});
const messages=[];
let errors='';
child.stderr.on('data',chunk=>{errors+=chunk;});
child.on('message',message=>messages.push(message.state));
let timer;
try{
 const result=await Promise.race([
  new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal}))),
  new Promise(resolve=>{timer=setTimeout(()=>resolve({timeout:true}),2000);}),
 ]);
 assert.deepEqual(messages,['worker-finished','cleanup-finished'],'cleanup must finish before disconnecting');
 assert.equal(result.timeout,undefined,'an idle IPC channel must not keep the cleaned-up runner alive');
 assert.equal(result.code,0,errors);
 console.log('Worker graceful IPC exit self-test passed');
}finally{
 clearTimeout(timer);
 if(child.exitCode===null&&child.signalCode===null)child.kill();
}
