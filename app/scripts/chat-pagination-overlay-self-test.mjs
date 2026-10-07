import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { collectConversation } from '../packages/adapters/src/chat-analysis/collector.mjs';

const day = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
const orderNumber = `${day.slice(2).replaceAll('-', '')}-123456789012345`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.TEST_CHROME_PATH ? { executablePath: process.env.TEST_CHROME_PATH } : {}),
});

try {
  const page = await browser.newPage();
  await page.route('https://mms.pinduoduo.com/**', (route) => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html><meta charset="utf-8"><style>
      .pager-shell { position: relative; margin-top: 20px; }
      .pagination { display: flex; list-style: none; padding: 0; }
      .pagination li { width: 32px; height: 32px; line-height: 32px; text-align: center; cursor: pointer; }
      #umd_kits_home_entry { display: none; position: absolute; top: 0; left: 0; width: 32px; height: 32px; background: white; z-index: 10; }
    </style>
    <label><input type="radio">按订单/违规会话编号查询</label>
    <input placeholder="订单/违规会话编号">
    <input id="range" readonly value="2026-01-01 ~ 2026-12-31">
    <button id="query">查询</button><div id="chat"></div>
    <div class="pager-shell"><ul class="pagination">
      <li class="PGT_pagerItem_1198e34 is-active" data-page="1">1</li>
      <li class="PGT_pagerItem_1198e34" data-page="2">2</li>
    </ul><div id="umd_kits_home_entry"><div>查看全部</div></div></div>
    <div>共 2 页</div>
    <script>
      const showPage = (number) => {
        document.querySelectorAll('.pagination li').forEach((item) => {
          item.classList.toggle('is-active', item.dataset.page === String(number));
        });
        document.querySelector('#umd_kits_home_entry').style.display = number === 2 ? 'block' : 'none';
        document.querySelector('#chat').innerHTML =
          '<div class="chat-item buyer"><div>买家***</div><span>${day} 12:00:00</span><p>第' + number + '页聊天</p></div>';
      };
      document.querySelector('#query').onclick = () => showPage(1);
      document.querySelectorAll('.pagination li').forEach((item) => {
        item.onclick = () => showPage(Number(item.dataset.page));
      });
    </script>`,
  }));
  await page.goto('https://mms.pinduoduo.com/chat');
  const progress = [];
  const result = await collectConversation({
    page,
    shopId: 'fixture-shop',
    orderNumber,
    platformCaseKey: 'fixture-case',
    orderFacts: { orderDate: day },
    onProgress: async (stage) => progress.push(stage),
  });
  assert.equal(result.snapshot.completeness.complete, true,
    JSON.stringify(result.snapshot.completeness));
  assert.equal(result.snapshot.messages.length, 2);
  assert(progress.includes('chat-pagination-overlay-recovery'));
  console.log('CHAT_PAGINATION_OVERLAY_RECOVERY_OK');
} finally {
  await browser.close();
}
