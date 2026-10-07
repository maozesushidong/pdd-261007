import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {PostgresWorkflowRepository} from '../packages/adapters/src/postgres/index.mjs';

// Execute the real repository SQL against a session-local table. The search
// path excludes public, so this test cannot read or mutate production commands.
const client=new pg.Client({connectionString:process.env.DATABASE_URL,application_name:'command-target-isolated-test'});
await client.connect();
try{
 await client.query('SET search_path TO pg_temp');
 await client.query(`CREATE TEMP TABLE operator_commands (
  id uuid PRIMARY KEY,shop_id text,work_order_id uuid,command_type text,
  status text DEFAULT 'pending',requested_at timestamptz,delivered_at timestamptz,result jsonb
 )`);
 assert.equal((await client.query(`SELECT c.relpersistence FROM pg_class c WHERE c.oid='operator_commands'::regclass`)).rows[0].relpersistence,'t');
 const repository=new PostgresWorkflowRepository({connect:async()=>({query:(...args)=>client.query(...args),release(){}})});
 const shopId='isolated-test-shop',workerId='isolated-worker';
 const active=crypto.randomUUID(),other=crypto.randomUUID();let tick=0;
 async function insert(orderId,type='resume-auto',shop=shopId){
  const id=crypto.randomUUID();
  await client.query('INSERT INTO operator_commands(id,shop_id,work_order_id,command_type,requested_at) VALUES($1,$2,$3,$4,$5)',[id,shop,orderId,type,new Date(1700000000000+tick++*1000)]);
  return id;
 }
 const foreignShop=await insert(active,'resume-auto','another-shop');
 const deferred=await insert(other);
 const eligible=await insert(active);
 const claim=options=>repository.claimPendingCommand({shopId,workerId,...options});
 assert.equal((await claim({activeWorkOrderId:active}))?.id,eligible,'a busy worker must leave another order command pending');
 assert.equal(await claim({activeWorkOrderId:active}),null,'no eligible command is not a failed command');
 assert.equal((await client.query('SELECT status FROM operator_commands WHERE id=$1',[deferred])).rows[0].status,'pending');
 const shopCommand=await insert(other,'focus-system-login');
 assert.equal((await claim({activeWorkOrderId:active}))?.id,shopCommand,'shop controls stay available even with a different order context');
 const wrongType=await insert(active,'manual-complete');
 const selectedType=await insert(active,'verification-recheck');
 assert.equal((await claim({activeWorkOrderId:active,commandTypes:['verification-recheck']}))?.id,selectedType,'command type filtering must remain effective');
 assert.equal((await claim({}))?.id,deferred,'the idle worker must claim deferred commands');
 assert.equal((await claim({activeWorkOrderId:active}))?.id,wrongType);
 assert.equal((await client.query('SELECT status FROM operator_commands WHERE id=$1',[foreignShop])).rows[0].status,'pending','cross-shop commands remain untouched');
 const runner=readFileSync(new URL('../apps/worker/src/postgres-playwright-runner.mjs',import.meta.url),'utf8');
 assert.match(runner,/const command = await repository\.claimPendingCommand\(\{\s*shopId,\s*workerId,\s*activeWorkOrderId: claim\.id,/);
 assert.match(runner,/!shopCommand && String\(command\.work_order_id \|\| ''\) !== String\(claim\.id \|\| ''\)/,'execution identity guard must remain');
 console.log('Worker command target routing self-test passed (isolated temporary table)');
}finally{await client.end();}
