import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const executablePath = process.env.WORKFLOW_BROWSER_EXECUTABLE_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profileRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'pdd-chrome-policy-'));

const collectComposedText = () => {
  const parts = [];
  const visit = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const value = node.textContent?.trim();
      if (value) parts.push(value);
      node = walker.nextNode();
    }
    for (const element of root.querySelectorAll?.('*') || []) {
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  return [...new Set(parts)].join('\n');
};

let context;
try {
  context = await chromium.launchPersistentContext(profileRoot, {
    executablePath,
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-logging=stderr', '--v=1'],
  });
  const page = context.pages()[0] || await context.newPage();
  const pages = {};
  for (const url of ['chrome://policy', 'chrome://management', 'chrome://extensions-internals']) {
    await page.goto(url);
    await page.waitForTimeout(3000);
    pages[url] = (await page.evaluate(collectComposedText)).slice(0, 30000);
  }
  const browserSession = await context.browser().newBrowserCDPSession();
  const targets = await browserSession.send('Target.getTargets');
  await browserSession.detach();
  console.log(JSON.stringify({
    executablePath,
    browserVersion: context.browser().version(),
    pages,
    extensionTargets: targets.targetInfos
      .filter((target) => String(target.url || '').startsWith('chrome-extension://'))
      .map((target) => ({ type: target.type, url: target.url })),
  }));
} finally {
  await context?.close().catch(() => {});
  await fsp.rm(profileRoot, { recursive: true, force: true });
}
