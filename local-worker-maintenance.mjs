import {createRequire} from 'node:module';
const require=createRequire(new URL('./app/package.json',import.meta.url));const {Client}=require('pg');
const mode=process.argv[2];if(!['pause','resume'].includes(mode))throw Error('Expected pause or resume');
const url=new URL(process.env.DATABASE_URL);if(url.hostname!=='127.0.0.1'||url.port!=='5433')throw Error('Local database required');
const c=new Client({connectionString:process.env.DATABASE_URL,application_name:'local-worker-maintenance'});await c.connect();
try{
 await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
 let r;
 if(mode==='pause'){
  r=await c.query(`UPDATE shop_runtime_state r SET metadata=coalesce(r.metadata,'{}'::jsonb)||jsonb_build_object('operatorPaused',true,'maintenanceDrain',jsonb_build_object('active',true,'source','local-worker-stop','previousOperatorPaused',r.status='operator-paused' OR coalesce((r.metadata->>'operatorPaused')::boolean,false),'requestedAt',now())),updated_at=now() FROM shops s WHERE s.id=r.shop_id AND s.enabled=true AND NOT coalesce((r.metadata->'maintenanceDrain'->>'active')::boolean,false)`);
 }else{
  r=await c.query(`UPDATE shop_runtime_state SET status=CASE WHEN status='operator-paused' AND NOT coalesce((metadata->'maintenanceDrain'->>'previousOperatorPaused')::boolean,false) THEN 'idle' ELSE status END,metadata=(metadata-'maintenanceDrain')||jsonb_build_object('operatorPaused',coalesce((metadata->'maintenanceDrain'->>'previousOperatorPaused')::boolean,false)),updated_at=now() WHERE metadata->'maintenanceDrain'->>'source'='local-worker-stop' AND coalesce((metadata->'maintenanceDrain'->>'active')::boolean,false)`);
 }
 await c.query('COMMIT');console.log(JSON.stringify({mode,changed:r.rowCount}));
}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{await c.end();}
