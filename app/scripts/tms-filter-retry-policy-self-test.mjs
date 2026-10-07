import assert from 'node:assert/strict';

import { isRetryableCreatedTmsFilterFailure } from '../apps/worker/src/tms-filter-retry-policy.mjs';

const reason = 'TMS 物流问题登记表（客服）筛选面板在有界恢复后仍未渲染';
const progress = {
  orderNumber: '260924-165150790022430',
  tmsWorkOrder: {
    status: 'created',
    orderNumber: '260924-165150790022430',
    ticketId: '61996',
    ticketNo: 'L00061898',
  },
};
assert.equal(isRetryableCreatedTmsFilterFailure(progress, reason), true);
assert.equal(isRetryableCreatedTmsFilterFailure(progress, `${reason}: 页面重载超时`), true);
for (const queryFailure of [
  'TMS 交易号筛选未收到查询响应',
  'TMS 交易号筛选请求未携带目标交易号',
  'TMS 交易号筛选接口返回 HTTP 503',
]) {
  assert.equal(isRetryableCreatedTmsFilterFailure(progress, queryFailure), true);
  assert.equal(isRetryableCreatedTmsFilterFailure({ ...progress, tmsWorkOrder: null }, queryFailure), false);
}
for (const unsafe of [
  { ...progress, tmsWorkOrder: null },
  { ...progress, tmsWorkOrder: { ...progress.tmsWorkOrder, status: 'failed' } },
  { ...progress, tmsWorkOrder: { ...progress.tmsWorkOrder, orderNumber: 'another-order' } },
  { ...progress, tmsWorkOrder: { ...progress.tmsWorkOrder, ticketId: null } },
  { ...progress, tmsWorkOrder: { ...progress.tmsWorkOrder, ticketNo: null } },
  { ...progress, pddResolutionSubmission: { status: 'unknown' } },
  { ...progress, pddResolutionSubmission: { status: 'succeeded' } },
]) {
  assert.equal(isRetryableCreatedTmsFilterFailure(unsafe, reason), false);
}
assert.equal(isRetryableCreatedTmsFilterFailure(progress, 'TMS 创建接口未返回'), false);
console.log('TMS created-ticket filter retry policy self-test passed');
