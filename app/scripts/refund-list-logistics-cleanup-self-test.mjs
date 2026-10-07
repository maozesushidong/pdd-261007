import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { collectReturnRefundCandidates, readReturnRefundScanResumeProof,
  matchesReturnRefundScanResumeProof } from '../packages/adapters/src/pdd/return-refund.mjs';

const source = fs.readFileSync(new URL('../workflow.mjs', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
const extract = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert(from >= 0 && to > from);
  return source.slice(from, to);
};
const cleanupSource = extract('const closeOrdinaryLogisticsDerivedPages =', '\nconst runReturnRefundScanOnly =');
const closeSource = extract('const closeDerivedPage =', '\nconst protectVerificationRecoveryPage =');
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined });
let tested = 0;
try {
  const fixture = async () => {
    const context = await browser.newContext();
    let navigations = 0;
    await context.route('https://mms.pinduoduo.com/**', async (route) => {
      navigations += 1;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `
        <button aria-current="page">12</button>
        <article>订单号 260929-111111111111111<button>查看详情</button></article>` });
    });
    const anchor = await context.newPage();
    const list = await context.newPage();
    const ordinary = await context.newPage();
    await list.goto('https://mms.pinduoduo.com/aftersales/aftersale_list');
    const cursor = { page: 12, itemOffset: 1 };
    const proof = await readReturnRefundScanResumeProof(list, cursor);
    assert(proof);
    const state = { URL, Number, JSON, Error, crypto, console: { log() {} },
      shopId: 'test-shop', residentCommandMode: true, activeReturnRefundCommand: null,
      returnRefundScanPage: list, returnRefundScanResumeProof: proof, pddPage: anchor,
      derivedPages: new Set([list, ordinary]),
      derivedPageMeta: new Map([[list, { purpose: 'return-refund-scan-list' }],
        [ordinary, { purpose: 'ordinary-order-detail' }]]),
      verificationRecoveryProtectedPages: new Map(), activeVerificationRecoveryPage: null,
      activeVerificationRecoveryCommand: null, deliberateDerivedPageCloses: new Map(),
    };
    vm.runInNewContext(`${closeSource}\n${cleanupSource}\nglobalThis.cleanup = closeOrdinaryLogisticsDerivedPages;`, state);
    return { context, anchor, list, ordinary, state, cursor, proof, navigations: () => navigations };
  };

  const kept = await fixture();
  await kept.state.cleanup();
  assert.equal(kept.ordinary.isClosed(), true, 'the finished ordinary detail is still cleaned up');
  assert.equal(kept.list.isClosed(), false, 'a partial refund list must survive ordinary logistics waiting');
  assert.equal(kept.anchor.isClosed(), false);
  assert.equal(kept.state.returnRefundScanResumeProof, kept.proof, 'cleanup must not rewrite the scan proof');
  const steps = [];
  const scan = await collectReturnRefundCandidates(kept.list, kept.context, {
    scanCursor: kept.cursor, resumeProof: kept.proof, maxItems: 3, maxDurationMs: 5_000,
    delayMs: 0, renderWaitMs: 100, protectedPages: [kept.anchor],
    onStep: async (stage) => { steps.push(stage); },
  });
  assert.equal(scan.scan.resumeCheck.resumed, true, 'the actual collector must reuse the retained page');
  assert.equal(kept.navigations(), 1, 'resuming must not navigate back through the refund workbench');
  assert(!steps.includes('return-refund-cursor-next-page'), 'resuming page 12 must not replay pages 1–11');
  tested += 1;
  await kept.context.close();

  const variants = [
    ['no saved proof', (x) => { x.state.returnRefundScanResumeProof = null; }],
    ['complete scan', (x) => { x.state.returnRefundScanResumeProof = { ...x.proof, nextCursor: { page: 1, itemOffset: 0 } }; }],
    ['standalone execution', (x) => { x.state.residentCommandMode = false; }],
    ['active refund command', (x) => { x.state.activeReturnRefundCommand = { action: 'run-refund' }; }],
    ['different owned page', (x) => { x.state.returnRefundScanPage = x.ordinary; }],
    ['unrelated derived purpose', (x) => { x.state.derivedPageMeta.set(x.list, { purpose: 'browser-popup' }); }],
    ['URL changed', async (x) => { await x.list.goto('https://mms.pinduoduo.com/aftersales/work_order/list'); }],
    ['filter URL changed', async (x) => { await x.list.goto('https://mms.pinduoduo.com/aftersales/aftersale_list?filter=other'); }],
  ];
  for (const [name, change] of variants) {
    const x = await fixture();
    await change(x);
    await x.state.cleanup();
    assert.equal(x.list.isClosed(), true, `${name}: normal cleanup must still apply`);
    await x.context.close();
    tested += 1;
  }

  const challenged = await fixture();
  challenged.state.returnRefundScanResumeProof = null;
  challenged.state.verificationRecoveryProtectedPages.set(challenged.list, 'test-verification');
  await challenged.state.cleanup();
  assert.equal(challenged.list.isClosed(), false, 'the existing human-verification tab protection must remain effective');
  await challenged.context.close();
  tested += 1;

  const changed = await fixture();
  await changed.state.cleanup();
  await changed.list.locator('article').evaluate((node) => {
    node.firstChild.textContent = '订单号 260929-222222222222222';
  });
  assert.equal(matchesReturnRefundScanResumeProof(changed.proof,
    await readReturnRefundScanResumeProof(changed.list, changed.cursor), changed.cursor), false,
  'retaining a page must not permit reuse after the actual row changed');
  await changed.context.close();
  tested += 1;
  console.log(`Refund list logistics cleanup self-test passed (${tested} browser cases)`);
} finally {
  await browser.close();
}
