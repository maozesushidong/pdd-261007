import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {completionInfoFromPayload} from '../apps/api/src/data-backend.mjs';

const source=readFileSync(new URL('../packages/adapters/src/postgres/index.mjs',import.meta.url),'utf8');
const start=source.indexOf('const completionConfirmationMethods = new Set(');
const end=source.indexOf('const selectClaimedWorkOrder =',start);
assert(start>=0&&end>start);
const completionTruth=vm.runInNewContext(`${source.slice(start,end)}\ncompletionTruth;`);
const method='address-change-completed-with-both-service-records';
const completedAt='2026-09-23T10:03:49.807Z';
for(const field of ['pddResolutionSubmission','completionArchive','lastCompletedOrder']){
  const payload={[field]:{status:'succeeded',orderNumber:'260923-123456789012345',confirmationMethod:method,completedAt}};
  for(const get of [p=>completionTruth(p,'archived'),p=>completionInfoFromPayload(p,{runtimeStatus:'archived'})]){
    assert.equal(get(payload).state,'confirmed',`${field} must retain the verified scenario completion`);
    assert.equal(get(payload).confirmedAt,completedAt);
    assert.equal(get({[field]:{...payload[field],confirmationMethod:'unknown-method'}}).state,'reconciliation-required');
    assert.equal(get({[field]:{confirmationMethod:method}}).state,'reconciliation-required');
  }
}
console.log('Address-change completion database/API projection self-test passed');
