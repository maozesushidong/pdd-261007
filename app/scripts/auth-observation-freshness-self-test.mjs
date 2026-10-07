import assert from 'node:assert/strict';
import { authObservationEvidence } from './auth-observation-freshness.mjs';
const now=Date.parse('2026-09-30T08:20:00Z');
const classify=shop=>authObservationEvidence(shop,'pdd',{now});
assert.equal(classify({workerOnline:true,heartbeatAgeSeconds:1,runtimeObservationAgeSeconds:2600,
  authHealth:{pdd:{status:'expired',checkedAt:'2026-09-30T07:36:43Z'}}}).evidenceState,'stale');
assert.equal(classify({runtimeObservationAgeSeconds:5,authHealth:{pdd:{checkedAt:'2026-09-30T07:36:43Z'}}}).evidenceState,'current');
assert.equal(classify({runtimeObservationAgeSeconds:2600,authHealth:{pdd:{checkedAt:'2026-09-30T08:19:50Z'}}}).evidenceState,'current');
assert.equal(classify({runtimeObservationAgeSeconds:null}).evidenceState,'stale');
assert.equal(classify({runtimeObservationAgeSeconds:-1,authHealth:{pdd:{checkedAt:'2026-09-30T08:20:10Z'}}}).evidenceState,'stale');
assert.equal(classify({runtimeObservationAgeSeconds:'invalid'}).evidenceState,'stale');
console.log('authentication observation freshness self-test passed (6 scenarios)');
