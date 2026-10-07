import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { collectReturnRefundCandidates, RETURN_REFUND_WORKBENCH_URL,
} from '../packages/adapters/src/pdd/return-refund.mjs';

const source = fs.readFileSync(new URL('../workflow.mjs', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
const applyStart = source.indexOf('const applyResidentCommand =');
const applyEnd = source.indexOf('\nconst resetResidentAssignment =', applyStart);
const scanStart = source.indexOf('let returnRefundScanPage = null;');
const scanEnd = source.indexOf('\n\nconst residentCommandFailureStatus =', scanStart);
assert(applyStart >= 0 && applyEnd > applyStart && scanStart >= 0 && scanEnd > scanStart);
const orders = ['260929-111111111111111', '260929-222222222222222'];
const aftersales = ['23111111111111', '23222222222222'];
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
try {
  const page = await browser.newPage();
  const html = '<button>售后工作台</button><button>待商家处理</button><button>退货退款</button>'
    + '<button aria-current="page">1</button>'
    + orders.map((order, i) => `<article>订单号 ${order} 售后编号 ${aftersales[i]} 待商家处理
      <button onclick="window.detailClicks=(window.detailClicks||0)+1">查看详情</button></article>`).join('');
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(RETURN_REFUND_WORKBENCH_URL);
  const outputs = [];
  const sandbox = {
    Date, Number, Math, Set, process: { env: { RETURN_REFUND_VISIBLE_STEP_DELAY_MS: '0' },
      send: (_message, callback) => callback?.() },
    targetWorkOrderTitle: 'test', returnRefundVerificationBudgetMs: 300000,
    discoveryExcludedPlatformCaseKeys: new Set(), writeProgress: () => {},
    pddPage: page, omsPage: null, tmsPage: null, context: page.context(),
    listUrl: RETURN_REFUND_WORKBENCH_URL, shopId: 'test-shop', pddRenderWaitMs: 100,
    RETURN_REFUND_WORKBENCH_URL,
    focusSystemPage: async () => {}, ensurePddLogin: async () => {},
    collectReturnRefundCandidates, returnRefundVisibleStep: async () => {},
    checkForHumanVerification: async () => false, logRunStep: () => {},
    evaluateReturnRefundRules: () => assert.fail('known refund hints must avoid detail processing'),
    writeReturnRefundOutput: (output) => outputs.push(output),
  };
  vm.runInNewContext(source.slice(applyStart, applyEnd) + '\nglobalThis.apply = applyResidentCommand;'
    + source.slice(scanStart, scanEnd) + '\nglobalThis.scan = runReturnRefundScanOnly;', sandbox);
  const command = { action: 'refund-scan', requestId: 'hint-roundtrip', maxItems: 2,
    maxDurationMs: 30000, scanCursor: { page: 1, itemOffset: 0 },
    deferredRefunds: [{ orderNumber: orders[0], aftersaleNumber: aftersales[0],
      nextCheckAt: new Date(Date.now() + 86400000).toISOString(), privateExtra: 'must not pass' }],
    completedRefunds: [{ orderNumber: orders[1], aftersaleNumber: aftersales[1] }],
  };
  await sandbox.apply(command);
  assert.equal(sandbox.activeReturnRefundCommand.deferredRefunds.length, 1);
  assert.equal(sandbox.activeReturnRefundCommand.completedRefunds.length, 1);
  assert.equal(sandbox.activeReturnRefundCommand.deferredRefunds[0].privateExtra, undefined);
  await sandbox.scan();
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].scan.examined, 2);
  assert.equal(outputs[0].scan.listResponseDiagnostics.rowsSkippedKnownCompleted, 1);
  assert.equal(outputs[0].scan.listResponseDiagnostics.rowsSkippedKnownWait, 1);
  assert.equal(outputs[0].scan.listResponseDiagnostics.lastMatch.deferredLookupCount, 1);
  assert.equal(outputs[0].scan.listResponseDiagnostics.lastMatch.completedLookupCount, 1);
  assert.equal(await page.evaluate(() => window.detailClicks || 0), 0,
    'the actual command-to-scan path must not reopen known future or confirmed completed refunds');
  await sandbox.apply({ ...command, maxItems: 1, maxKnownSkippedItems: 1 });
  assert.equal(sandbox.activeReturnRefundCommand.maxKnownSkippedItems, 1,
    'KNOWN_ROW_ALLOWANCE_MUST_SURVIVE_THE_ACTUAL_COMMAND_BRIDGE');
  await sandbox.scan();
  assert.equal(outputs.length, 2);
  assert.equal(outputs[1].scan.examined, 2);
  assert.equal(outputs[1].scan.budgetedItems, 1);
  assert.equal(outputs[1].scan.knownSkippedAllowanceUsed, 1);
  for (const [input, expected] of [[-1,0], [21,20], [1.9,1], [null,0], ['invalid',0]]) {
    await sandbox.apply({ ...command, maxKnownSkippedItems: input });
    assert.equal(sandbox.activeReturnRefundCommand.maxKnownSkippedItems, expected);
  }
  await sandbox.apply({ ...command, deferredRefunds: {}, completedRefunds: null });
  assert.equal(sandbox.activeReturnRefundCommand.deferredRefunds.length, 0);
  assert.equal(sandbox.activeReturnRefundCommand.completedRefunds.length, 0);
  await sandbox.apply({ ...command, deferredRefunds: Array.from({ length: 5001 }, () => command.deferredRefunds[0]) });
  assert.equal(sandbox.activeReturnRefundCommand.deferredRefunds.length, 5000);
  await sandbox.apply({ ...command, action: 'run-refund', orderNumber: orders[0], assignmentId: 'lease',
    existingEffectStatus: 'unknown', existingEffectReceipt: { confirmationClicked: true }, readOnlyReview: true,
    maxKnownSkippedItems: 20 });
  assert.equal(sandbox.activeReturnRefundCommand.deferredRefunds.length, 0);
  assert.equal(sandbox.activeReturnRefundCommand.completedRefunds.length, 0);
  assert.equal(sandbox.activeReturnRefundCommand.existingEffectStatus, 'unknown');
  assert.equal(sandbox.activeReturnRefundCommand.readOnlyReview, true);
  assert.equal(sandbox.activeReturnRefundCommand.maxKnownSkippedItems, 0);
  assert.equal(sandbox.externalEffectGuardEnabled, true);
  await sandbox.apply({ ...command, scanCursor: { page: 2, itemOffset: 3,
    actionScope: 'refund-list-without-platform-messages-v1' } });
  assert.equal(sandbox.activeReturnRefundCommand.scanCursor.actionScope,
    'refund-list-without-platform-messages-v1');
  await sandbox.apply({ ...command, scanCursor: { page: 2, itemOffset: 3, actionScope: 'legacy' } });
  assert.equal(sandbox.activeReturnRefundCommand.scanCursor.actionScope, undefined);
  console.log('Refund scan command hints passed (actual IPC apply + browser collector, hint bounds, unknown effect preserved)');
} finally {
  await browser.close();
}
