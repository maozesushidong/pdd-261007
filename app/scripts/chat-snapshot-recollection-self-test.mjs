import assert from 'node:assert/strict';

import { ChatRepository } from '../packages/adapters/src/chat-analysis/repository.mjs';

const caseRow = {
  id: 'case-id', shop_id: 'shop-id', order_number: 'order-number',
  platform_case_key: 'pdd-work-order:123', scenario_code: 'product-shortage',
  collect_token: 'lease-token',
};
const snapshot = {
  shopId: caseRow.shop_id,
  orderNumber: caseRow.order_number,
  platformCaseKey: caseRow.platform_case_key,
  contentHash: 'unchanged-content',
  orderFacts: {},
};
const config = { model: 'test-model', baseUrl: 'https://example.invalid/v1' };

const save = async ({ existingJob = null, mode = 'auto-feedback' } = {}) => {
  let savedCase = null;
  let committed = false;
  const client = {
    async query(sql, values) {
      if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
      if (sql === 'COMMIT') { committed = true; return { rows: [], rowCount: 0 }; }
      if (sql === 'ROLLBACK') throw Error('saveSnapshot unexpectedly rolled back');
      if (sql.includes('SELECT id FROM chat_cases')) return { rows: [{ id: caseRow.id }], rowCount: 1 };
      if (sql.includes('INSERT INTO chat_snapshots')) return { rows: [{ id: 'snapshot-id' }], rowCount: 1 };
      if (sql.includes('INSERT INTO chat_analysis_jobs')) return { rows: [], rowCount: existingJob ? 0 : 1 };
      if (sql.includes('FROM chat_analysis_jobs WHERE case_id=')) {
        assert(existingJob);
        return { rows: [existingJob], rowCount: 1 };
      }
      if (sql.includes('SELECT mode FROM chat_analysis_settings')) return { rows: [{ mode }], rowCount: 1 };
      if (sql.includes('UPDATE chat_cases SET status=')) {
        savedCase = { status: values[1], error: values[2] };
        return { rows: [], rowCount: 1 };
      }
      throw Error(`Unexpected query: ${sql}`);
    },
    release() {},
  };
  await new ChatRepository({ connect: async () => client })
    .saveSnapshot(caseRow, snapshot, [], config);
  assert.equal(committed, true);
  return savedCase;
};

assert.deepEqual(await save(), { status: 'analysis-pending', error: null });
assert.deepEqual(await save({ existingJob: { status: 'analyzed', result: { policy: { eligible: false } } } }),
  { status: 'owner-review', error: null });
assert.deepEqual(await save({ existingJob: { status: 'analyzed', result: { policy: { eligible: true } } } }),
  { status: 'auto-ready', error: null });
assert.deepEqual(await save({ existingJob: { status: 'analyzed', result: { policy: { eligible: true } } }, mode: 'analyze-only' }),
  { status: 'awaiting-owner-approval', error: null });
assert.deepEqual(await save({ existingJob: { status: 'failed', error_code: 'CHAT_MODEL_NETWORK_OR_TIMEOUT' } }),
  { status: 'owner-review', error: 'CHAT_MODEL_NETWORK_OR_TIMEOUT' });
assert.deepEqual(await save({ existingJob: { status: 'running' } }),
  { status: 'analysis-pending', error: null });
console.log('chat snapshot recollection status regression passed');
