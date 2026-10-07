import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {createRequire} from 'node:module';
const root=path.resolve(process.argv[2]);const port=Number(process.argv[3]||5433);const storagePort=Number(process.argv[4]||9000);
const require=createRequire(path.join(root,'app/package.json'));const {Client}=require('pg');
const work=path.join(root,'.restore-work');const pg=path.join(root,'runtime/postgres/bin');const pgData=path.join(root,'data/postgres-local');
const json=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const ident=x=>'"'+x.replaceAll('"','""')+'"';const literal=x=>"'"+x.replaceAll("'","''")+"'";
const env={...process.env,PGHOST:'127.0.0.1',PGPORT:String(port),PGUSER:'postgres',PGPASSWORD:'',PGDATABASE:'postgres',PGCLIENTENCODING:'UTF8'};
async function free(p){await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',()=>reject(new Error('Port is already in use: '+p)));s.listen(p,'127.0.0.1',()=>s.close(resolve));});}
async function run(exe,args,label,customEnv=env){
 const log=fs.openSync(path.join(work,label+'.log'),'a');const proc=spawn(exe,args,{env:customEnv,windowsHide:true,stdio:['ignore',log,log]});fs.closeSync(log);
 await new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('close',code=>code===0?resolve():reject(new Error(`${label} failed (${code}); inspect .restore-work/${label}.log`)))});
}
await free(port);await free(storagePort);
if(fs.existsSync(path.join(pgData,'PG_VERSION')))throw new Error('Refusing to overwrite an existing database');
fs.mkdirSync(pgData,{recursive:true});fs.mkdirSync(path.join(root,'logs-local'),{recursive:true});
await run(path.join(pg,'initdb.exe'),['-D',pgData,'-U','postgres','--encoding=UTF8','--locale=C','--auth=trust'],'initdb');
let started=false,minio=null;
try{
 await run(path.join(pg,'pg_ctl.exe'),['-D',pgData,'-l',path.join(work,'postgres-server.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start'],'postgres-start');started=true;
 const roles=fs.readFileSync(path.join(root,'snapshot/roles.sql'),'utf8').replace(/^CREATE ROLE postgres;\r?$/gm,'');fs.writeFileSync(path.join(work,'roles-restore.sql'),roles);
 const psql=path.join(pg,'psql.exe');await run(psql,['-X','-v','ON_ERROR_STOP=1','-f',path.join(work,'roles-restore.sql')],'roles');
 const conf=json(path.join(root,'snapshot/database-settings.json'));const c=new Client({host:'127.0.0.1',port,user:'postgres',database:'postgres'});await c.connect();
 await c.query(`CREATE DATABASE ${ident(conf.datname)} OWNER workorders TEMPLATE template0 ENCODING ${literal(conf.encoding)} LC_COLLATE ${literal(conf.datcollate)} LC_CTYPE ${literal(conf.datctype)}`);await c.end();env.PGDATABASE=conf.datname;
 const sqlLog=fs.openSync(path.join(work,'database-restore.log'),'w');const processSql=spawn(psql,['-X','-q','-v','ON_ERROR_STOP=1'],{env,windowsHide:true,stdio:['pipe',sqlLog,sqlLog]});fs.closeSync(sqlLog);
 const exited=new Promise((res,rej)=>{processSql.once('error',rej);processSql.once('close',code=>code===0?res():rej(new Error('SQL restore failed; inspect .restore-work/database-restore.log')))});exited.catch(()=>{});
 await pipeline(fs.createReadStream(path.join(work,'database.sql.gz')),createGunzip(),processSql.stdin);await exited;
 await run(psql,['-X','-v','ON_ERROR_STOP=1','-f',path.join(root,'snapshot/ownership-and-grants.sql')],'ownership-and-grants');
 const db=new Client({host:'127.0.0.1',port,user:'postgres',database:conf.datname});await db.connect();
 const counts=json(path.join(root,'snapshot/database-counts.json'));let verified=0;
 for(const [table,expected] of Object.entries(counts)){
  const actual=Number((await db.query('SELECT count(*) n FROM '+table.split('.').map(ident).join('.'))).rows[0].n);
  if(actual!==expected.rows)throw new Error(`Row count mismatch for ${table}: ${actual} != ${expected.rows}`);verified++;
 }
 await db.end();console.log(JSON.stringify({databaseRestored:true,tablesVerified:verified}));
 const objectIndex=json(path.join(work,'objects/index.json'));
 const secret=n=>process.env[n+'_FILE']?fs.readFileSync(process.env[n+'_FILE'],'utf8').trim():process.env[n];
 if(objectIndex.buckets.length){
  const minioData=path.join(root,'data/minio');fs.mkdirSync(minioData,{recursive:true});const log=fs.openSync(path.join(work,'minio.log'),'w');
  minio=spawn(path.join(root,'runtime/minio/minio.exe'),['server',minioData,'--address',`127.0.0.1:${storagePort}`,'--console-address','127.0.0.1:0'],{windowsHide:true,env:{...process.env,MINIO_ROOT_USER:secret('S3_ACCESS_KEY'),MINIO_ROOT_PASSWORD:secret('S3_SECRET_KEY')},stdio:['ignore',log,log]});fs.closeSync(log);
  let ready=false;for(let i=0;i<120;i++){try{const r=await fetch(`http://127.0.0.1:${storagePort}/minio/health/live`);if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}if(!ready)throw new Error('Temporary MinIO restore service failed');
  const {S3Client,CreateBucketCommand,PutObjectCommand}=require('@aws-sdk/client-s3');const s3=new S3Client({endpoint:`http://127.0.0.1:${storagePort}`,region:process.env.S3_REGION||'us-east-1',forcePathStyle:true,credentials:{accessKeyId:secret('S3_ACCESS_KEY'),secretAccessKey:secret('S3_SECRET_KEY')}});
  for(const b of objectIndex.buckets)await s3.send(new CreateBucketCommand({Bucket:b}));
  for(const o of objectIndex.kept)await s3.send(new PutObjectCommand({Bucket:o.bucket,Key:o.key,ContentType:o.contentType,ContentLength:o.size,Body:fs.createReadStream(path.join(work,'objects',o.file))}));s3.destroy();
 }
 fs.writeFileSync(path.join(root,'RESTORE-REPORT.json'),JSON.stringify({completedAt:new Date().toISOString(),tablesVerified:verified,objectsRestored:objectIndex.kept.length,port,storagePort},null,2));
}finally{
 if(minio){minio.kill();await new Promise(r=>{if(minio.exitCode!==null)r();else minio.once('close',r)});}
 if(started)await run(path.join(pg,'pg_ctl.exe'),['-D',pgData,'-m','fast','-w','stop'],'postgres-stop');
}
for(const name of fs.readdirSync(path.join(root,'snapshot/postgres-config'))){fs.copyFileSync(path.join(root,'snapshot/postgres-config',name),path.join(pgData,name));}
fs.appendFileSync(path.join(pgData,'postgresql.conf'),`\n# Snapshot restore: local application endpoint\nport = ${port}\nlisten_addresses = '127.0.0.1'\n`);
