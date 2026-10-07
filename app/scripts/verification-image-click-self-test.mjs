import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import {
  detectHumanVerification,
  isImageClickVerificationDetection,
} from '../packages/adapters/src/verification-detector/detect.mjs';

const browserExecutablePath = String(process.env.PDD_BROWSER_EXECUTABLE_PATH || '').trim();
const browser = await chromium.launch({
  headless: true,
  ...(browserExecutablePath ? { executablePath: browserExecutablePath } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await page.setContent(`
    <main>
      <div class="ant-modal" role="dialog" style="display:block;width:420px;height:260px;padding:24px">
        <button class="modal-close" aria-label="关闭" style="position:absolute;right:8px;top:8px">×</button>
        <p>请点击字母H正下方的物体</p>
        <img alt="challenge" width="272" height="160"
          src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='272' height='160'%3E%3Crect width='272' height='160' fill='%23eee'/%3E%3C/svg%3E" />
      </div>
    </main>
  `);
  const detection = await detectHumanVerification(page);
  assert(detection, 'image-selection modal should be detected');
  assert.equal(detection.reason, 'image-click-modal');
  assert.equal(isImageClickVerificationDetection(detection), true);
  assert.equal(detection.closeBoundingBox.width > 0, true);

  await page.setContent(`
    <div class="beast-core-modal" role="dialog" style="display:block;width:420px;height:260px;padding:24px">
      <button class="close-icon" aria-label="关闭" style="position:absolute;right:8px;top:8px">×</button>
      <p>请点击小型绿色圆锥</p>
      <img alt="challenge" width="272" height="160"
        src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='272' height='160'%3E%3Crect width='272' height='160' fill='%23eee'/%3E%3C/svg%3E" />
    </div>
  `);
  const variantDetection = await detectHumanVerification(page);
  assert(variantDetection, 'direct-shape image-selection modal should be detected');
  assert.equal(variantDetection.reason, 'image-click-modal');
  assert.equal(isImageClickVerificationDetection(variantDetection), true);

  await page.setContent(`
    <div class="beast-core-modal" role="dialog" style="display:block;width:420px;height:260px;padding:24px">
      <button class="close-icon" aria-label="关闭" style="position:absolute;right:8px;top:8px">×</button>
      <p>请点击黄色字母对应的小写</p>
      <img alt="challenge" width="272" height="160"
        src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='272' height='160'%3E%3Crect width='272' height='160' fill='%23eee'/%3E%3C/svg%3E" />
    </div>
  `);
  const letterDetection = await detectHumanVerification(page);
  assert(letterDetection, 'letter image-selection modal should be detected');
  assert.equal(letterDetection.reason, 'image-click-modal');

  // PDD can render the captcha layer without a dialog class and mount the X
  // as an absolutely-positioned sibling. The detector must still identify the
  // strict image-selection surface so the workflow can close that X.
  await page.setContent(`
    <main>
      <div class="captcha-layer" style="position:absolute;left:58px;top:86px;width:320px;height:240px;background:#fff">
        <p>请点击绿色字母对应的小写</p>
        <img alt="challenge" width="272" height="136"
          src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='272' height='136'%3E%3Crect width='272' height='136' fill='%23eee'/%3E%3C/svg%3E" />
      </div>
      <button style="position:absolute;left:361px;top:70px;width:34px;height:34px">×</button>
    </main>
  `);
  const siblingCloseDetection = await detectHumanVerification(page);
  assert(siblingCloseDetection, 'captcha layer with a sibling close button should be detected');
  assert.equal(siblingCloseDetection.reason, 'image-click-modal');
  assert.equal(siblingCloseDetection.closeBoundingBox.width, 34);

  // Some PDD builds draw the circular X as an unlabelled icon node. There is
  // no semantic close selector to match, so retain the verified modal's exact
  // top-right coordinate for the workflow's tightly-scoped click fallback.
  await page.setContent(`
    <main>
      <div class="captcha-layer" style="position:absolute;left:58px;top:86px;width:320px;height:240px;background:#fff">
        <p>请点击绿色字母对应的小写</p>
        <img alt="challenge" width="272" height="136"
          src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='272' height='136'%3E%3Crect width='272' height='136' fill='%23eee'/%3E%3C/svg%3E" />
      </div>
      <div style="position:absolute;left:360px;top:68px;width:36px;height:36px;border-radius:50%;background:#aaa">
        <svg width="36" height="36"><path d="M10 10L26 26M26 10L10 26" /></svg>
      </div>
    </main>
  `);
  const coordinateCloseDetection = await detectHumanVerification(page);
  assert(coordinateCloseDetection, 'unlabelled image-selection close control should be detected');
  assert.equal(coordinateCloseDetection.reason, 'image-click-modal');
  assert.equal(coordinateCloseDetection.closeMethod, 'surface-corner');
  assert.deepEqual(coordinateCloseDetection.closeBoundingBox, {
    x: 360,
    y: 68,
    width: 36,
    height: 36,
  });

  // The current production dialog paints the challenge into an anonymous
  // CSS-background div. It must still enter the strict image-click branch.
  await page.setContent(`
    <main>
      <div class="challenge-panel" style="position:absolute;left:58px;top:86px;width:320px;height:240px;background:#fff">
        <p>请点击绿色字母对应的小写</p>
        <div style="width:272px;height:136px;background-image:url(&quot;data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='272' height='136'%3E%3Crect width='272' height='136' fill='%23eee'/%3E%3C/svg%3E&quot;);background-size:cover"></div>
      </div>
      <div style="position:absolute;left:360px;top:68px;width:36px;height:36px;border-radius:50%;background:#aaa">
        <svg width="36" height="36"><path d="M10 10L26 26M26 10L10 26" /></svg>
      </div>
    </main>
  `);
  const backgroundImageDetection = await detectHumanVerification(page);
  assert(backgroundImageDetection, 'CSS-background image-selection modal should be detected');
  assert.equal(backgroundImageDetection.reason, 'image-click-modal');
  assert.equal(backgroundImageDetection.closeMethod, 'surface-corner');
  assert.deepEqual(backgroundImageDetection.closeBoundingBox, {
    x: 360,
    y: 68,
    width: 36,
    height: 36,
  });

  // The instruction may briefly outlive the image during a redraw. A
  // challenge-like positioned panel with the anonymous top-right X must
  // still be classified as image-selection, while slider text never matches
  // this branch.
  await page.setContent(`
    <main>
      <div class="captcha-layer" style="position:absolute;left:58px;top:86px;width:320px;height:240px;background:#fff">
        <p>请点击绿色字母对应的小写</p>
      </div>
      <div style="position:absolute;left:360px;top:68px;width:36px;height:36px;border-radius:50%;background:#aaa">
        <svg width="36" height="36"><path d="M10 10L26 26M26 10L10 26" /></svg>
      </div>
    </main>
  `);
  const redrawFallbackDetection = await detectHumanVerification(page);
  assert(redrawFallbackDetection, 'redraw text shell should remain dismissible');
  assert.equal(redrawFallbackDetection.reason, 'image-click-modal');
  assert.deepEqual(redrawFallbackDetection.closeBoundingBox, {
    x: 360,
    y: 68,
    width: 36,
    height: 36,
  });

  await page.setContent(`
    <div class="beast-core-modal" role="dialog" style="display:block;width:420px;height:260px;padding:24px">
      <button aria-label="关闭" style="position:absolute;right:8px;top:8px">×</button>
      <p>请向右滑块完成拼图</p>
      <img alt="slider challenge" width="272" height="136"
        src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='272' height='136'%3E%3Crect width='272' height='136' fill='%23eee'/%3E%3C/svg%3E" />
      <div role="slider" aria-label="拖动滑块" style="width:272px;height:24px"></div>
    </div>
  `);
  const sliderDetection = await detectHumanVerification(page);
  assert(sliderDetection, 'slider challenge should remain detected');
  assert.equal(isImageClickVerificationDetection(sliderDetection), false,
    'slider challenge must never enter the image-click close branch');

  await page.setContent(`
    <div class="ant-modal" role="dialog" style="display:block;width:420px;height:260px;padding:24px">
      <button aria-label="关闭" style="position:absolute;right:8px;top:8px">×</button>
      <p>商品详情图片</p>
      <img alt="product" width="272" height="160"
        src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='272' height='160'%3E%3Crect width='272' height='160' fill='%23eee'/%3E%3C/svg%3E" />
    </div>
  `);
  assert.equal(await detectHumanVerification(page), null,
    'ordinary image modal must not be treated as an image-selection challenge');
} finally {
  await browser.close();
}

console.log('image-click verification detection self-test passed');
