import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { PostgresWorkflowRepository } from '../packages/adapters/src/postgres/index.mjs';
import { collectReturnRefundCandidates, readReturnRefundScanResumeProof } from '../packages/adapters/src/pdd/return-refund.mjs';

const orders = ['260929-111111111111111', '260929-222222222222222'];
const aftersales = ['23111111111111', '23222222222222'];
let stored = {};
const repository = new PostgresWorkflowRepository({ query: async (sql, values) => {
  if (sql.trimStart().startsWith('INSERT')) {
    const scan = JSON.parse(values[2]);
    stored = { cursor: JSON.parse(values[1]), scope_proof: scan.resumeProof,
      scan_action_scope: scan.actionScope, scan_next_cursor: scan.nextCursor };
    return { rows: [] };
  }
  assert(sql.includes("metadata->'returnRefundLastScan'->'resumeProof' AS scope_proof"));
  return { rows: [structuredClone(stored)] };
} });
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
try {
  const page = await browser.newPage();
  const html = '<button>售后工作台</button><button>待商家处理</button><button>退货退款</button>'
    + '<button aria-current="page">1</button>'
    + orders.map((order, i) => `<article>订单号 ${order} 售后编号 ${aftersales[i]} 待处理
      <button onclick="window.detailClicks=(window.detailClicks||0)+1">查看详情</button></article>`).join('');
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto('https://mms.pinduoduo.com/aftersales/aftersale_list');
  const cursor = { page: 1, itemOffset: 1 };
  const proof = await readReturnRefundScanResumeProof(page, cursor);
  const written = await repository.setReturnRefundScanCursor({ shopId: 'test', cursor, scan: { resumeProof: proof } });
  assert.equal(written.actionScope, proof.actionScope);
  // Previously persisted scans have the proof but no explicit cursor marker.
  delete stored.cursor.actionScope;
  stored.verification_handled_count = '2';
  const restored = await repository.getReturnRefundScanCursor('test');
  assert.equal(restored.actionScope, proof.actionScope);
  assert.equal(restored.verificationHandledCount, 2, 'restart verification cooldown evidence must survive');
  const visited = [];
  const result = await collectReturnRefundCandidates(page, page.context(), {
    scanCursor: restored, resumeProof: null, maxItems: 2, maxDurationMs: 5000,
    delayMs: 0, renderWaitMs: 100,
    completedRefunds: orders.map((orderNumber, i) => ({ orderNumber, aftersaleNumber: aftersales[i] })),
    onStep: (stage, metadata) => { if (stage === 'return-refund-scan-known-completed-deferred') visited.push(metadata.orderNumber); },
  });
  assert.equal(result.scan.resumeCheck.cursorScopeReset, false);
  assert.equal(result.scan.resumeCheck.resumed, false, 'scope alone must not authorize live-page reuse');
  assert.deepEqual(result.scan.startCursor, cursor);
  assert.deepEqual(visited, [orders[1]], 'reopening a migrated list must not replay its first row');
  assert.equal(await page.evaluate(() => window.detailClicks || 0), 0);
  // A missing/hidden pagination marker can make live-page proof unavailable.
  // It must not erase the collector's known row-indexing version.
  await repository.setReturnRefundScanCursor({ shopId: 'test', cursor,
    scan: { actionScope: proof.actionScope, nextCursor: cursor, resumeProof: null } });
  assert.equal((await repository.getReturnRefundScanCursor('test')).actionScope, proof.actionScope);
  for (const badProof of [null, { ...proof, actionScope: 'legacy' },
    { ...proof, nextCursor: { page: 1, itemOffset: 0 } },
    { ...proof, nextCursor: { page: 2, itemOffset: 1 } }]) {
    const returned = await repository.setReturnRefundScanCursor({ shopId: 'test',
      cursor: { ...cursor, actionScope: proof.actionScope }, scan: { resumeProof: badProof } });
    assert.equal(returned.actionScope, undefined, 'cursor inputs cannot forge indexing proof');
    stored.cursor.actionScope = proof.actionScope;
    assert.equal((await repository.getReturnRefundScanCursor('test')).actionScope, undefined);
  }
  await repository.setReturnRefundScanCursor({ shopId: 'test', cursor,
    scan: { actionScope: proof.actionScope, nextCursor: { page: 2, itemOffset: 1 } } });
  assert.equal((await repository.getReturnRefundScanCursor('test')).actionScope, undefined);
  console.log('Refund durable scope passed (repository save/restore, lost browser proof, no repeated first row, invalid proof rejection)');
} finally { await browser.close(); }
