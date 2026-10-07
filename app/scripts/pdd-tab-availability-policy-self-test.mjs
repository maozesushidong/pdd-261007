import assert from 'node:assert/strict';
import {
  isPddTabUnavailableFailure,
  pddTabUnavailableRetryAt,
} from '../apps/worker/src/pdd-tab-availability-policy.mjs';

assert.equal(isPddTabUnavailableFailure(new Error('pdd 标签页不可用')), true);
assert.equal(isPddTabUnavailableFailure({
  outcome: 'page-error',
  reasons: ['退款页面加载或读取失败，未执行退款，将自动重试：pdd 标签页不可用'],
}), true);
assert.equal(isPddTabUnavailableFailure({ reasons: ['物流信息尚未更新'] }), false);
assert.equal(pddTabUnavailableRetryAt(100_000, 0), 160_000);
assert.equal(pddTabUnavailableRetryAt(100_000, 180_000), 180_000,
  'a later existing cooldown must not be shortened');
console.log('PDD tab availability cooldown policy self-test passed');
