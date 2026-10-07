import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { detectHumanVerification } from '../packages/adapters/src/verification-detector/detect.mjs';

const environment = fs.readFileSync(new URL('../.env.native', import.meta.url), 'utf8');
const executablePath = process.env.PDD_BROWSER_EXECUTABLE_PATH
  || environment.split(/\r?\n/u).find((line) => line.startsWith('WORKFLOW_BROWSER_EXECUTABLE_PATH='))?.split('=').slice(1).join('=').trim();
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
const cases = [];
const fixtures = {
  slider: '<div class="captcha" style="width:320px;height:210px"><p style="height:7px;line-height:7px">请向右滑块完成拼图</p><canvas width="272" height="160"></canvas><div role="slider" style="width:100px;height:20px"></div></div>',
  control: '<div class="captcha" style="width:320px;height:180px"></div>',
  image: '<div role="dialog" class="captcha" style="position:relative;width:320px;height:220px"><button aria-label="关闭" style="position:absolute;right:5px;top:5px;width:24px;height:24px">×</button><p>请点击红色的物体</p><canvas width="272" height="160"></canvas></div>',
  resource: '<div role="dialog" class="captcha" style="width:320px;height:180px"><p>验证资源获取失败，请重试</p></div>',
  expired: '<div role="dialog" class="captcha" style="position:relative;width:320px;height:180px"><p>验证时间过长，请重试</p><button aria-label="关闭" style="position:absolute;right:5px;top:5px;width:24px;height:24px">×</button></div>',
};
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  for (const [name, html] of Object.entries(fixtures)) {
    for (const [style, expected] of [['', true], ['opacity:0', false], ['display:none', false], ['visibility:hidden', false]]) {
      await page.setContent(`<main><h1>工单详情</h1><section style="${style}">${html}</section></main>`);
      const result = await detectHumanVerification(page);
      cases.push({ name: `${name}:${style || 'visible'}`, detected: Boolean(result) });
      assert.equal(Boolean(result), expected, `${name} with ${style || 'visible'} must report its rendered visibility`);
      if (expected && name === 'resource') assert.equal(result.reason, 'verification-resource-failed');
      if (expected && name === 'expired') assert.equal(result.reason, 'expired-verification-modal');
    }
  }
  for (const [style, expected] of [['', true], ['opacity:0', false], ['display:none', false]]) {
    const escaped = fixtures.slider.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    await page.setContent(`<section style="${style}"><iframe title="business" style="width:400px;height:400px" srcdoc="${escaped}"></iframe></section>`);
    const iframe = page.frames().find((frame) => frame !== page.mainFrame());
    await iframe.waitForSelector('.captcha', { state: 'attached' });
    const result = await detectHumanVerification(page);
    cases.push({ name: `iframe:${style || 'visible'}`, detected: Boolean(result) });
    assert.equal(Boolean(result), expected, 'an invisible iframe must not report its internal challenge');
  }
  await page.route('https://verification.fixture.test/**', (route) => route.fulfill({
    contentType: 'text/html', body: fixtures.slider,
  }));
  for (const [style, expected] of [['', true], ['opacity:0', false]]) {
    await page.setContent(`<section style="${style}"><iframe style="width:400px;height:400px" src="https://verification.fixture.test/challenge"></iframe></section>`);
    const iframe = page.frames().find((frame) => frame !== page.mainFrame());
    await iframe.waitForSelector('.captcha', { state: 'attached' });
    const result = await detectHumanVerification(page);
    cases.push({ name: `verification-url-iframe:${style || 'visible'}`, detected: Boolean(result) });
    assert.equal(Boolean(result), expected, 'a verification URL must still require a rendered iframe');
  }
  await page.setContent(fixtures.resource.replace('验证资源获取失败，请重试', '<span>验证资源获取失败，</span><span>请重试</span>'));
  assert.equal((await detectHumanVerification(page))?.reason, 'verification-resource-failed');
  cases.push({ name: 'visible-fragmented-message', detected: true });
  await page.setContent(`<section style="opacity:0">${fixtures.slider}</section>${fixtures.resource}`);
  assert.equal((await detectHumanVerification(page))?.reason, 'verification-resource-failed', 'a hidden residual slider must not mask the live verification error');
  cases.push({ name: 'hidden-residual-with-live-error', detected: true });
  await page.setContent('<main><h1>售后工单</h1><p>暂无待处理工单</p></main>');
  assert.equal(await detectHumanVerification(page), null);
  cases.push({ name: 'business-only', detected: false });
  console.log(`Verification rendered visibility passed: ${cases.length} isolated browser cases`);
} finally {
  await browser.close();
}
