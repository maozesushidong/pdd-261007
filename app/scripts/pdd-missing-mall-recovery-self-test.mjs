import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { chromium } from 'playwright';

const source = fs.readFileSync(new URL('../workflow.mjs', import.meta.url), 'utf8');
const start = source.indexOf('const recoverMissingPddMallAfterVerification =');
const end = source.indexOf('const observeResidentRuntimeState =', start);
assert(start >= 0 && end > start);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
});
let checks = 0;
try {
  const scenario = async ({ globals = {}, progressPatch = {}, initialChallenge = false,
    afterRefresh = '380822048', refreshFails = false } = {}) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let requests = 0;
    await context.route('**/*', async (route) => {
      requests += 1;
      assert.equal(route.request().method(), 'GET');
      if (requests > 1 && refreshFails) return route.abort();
      const value = requests > 1 ? afterRefresh : null;
      await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<html><body>
        <div>PANAPOPO居家官方旗舰店</div>
        ${initialChallenge || value === 'challenge' ? '<div>请向右滑块完成拼图</div>' : ''}
        <script>localStorage.removeItem('new_userinfo');
        ${value && !['challenge', 'missing'].includes(value)
          ? `localStorage.setItem('new_userinfo', JSON.stringify({mall_id:${JSON.stringify(value)}}));` : ''}
        </script></body></html>` });
    });
    await page.goto('https://mms.pinduoduo.com/aftersales/work_order/list');
    let progress = {
      step: 'human-verification-required',
      residentCommand: { status: 'idle' },
      pddShopIdentity: { source: 'confirmed-mall-id-unavailable', mallId: null,
        headerShopName: 'PANAPOPO居家官方旗舰店' },
      ...progressPatch,
    };
    let captures = 0;
    const sandbox = {
      Date, residentCommandMode: true, workflowBusy: false, maintenanceBusy: false,
      activeAssignmentId: null, activeReturnRefundCommand: null,
      activeVerificationRecoveryCommand: null, pddManualLoginWaits: 0,
      pddPostLoginStabilityWaits: 0, expectedMallId: '380822048',
      configuredPddIdentityNames: ['PANAPOPO居家官方旗舰店'],
      readProgress: () => progress,
      writeProgress: (patch) => { progress = { ...progress, ...patch }; },
      normalizePddMallId: (value) => /^\d{5,30}$/.test(String(value)) ? String(value) : null,
      isPddBusinessPageForBarrier: (target) => !target.isClosed()
        && target.url().startsWith('https://mms.pinduoduo.com/aftersales/'),
      pddIdentityMatches: (names, actual) => names.includes(actual),
      hasHumanVerification: async (target) => target.getByText('请向右滑块完成拼图').isVisible(),
      pacedAction: async (_page, _stage, action) => action(),
      capturePddShopIdentity: async (target) => {
        captures += 1;
        const id = await target.evaluate(() => JSON.parse(localStorage.getItem('new_userinfo'))?.mall_id);
        return id === '380822048';
      },
      ...globals,
    };
    vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.recover = recoverMissingPddMallAfterVerification;`, sandbox);
    try {
      const first = await sandbox.recover(page, 'exact-verification');
      const second = await sandbox.recover(page, 'exact-verification');
      return { first, second, progress, requests, captures };
    } finally { await context.close(); }
  };

  const recovered = await scenario();
  assert.equal(recovered.first, true);
  assert.equal(recovered.second, false);
  assert.equal(recovered.requests, 2, 'only one read-only refresh after initial navigation');
  assert.equal(recovered.captures, 1);
  assert.equal(recovered.progress.step, 'human-verification-required',
    'the helper does not independently clear the verification checkpoint');
  assert.equal(recovered.progress.pddMissingMallRecovery.status, 'identity-confirmed');
  checks += 1;

  for (const options of [
    { afterRefresh: '999999999' }, { afterRefresh: 'missing' },
    { afterRefresh: 'challenge' }, { refreshFails: true },
  ]) {
    const result = await scenario(options);
    assert.equal(result.first, false, JSON.stringify(options));
    assert.equal(result.second, false);
    assert.equal(result.requests, 2, 'a failed or uncertain recovery must not loop refreshes');
    assert.equal(result.progress.pddMissingMallRecovery.externalActionsReplayed, false);
    checks += 1;
  }
  for (const options of [
    { globals: { workflowBusy: true } },
    { globals: { maintenanceBusy: true } },
    { globals: { activeAssignmentId: 'active-order' } },
    { globals: { activeReturnRefundCommand: {} } },
    { globals: { activeVerificationRecoveryCommand: {} } },
    { globals: { pddManualLoginWaits: 1 } },
    { globals: { pddPostLoginStabilityWaits: 1 } },
    { progressPatch: { residentCommand: { status: 'active' } } },
    { progressPatch: { pddShopIdentity: { source: 'confirmed-mall-id-conflict',
      mallId: '999999999', headerShopName: 'PANAPOPO居家官方旗舰店' } } },
    { progressPatch: { pddShopIdentity: { source: 'confirmed-mall-id-unavailable',
      headerShopName: '其他店铺' } } },
    { initialChallenge: true },
    { progressPatch: { pddMissingMallRecovery: { verificationId: 'exact-verification',
      expectedMallId: '380822048', status: 'refresh-failed' } } },
  ]) {
    const result = await scenario(options);
    assert.equal(result.first, false, JSON.stringify(options));
    assert.equal(result.second, false);
    assert.equal(result.requests, 1, 'unsafe or already-attempted recovery must not navigate');
    assert.equal(result.captures, 0);
    checks += 1;
  }
  console.log(`PDD missing-mall recovery self-test passed (${checks} browser cases)`);
} finally { await browser.close(); }
