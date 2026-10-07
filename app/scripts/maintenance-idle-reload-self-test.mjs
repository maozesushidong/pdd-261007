import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./safe-single-shop-reload.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const maintenanceIdle =');
const end = source.indexOf('const observedExpiredLogin =', start);
assert(start >= 0 && end > start);
const check = (overrides = {}) => vm.runInNewContext(`${source.slice(start, end)}\nmaintenanceIdle;`, {
  allowMaintenanceDrain: true,
  schedulerMode: 'legacy',
  metadata: { state: 'operator-paused' },
  runtime: { status: 'idle', lease_token: null, current_work_order_id: null,
    metadata: { operatorPaused: true, maintenanceDrain: { active: true, previousOperatorPaused: false } } },
  ...overrides,
});
assert.equal(check(), true, 'after finishing a claim, an unleased idle runtime with its maintenance pause must be eligible');
const runtime = (overrides = {}) => ({ status: 'operator-paused', lease_token: null, current_work_order_id: null,
  metadata: { operatorPaused: true, maintenanceDrain: { active: true, previousOperatorPaused: false } }, ...overrides });
assert.equal(check({ runtime: runtime() }), true);
for (const blocked of [
  { runtime: runtime({ status: 'processing' }) },
  { runtime: runtime({ lease_token: 'active-lease' }) },
  { runtime: runtime({ current_work_order_id: 'active-order' }) },
  { runtime: runtime({ metadata: { operatorPaused: true, maintenanceDrain: { active: true, previousOperatorPaused: true } } }) },
  { runtime: runtime({ metadata: { operatorPaused: false, maintenanceDrain: { active: true, previousOperatorPaused: false } } }) },
  { runtime: runtime({ metadata: { operatorPaused: true, maintenanceDrain: { active: false, previousOperatorPaused: false } } }) },
  { metadata: { state: 'processing' } },
  { metadata: { state: 'human-verification-required' } },
  { schedulerMode: 'queue' },
  { allowMaintenanceDrain: false },
  { runtime: null },
]) assert.equal(check(blocked), false, 'the explicit maintenance boundary must not include active, verification or user-paused state');
console.log('Maintenance idle reload regression passed: 13 guard cases');
