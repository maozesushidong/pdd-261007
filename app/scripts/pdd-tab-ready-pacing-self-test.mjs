import assert from 'node:assert/strict';
import { createPddTabReadyPacing } from '../packages/adapters/src/pdd/tab-ready-pacing.mjs';
const steps = [];
let releaseLoad;
const loaded = new Promise(resolve => { releaseLoad = resolve; });
const page = {
  url: () => 'https://mms.pinduoduo.com/aftersales/detail',
  isClosed: () => false,
  waitForLoadState: async state => { steps.push(state); await loaded; },
  waitForTimeout: async ms => steps.push(ms),
};
const pacing = createPddTabReadyPacing();
await pacing.beforeOperation(page, 'page.goto');
assert.deepEqual(steps, []);
const first = pacing.beforeOperation(page, 'locator.click').then(() => steps.push('click'));
const concurrent = pacing.beforeOperation(page, 'page.evaluate').then(() => steps.push('read'));
await Promise.resolve();
assert.deepEqual(steps, ['domcontentloaded'], 'automation must await actual page readiness');
releaseLoad();
await Promise.all([first, concurrent]);
assert.deepEqual(steps, ['domcontentloaded', 1000, 1000, 'click', 'read']);
await pacing.beforeOperation(page, 'locator.fill');
assert.equal(steps.length, 5, 'later actions must not repeat new-tab delays');
for (const url of ['about:blank', 'https://www.jeoms.com/', 'http://tms.aipro123.top/']) {
  await pacing.beforeOperation({ ...page, url: () => url }, 'page.evaluate');
}
assert.equal(steps.length, 5, 'OMS/TMS and blank pages keep their own pacing');
await assert.rejects(pacing.beforeOperation({ ...page,
  waitForLoadState: async () => { throw Error('still loading'); },
}, 'locator.click'), /still loading/);
assert.equal(steps.length, 5, 'load failure must not release automation');
console.log('PDD new-tab readiness and 1s + 1s pacing self-test passed');
