import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import {PostgresWorkflowRepository} from '../packages/adapters/src/postgres/index.mjs';
const client=new pg.Client({connectionString:process.env.DATABASE_URL,application_name:'refund-orphan-isolated-test'});
await client.connect();
try{
 await client.query('SET search_path TO pg_temp');
 await client.query(`CREATE TEMP TABLE work_orders(id uuid PRIMARY KEY,shop_id text,external_order_number text,scenario_code text,status text,runtime_status text,completion_state text,recovery_state text,frontend_visibility text,updated_at timestamptz,current_step text,next_attempt_at timestamptz,payload jsonb)`);
 await client.query(`CREATE TEMP TABLE return_refunds(work_order_id uuid,shop_id text,action_state text,next_check_at timestamptz,completed_at timestamptz,evidence jsonb)`);
 await client.query(`CREATE TEMP TABLE pdd_shop_runtime_bindings(shop_id text,binding_token uuid,mall_id text)`);
 await client.query(`CREATE TEMP TABLE shop_runtime_state(shop_id text,current_work_order_id uuid,lease_token uuid,lease_expires_at timestamptz)`);
 await client.query(`CREATE TEMP TABLE external_effects(work_order_id uuid,status text)`);
 await client.query(`CREATE TEMP TABLE verification_locations(work_order_id uuid,status text,resolved_at timestamptz)`);
 await client.query(`CREATE TEMP TABLE audit_events(shop_id text,work_order_id uuid,actor_id text,event_type text,payload jsonb)`);
 const token=crypto.randomUUID(),shopId='isolated-refund-shop';
 await client.query('INSERT INTO pdd_shop_runtime_bindings VALUES($1,$2,$3)',[shopId,token,'12345']);
 const repository=new PostgresWorkflowRepository({connect:async()=>({query:(...args)=>client.query(...args),release(){}})});
 const future=new Date(Date.now()+3600000),past=new Date(Date.now()-3600000);
 async function seed({age=1800000,state='waiting-logistics',recovery='ready',binding=token,mall='12345',effect=null,lease=false,verification=false,next=past,completion='pending'}={}){
  const id=crypto.randomUUID();
  await client.query(`INSERT INTO work_orders VALUES($1,$2,'260923-123456789012345','return-refund','processing','processing',$3,$4,'operational',$5,'return-refund-claim-complete',NULL,'{}')`,[id,shopId,completion,recovery,new Date(Date.now()-age)]);
  await client.query(`INSERT INTO return_refunds VALUES($1,$2,$3,$4,NULL,$5)`,[id,shopId,state,next,JSON.stringify({pddIdentityBindingToken:binding,pddMallId:mall})]);
  if(effect)await client.query('INSERT INTO external_effects VALUES($1,$2)',[id,effect]);
  if(lease)await client.query(`INSERT INTO shop_runtime_state VALUES($1,$2,$3,now()+interval '10 minutes')`,[shopId,id,crypto.randomUUID()]);
  if(verification)await client.query(`INSERT INTO verification_locations VALUES($1,'waiting-human',NULL)`,[id]);
  return id;
 }
 const eligible=[await seed(),await seed({state:'ready'}),await seed({state:'page-error'}),await seed({next:future})];
 const blocked=[await seed({age:0}),await seed({recovery:'held'}),await seed({binding:crypto.randomUUID()}),await seed({mall:'another'}),await seed({effect:'unknown'}),await seed({effect:'reserved'}),await seed({lease:true}),await seed({verification:true}),await seed({state:'manual-review'}),await seed({state:'auto-refunded'}),await seed({completion:'confirmed'})];
 assert.deepEqual(await repository.recoverOrphanedReturnRefundClaims({shopId}),[],'missing identity must not recover anything');
 const recovered=await repository.recoverOrphanedReturnRefundClaims({shopId,identityBindingToken:token});
 assert.deepEqual(recovered.map(r=>r.workOrderId).sort(),eligible.sort());
 const rows=(await client.query('SELECT id,status,next_attempt_at FROM work_orders')).rows;
 for(const id of blocked)assert.equal(rows.find(r=>r.id===id).status,'processing','active/protected claims must not change');
 assert(rows.some(r=>r.status==='retry-ready'&&r.next_attempt_at.getTime()===future.getTime()),'future logistics wait must not be shortened');
 assert.equal((await client.query('SELECT count(*)::int AS n FROM external_effects')).rows[0].n,2);
 assert.equal((await client.query('SELECT count(*)::int AS n FROM audit_events')).rows[0].n,4);
 assert.deepEqual(await repository.recoverOrphanedReturnRefundClaims({shopId,identityBindingToken:token}),[],'repeat recovery must be idempotent');
 console.log('Return-refund orphan recovery self-test passed (isolated temporary tables)');
}finally{await client.end();}
