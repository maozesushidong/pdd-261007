import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
assert.match(new URL(process.env.DATABASE_URL).pathname,/^\/pdd_refund_test_[a-f0-9]{12}$/u);
const {PostgresWorkflowRepository}=await import(process.env.POSTGRES_ADAPTER_TEST_FILE
 ?pathToFileURL(process.env.POSTGRES_ADAPTER_TEST_FILE).href
 :new URL('../packages/adapters/src/postgres/index.mjs',import.meta.url).href);
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});
const repository=new PostgresWorkflowRepository(pool);
const shopId=`verification-once-${crypto.randomUUID().slice(0,8)}`;
const addGate=async(id,{status='resolved',old=false}={})=>{
 const gate=crypto.randomUUID();
 await pool.query(`INSERT INTO verification_locations
  (id,shop_id,work_order_id,system_name,stage,status,url,bounding_box,confidence,detected_at,resolved_at)
  VALUES($1,$2,$3,'pdd','return-refund-detail-ready-before',$4,'https://mms.pinduoduo.com/aftersales-ssr/detail',
   '{}','high',now()-interval '2 minutes',CASE WHEN $4='resolved' THEN now()-CASE WHEN $5 THEN interval '1 minute' ELSE interval '0 seconds' END ELSE NULL END)`,
 [gate,shopId,id,status,old]);
 return gate;
};
const fixture=async({old=false}={})=>{
 const id=crypto.randomUUID();
 await pool.query(`INSERT INTO work_orders
  (id,shop_id,external_order_number,work_order_type,scenario_code,status,runtime_status,current_step,next_attempt_at,payload,idempotency_key)
  VALUES($1::uuid,$2,($1::uuid)::text,'退货退款','return-refund','retry-ready','waiting','return-refund-verification-required',
   now()+interval '10 minutes','{}','verification-once:'||($1::uuid)::text)`,[id,shopId]);
 await pool.query(`INSERT INTO return_refunds
  (work_order_id,shop_id,external_order_number,aftersale_number,decision,action_state,next_check_at,last_scanned_at)
  VALUES($1::uuid,$2,($1::uuid)::text,($1::uuid)::text,'verification-required','verification-required',now()+interval '10 minutes',
   now()-CASE WHEN $3 THEN interval '0 seconds' ELSE interval '1 minute' END)`,[id,shopId,old]);
 return {id,gate:await addGate(id,{old})};
};
const failedAgain=async(id)=>{
 await pool.query(`UPDATE work_orders SET current_step='return-refund-verification-required',
  status='retry-ready',runtime_status='waiting',next_attempt_at=now()+interval '10 minutes' WHERE id=$1`,[id]);
 await pool.query(`UPDATE return_refunds SET last_scanned_at=now(),next_check_at=now()+interval '10 minutes' WHERE work_order_id=$1`,[id]);
};
const assertDeferred=async(id)=>{
 const row=(await pool.query(`SELECT w.next_attempt_at>now()+interval '9 minutes' AS work_deferred,
  r.next_check_at>now()+interval '9 minutes' AS refund_deferred FROM work_orders w
  JOIN return_refunds r ON r.work_order_id=w.id WHERE w.id=$1`,[id])).rows[0];
 assert.deepEqual(row,{work_deferred:true,refund_deferred:true},'preserve the retry delay after a fresh failed check');
};
try{
 await pool.query(`INSERT INTO shops(id,name,expected_shop_name,display_slot,enabled,onboarding_status)
  SELECT $1,$1,$1,slot,false,'disabled' FROM generate_series(0,99) slot
  WHERE NOT EXISTS(SELECT 1 FROM shops WHERE display_slot=slot) ORDER BY slot LIMIT 1`,[shopId]);
 const first=await fixture();
 assert.deepEqual((await repository.requeueResolvedVerificationWorkOrders({shopId})).map(r=>r.workOrderId),[first.id]);
 await failedAgain(first.id);
 assert.equal((await repository.requeueResolvedVerificationWorkOrders({shopId})).length,0,
  'the same old clear event must not repeatedly undo the ten-minute verification retry delay');
  await assertDeferred(first.id);
 await pool.query("UPDATE return_refunds SET last_scanned_at=now()-interval '5 minutes' WHERE work_order_id=$1",[first.id]);
 assert.equal((await repository.requeueResolvedVerificationWorkOrders({shopId})).length,0,
  'an already-consumed clear is not reusable even when the saved scan time is older');
 await assertDeferred(first.id);
 const old=await fixture({old:true});
 assert.equal((await repository.requeueResolvedVerificationWorkOrders({shopId})).length,0,
  'even an unconsumed clear event is stale if the refund was checked and blocked afterwards');
 await assertDeferred(old.id);
 await pool.query("UPDATE return_refunds SET last_scanned_at=now()-interval '1 second' WHERE work_order_id=$1",[first.id]);
 const freshGate=await addGate(first.id);
 const fresh=await repository.requeueResolvedVerificationWorkOrders({shopId});
 assert.deepEqual(fresh.map(r=>r.verificationId),[freshGate],'a genuinely newer solved challenge may resume immediately');
 const blocked=await fixture();
 await addGate(blocked.id,{status:'waiting-human'});
 assert.equal((await repository.requeueResolvedVerificationWorkOrders({shopId})).length,0,'another active gate keeps the work deferred');
 const uncertain=await fixture();
 await pool.query(`INSERT INTO external_effects(id,shop_id,work_order_id,effect_type,idempotency_key,status,request_hash)
  VALUES($1,$2,$3::uuid,'pdd-return-refund',($3::uuid)::text,'unknown','test')`,[crypto.randomUUID(),shopId,uncertain.id]);
 assert.equal((await repository.requeueResolvedVerificationWorkOrders({shopId})).length,0,'unknown effects remain on read-only recovery');
 const leased=await fixture();
 await pool.query(`INSERT INTO shop_runtime_state(shop_id,worker_id,status,lease_token,lease_expires_at,current_work_order_id)
  VALUES($1,'test','processing',$2,now()+interval '5 minutes',$3)`,[shopId,crypto.randomUUID(),leased.id]);
 assert.equal((await repository.requeueResolvedVerificationWorkOrders({shopId})).length,0,'active claim cannot be interrupted');
 const sameAttempt=await fixture();
 await pool.query("UPDATE verification_locations SET resolved_at=now()-interval '1 second' WHERE id=$1",[sameAttempt.gate]);
 await pool.query('UPDATE return_refunds SET last_scanned_at=now() WHERE work_order_id=$1',[sameAttempt.id]);
 const untargeted=await fixture();
 assert.deepEqual((await repository.requeueResolvedVerificationWorkOrders({
  shopId,workOrderId:sameAttempt.id,
 })).map(row=>row.workOrderId),[sameAttempt.id],
 'the same claim may save its scan time immediately after verification clears');
 const otherState=(await pool.query('SELECT current_step FROM work_orders WHERE id=$1',[untargeted.id])).rows[0];
 assert.equal(otherState.current_step,'return-refund-verification-required',
 'an exact-order recovery must not requeue other orders in the shop');
 console.log('verification requeue PostgreSQL regression passed (one clear event once, stale clear, fresh clear, active gate, unknown effect, lease)');
}finally{await pool.end();}
