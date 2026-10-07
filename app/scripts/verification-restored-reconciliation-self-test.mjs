import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

// This suite needs production constraints/triggers, but may run only in the
// random, disposable database created by return-refund-postgres-harness.mjs.
assert.match(new URL(process.env.DATABASE_URL).pathname, /^\/pdd_refund_test_[a-f0-9]{12}$/u);
const source = process.env.POSTGRES_ADAPTER_TEST_FILE
  ? pathToFileURL(process.env.POSTGRES_ADAPTER_TEST_FILE).href
  : new URL('../packages/adapters/src/postgres/index.mjs', import.meta.url).href;
const { PostgresWorkflowRepository } = await import(source);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const repository = new PostgresWorkflowRepository(pool);
const shopId = `verification-recovery-${crypto.randomUUID().slice(0, 8)}`;
const url = 'https://mms.pinduoduo.com/aftersales/work_order/list';
let sequence = 500015000000000;
const fixture = async ({ effectStatus, extraGate = false, activeClaim = false } = {}) => {
  const id = crypto.randomUUID();
  const instanceId = crypto.randomUUID();
  const verificationId = crypto.randomUUID();
  const caseId = String(++sequence);
  const retry = { attempts: 5, maxAttempts: 6, claimedAt: new Date(Date.now() - 1_800_000).toISOString() };
  await pool.query(`INSERT INTO work_orders
    (id,shop_id,external_order_number,work_order_type,scenario_code,status,runtime_status,
     current_step,recovery_state,recovery_updated_at,payload,idempotency_key)
    VALUES($1::uuid,$2,$3,'消费者申请退款后提示拦截','intercept-recall','paused','verification',
      'human-verification-required',CASE WHEN $5::boolean THEN 'reconciling' ELSE 'ready' END,
      now()-interval '30 minutes',$4::jsonb,'order-'||$1::text)`,
  [id, shopId, `test-${caseId}`, JSON.stringify({ externalStateReconciliationRetry: retry }),
    ['unknown','reserved'].includes(effectStatus)]);
  await pool.query(`INSERT INTO ordinary_work_order_instances
    (id,work_order_id,shop_id,platform_case_id,platform_case_key,detail_url,work_order_type,
     scenario_code,status,runtime_status,current_step,payload)
    VALUES($1,$2,$3,$4,'pdd-work-order:'||$4,$5,'消费者申请退款后提示拦截',
      'intercept-recall','paused','verification','human-verification-required',$6::jsonb)`,
  [instanceId,id,shopId,caseId,`https://mms.pinduoduo.com/aftersales/work_order/tododetail?id=${caseId}`,
    JSON.stringify({ externalStateReconciliationRetry: retry })]);
  await pool.query('UPDATE work_orders SET current_ordinary_instance_id=$2 WHERE id=$1', [id,instanceId]);
  const addGate = async gateId => pool.query(`INSERT INTO verification_locations
    (id,shop_id,work_order_id,ordinary_instance_id,system_name,stage,status,url,
     bounding_box,confidence,detected_at)
    VALUES($1,$2,$3,$4,'pdd','pdd-resident-cross-tab-observer','waiting-human',$5,'{}','high',
      now()-interval '5 minutes')`, [gateId,shopId,id,instanceId,url]);
  await addGate(verificationId);
  if (extraGate) await addGate(crypto.randomUUID());
  if (effectStatus) await pool.query(`INSERT INTO external_effects
    (id,shop_id,work_order_id,ordinary_instance_id,effect_type,idempotency_key,status,request_hash)
    VALUES($1,$2,$3,$4,'pdd-submit',$5,$6,'recovery-test')`,
  [crypto.randomUUID(),shopId,id,instanceId,`effect-${id}`,effectStatus]);
  if (activeClaim) await pool.query(`INSERT INTO shop_runtime_state
    (shop_id,worker_id,status,lease_token,lease_expires_at,current_work_order_id)
    VALUES($1,'test-worker','processing',$2,now()+interval '5 minutes',$3)
    ON CONFLICT(shop_id) DO UPDATE SET current_work_order_id=$3,lease_token=$2,
      lease_expires_at=now()+interval '5 minutes'`, [shopId,crypto.randomUUID(),id]);
  const effectsBefore = (await pool.query('SELECT * FROM external_effects WHERE work_order_id=$1',[id])).rows;
  const result = await repository.resolveRestoredPreClaimPddVerification({
    shopId, verificationId, workOrderId:id,
    recoveryStartedAt:new Date(Date.now()-60_000).toISOString(),
    authenticatedAt:new Date(Date.now()-5_000).toISOString(),
    verificationUrl:url, observedUrl:url,
  });
  const row = (await pool.query(`SELECT w.status,w.runtime_status,w.recovery_state,w.current_step,
    w.payload->'externalStateReconciliationRetry' AS retry,i.status AS instance_status,
    i.runtime_status AS instance_runtime_status,v.status AS verification_status
    FROM work_orders w JOIN ordinary_work_order_instances i ON i.id=w.current_ordinary_instance_id
    JOIN verification_locations v ON v.id=$2 WHERE w.id=$1`,[id,verificationId])).rows[0];
  assert.deepEqual((await pool.query('SELECT * FROM external_effects WHERE work_order_id=$1',[id])).rows,effectsBefore,
    'resolving CAPTCHA must not manufacture an external receipt');
  assert.deepEqual(row.retry,retry,'verification recovery must not reset the reconciliation budget');
  return { id,instanceId,verificationId,result,row };
};
try {
  await pool.query(`INSERT INTO shops(id,name,expected_shop_name,display_slot,enabled,onboarding_status)
    SELECT $1,$1,$1,slot,false,'disabled' FROM generate_series(0,99) slot
    WHERE NOT EXISTS(SELECT 1 FROM shops WHERE display_slot=slot) ORDER BY slot LIMIT 1`,[shopId]);
  const uncertain = await fixture({effectStatus:'unknown'});
  assert.equal(uncertain.result.requeued,false,'unknown submit must stay on read-only reconciliation, never normal retry');
  assert.equal(uncertain.result.verificationResolved,true);
  assert.equal(uncertain.row.status,'paused');
  assert.equal(uncertain.row.instance_status,'paused');
  assert.equal(uncertain.row.recovery_state,'reconciling');
  const released = await repository.recoverStaleExternalStateReconciliations({shopId});
  assert.deepEqual(released.map(item=>item.workOrderId),[uncertain.id],
    'the resolved order must remain discoverable by the existing read-only recovery queue');
  const claim = await repository.claimNextExternalStateReconciliation({shopId,maxAttempts:6});
  assert.equal(claim.id,uncertain.id);
  const attempts = (await pool.query(`SELECT payload #>> '{externalStateReconciliationRetry,attempts}' AS attempts
    FROM work_orders WHERE id=$1`,[uncertain.id])).rows[0].attempts;
  assert.equal(attempts,'6','only the actual read-only claim consumes the next attempt');
  await pool.query("UPDATE work_orders SET recovery_updated_at=now() WHERE id=$1",[uncertain.id]);

  const reserved = await fixture({effectStatus:'reserved'});
  assert.equal(reserved.result.requeued,false);
  assert.equal(reserved.row.status,'paused');
  assert.equal(reserved.row.instance_status,'paused');
  for (const effectStatus of [undefined,'succeeded','failed']) {
    const normal = await fixture({effectStatus});
    assert.equal(normal.result.requeued,true);
    assert.equal(normal.row.status,'retry-ready');
    assert.equal(normal.row.instance_status,'retry-ready');
  }
  const remaining = await fixture({extraGate:true});
  assert.equal(remaining.result.requeued,false);
  assert.equal(remaining.row.status,'paused');
  const leased = await fixture({effectStatus:'unknown',activeClaim:true});
  assert.equal(leased.result,null);
  assert.equal(leased.row.verification_status,'waiting-human');
  console.log('restored verification PostgreSQL regression passed (unknown/reserved effects, read-only claim, budgets, remaining gate, active lease)');
} finally { await pool.end(); }
