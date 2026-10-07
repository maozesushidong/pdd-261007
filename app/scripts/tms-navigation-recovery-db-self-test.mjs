import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createPostgresPool,PostgresWorkflowRepository} from '../packages/adapters/src/postgres/index.mjs';

// All fixtures and recovery writes stay in one uncommitted transaction, so
// running supervisors cannot observe or execute any fixture shop or order.
const pool=await createPostgresPool(),client=await pool.connect();
const shopId=`scheduler-test-tms-navigation-${crypto.randomUUID()}`;
const transactionClient={release(){},async query(sql,params){
  if(sql==='BEGIN')return client.query('SAVEPOINT tested_recovery');
  if(sql==='COMMIT')return client.query('RELEASE SAVEPOINT tested_recovery');
  if(sql==='ROLLBACK')return client.query('ROLLBACK TO SAVEPOINT tested_recovery');
  return client.query(sql,params);
}};
const repository=new PostgresWorkflowRepository({connect:async()=>transactionClient});
const filterReason="locator.waitFor: Timeout 10000ms exceeded.\nCall log:\n waiting for locator('.filter-panel:visible').first() to be visible";
const newReason='TMS 客服登记页两轮等待后仍未找到新建按钮或窗口: url=http://tms.aipro123.top/logistics; loginRendered=false';
let index=0;
async function fixture({reason=newReason,effect=null,held=false,attempts=0,verified=true,active=false,ticket=false,legacy=false}={}){
 const id=crypto.randomUUID(),instance=crypto.randomUUID(),n=++index,caseId=`50001987654${String(n).padStart(4,'0')}`;
 const payload={safeTransientPauseRecovery:{attempts}};
 await client.query(`INSERT INTO work_orders(id,shop_id,external_order_number,work_order_type,scenario_code,status,runtime_status,idempotency_key,current_step,manual_review_reason,payload,recovery_state)
 VALUES($1,$2,$3,'fixture','intercept-recall','paused','paused',$3,'flow-paused',$4,$5::jsonb,$6)`,[id,shopId,`fixture-${n}`,reason,JSON.stringify(payload),held?'held':'ready']);
 await client.query(`INSERT INTO ordinary_work_order_instances(id,work_order_id,shop_id,platform_case_id,platform_case_key,work_order_type,scenario_code,identity_status,status,runtime_status,current_step,manual_review_reason,payload)
 VALUES($1,$2,$3,$4,$5,'fixture','intercept-recall',$6,'paused','paused','flow-paused',$7,$8::jsonb)`,[instance,id,shopId,verified?caseId:null,verified?`pdd-work-order:${caseId}`:null,verified?'verified':'legacy-unverified',reason,JSON.stringify(payload)]);
 await client.query('UPDATE work_orders SET current_ordinary_instance_id=$2 WHERE id=$1',[id,instance]);
 if(effect)await client.query(`INSERT INTO external_effects(id,shop_id,work_order_id,ordinary_instance_id,effect_type,idempotency_key,status,request_hash)
 VALUES($1,$2,$3,$4,'tms-create',$5,$6,'fixture')`,[crypto.randomUUID(),shopId,id,legacy?null:instance,`fixture-effect-${n}`,effect]);
 if(ticket)await client.query(`INSERT INTO tms_work_orders(id,work_order_id,ordinary_instance_id,scenario_code,status,request_hash)
 VALUES($1,$2,$3,'intercept-recall','created','fixture')`,[crypto.randomUUID(),id,legacy?null:instance]);
 if(active)await client.query(`INSERT INTO shop_runtime_state(shop_id,status,lease_token,lease_expires_at,current_work_order_id)
 VALUES($1,'processing',$2,now()+interval '5 minutes',$3)`,[shopId,crypto.randomUUID(),id]);
 return id;
}
try{
 await client.query('BEGIN');
 await client.query(`INSERT INTO shops(id,name,expected_shop_name,display_slot,enabled,onboarding_status)
 SELECT $1,$1,$1,slot,false,'disabled' FROM generate_series(0,999) slot
 WHERE NOT EXISTS (SELECT 1 FROM shops WHERE display_slot=slot)
 ORDER BY slot LIMIT 1`,[shopId]);
 const newId=await fixture(),filterId=await fixture({reason:filterReason});
 const protectedIds=[];
 for(const effect of ['reserved','unknown','succeeded','failed'])protectedIds.push(await fixture({effect}));
 for(const options of [{held:true},{attempts:2},{active:true},{ticket:true},{verified:false},
   {effect:'succeeded',legacy:true},{ticket:true,legacy:true},
   {reason:'流程需要人工复核：消费者未确认新地址'},
   {reason:'TMS 提交后结果未知'}])protectedIds.push(await fixture(options));
 assert.deepEqual(await repository.recoverSafeTransientOrdinaryPauses({shopId,authenticatedSystems:['pdd']}),[]);
 const recovered=await repository.recoverSafeTransientOrdinaryPauses({shopId,authenticatedSystems:['pdd','tms']});
 assert.deepEqual(new Set(recovered.map(x=>x.id)),new Set([newId,filterId]));
 assert(recovered.every(x=>x.strategy==='tms-registration-navigation-recovery'));
 assert.equal((await client.query(`SELECT count(*)::int n FROM work_orders WHERE id=ANY($1::uuid[]) AND status='paused'`,[protectedIds])).rows[0].n,protectedIds.length);
 assert.equal((await client.query(`SELECT count(*)::int n FROM ordinary_work_order_instances WHERE work_order_id=ANY($1::uuid[]) AND status='retry-ready'`,[[newId,filterId]])).rows[0].n,2);
 const copies=(await client.query(`SELECT w.payload AS order_payload,i.payload AS instance_payload
 FROM work_orders w JOIN ordinary_work_order_instances i ON i.id=w.current_ordinary_instance_id
 WHERE w.id=ANY($1::uuid[])`,[[newId,filterId]])).rows;
 for(const row of copies)assert.deepEqual(row.instance_payload,row.order_payload,'instance must receive the updated recovery payload');
 assert.deepEqual(await repository.recoverSafeTransientOrdinaryPauses({shopId,authenticatedSystems:['pdd','tms']}),[],'must not repeatedly enqueue recovered instances');
 console.log('TMS navigation recovery database regression passed: pre-submit only, auth gate, effects, holds, retry cap, leases and instance consistency.');
}finally{await client.query('ROLLBACK');client.release();await pool.end();}
