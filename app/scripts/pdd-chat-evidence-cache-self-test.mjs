import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
const source=fs.readFileSync(process.env.WORKFLOW_SOURCE_FILE||new URL('../workflow.mjs',import.meta.url),'utf8').replace(/\r\n/gu,'\n');
const a=source.indexOf('const ensureOrdinaryScenarioEvidence = async');
const b=source.indexOf('\nconst uploadOrdinaryScenarioEvidence =',a);assert(a>=0&&b>a);
const identity={caseId:'case-1',jobId:'job-1',snapshotId:'snapshot-1'};
const decision={evidence:{chatAnalysis:identity}};
const base={status:'ready',shopId:'shop',orderNumber:'260911-099677704563048',relativePath:'tmp/chat.png',chatCaseId:'case-1',chatJobId:'job-1',chatSnapshotId:'snapshot-1'};
let captures=0,progress={chatEvidenceScreenshot:{...base,chatJobId:'older-job'}},exists=true;
const sandbox={path,shopId:'shop',workflowDataDir:'C:/test-shop',evidenceScreenshotDir:'C:/test-shop/tmp',
 ordinaryEvidenceSource:()=> 'pdd-chat-evidence',readProgress:()=>progress,isPathInside:()=>true,exists:()=>exists,
 capturePddChatEvidenceScreenshot:async()=>{captures++;return{...base,status:'ready',fresh:true};},
};
vm.runInNewContext(source.slice(a,b)+'\nglobalThis.run=ensureOrdinaryScenarioEvidence;',sandbox);
const run=()=>sandbox.run({},base.orderNumber,'product-shortage',decision);
assert.equal((await run()).metadata.fresh,true,'CHAT_EVIDENCE_MUST_NOT_REUSE_PREVIOUS_ANALYSIS');
for(const patch of [{chatCaseId:'other-case'},{chatSnapshotId:'new-snapshot'},{shopId:'other-shop'},{chatJobId:undefined},{status:'failed'}]){
 progress={chatEvidenceScreenshot:{...base,...patch}};
 const before=captures;assert.equal((await run()).metadata.fresh,true);assert.equal(captures,before+1);
}
progress={chatEvidenceScreenshot:{...base}};
const before=captures;assert.equal((await run()).metadata.fresh,undefined);assert.equal(captures,before,'same immutable analysis can reuse valid file');
exists=false;assert.equal((await run()).metadata.fresh,true);
console.log('PDD chat evidence cache regression passed (shop, case, analysis job, snapshot, legacy metadata, failed status, missing file)');
