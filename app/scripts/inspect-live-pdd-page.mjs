import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { chromium } from 'playwright';

const [, , endpoint = 'http://127.0.0.1:9333', outputArgument = ''] = process.argv;
const outputDir = path.resolve(outputArgument || path.join('data', 'live-pdd-inspection'));
await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.connectOverCDP(endpoint);
const contexts = browser.contexts();
const pages = contexts.flatMap((context) => context.pages());
const page = pages.find((candidate) => /mms\.pinduoduo\.com\/aftersales\/work_order\/tododetail/u.test(candidate.url()))
  || pages.find((candidate) => /mms\.pinduoduo\.com/u.test(candidate.url()));

if (!page) {
  throw new Error(`No PDD page is attached at ${endpoint}`);
}

await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
await page.waitForTimeout(2_000);

const snapshot = await page.evaluate(() => {
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden'
      && style.display !== 'none'
      && rect.width > 0
      && rect.height > 0;
  };
  const text = (element) => String(element.innerText || element.textContent || '')
    .replace(/\s+/gu, ' ')
    .trim();
  const describe = (element) => ({
    tag: element.tagName.toLowerCase(),
    text: text(element),
    ariaLabel: element.getAttribute('aria-label'),
    role: element.getAttribute('role'),
    type: element.getAttribute('type'),
    name: element.getAttribute('name'),
    value: element.value ?? null,
    placeholder: element.getAttribute('placeholder'),
    checked: typeof element.checked === 'boolean' ? element.checked : null,
    disabled: typeof element.disabled === 'boolean' ? element.disabled : null,
    className: typeof element.className === 'string' ? element.className : null,
  });
  const collect = (selector) => [...document.querySelectorAll(selector)]
    .filter(visible)
    .map(describe)
    .filter((item) => item.text || item.ariaLabel || item.value || item.placeholder);
  return {
    title: document.title,
    url: location.href,
    bodyText: text(document.body),
    buttons: collect('button, [role="button"]'),
    radios: collect('input[type="radio"], [role="radio"]'),
    checkboxes: collect('input[type="checkbox"], [role="checkbox"]'),
    inputs: collect('input, textarea, [contenteditable="true"]'),
    tabs: collect('[role="tab"], .ant-tabs-tab'),
    links: collect('a[href]'),
  };
});

const timestamp = new Date().toISOString().replace(/[:.]/gu, '-');
const jsonPath = path.join(outputDir, `${timestamp}.json`);
const screenshotPath = path.join(outputDir, `${timestamp}.png`);
await fs.writeFile(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
await page.screenshot({ path: screenshotPath, fullPage: true });

console.log(JSON.stringify({
  ...snapshot,
  bodyText: undefined,
  bodyTextLength: snapshot.bodyText.length,
  jsonPath,
  screenshotPath,
}, null, 2));

// The CDP browser intentionally remains open for visible follow-up actions.
process.exit(0);
