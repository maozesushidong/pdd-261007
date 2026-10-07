import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
const adapter = process.env.REFUND_ADAPTER_SOURCE_FILE
  ? pathToFileURL(process.env.REFUND_ADAPTER_SOURCE_FILE).href
  : new URL('../packages/adapters/src/pdd/return-refund.mjs', import.meta.url).href;
const { collectReturnRefundCandidates, readReturnRefundScanResumeProof } = await import(adapter);
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
try {
  const context = await browser.newContext();
  let detailLoads = 0;
  const rows = Array.from({ length: 30 }, (_, i) => ({
    orderNumber: `260929-${String(i + 1).padStart(15, '0')}`,
    aftersaleNumber: String(23000000000000 + i),
  }));
  const html = '<button>待商家处理</button><button>退货退款</button>'
    + '<nav><button aria-current="page">1</button></nav>'
    + rows.map(row => `<article>订单号 ${row.orderNumber} 售后编号 ${row.aftersaleNumber} 待商家确认收货
        <button onclick="window.open('/aftersales-ssr/detail?id=${row.aftersaleNumber}&orderSn=${row.orderNumber}', '_blank')">查看详情</button></article>`).join('');
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/aftersales/aftersale_list') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
    if (url.pathname === '/aftersales-ssr/detail') {
      detailLoads += 1;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body:
        `订单号：${url.searchParams.get('orderSn')}<br>售后编号：${url.searchParams.get('id')}<br>
        售后类型：退货退款<br>退款金额：￥49.99<br>售后状态：商家同意退款，本单退款成功` });
    }
    return route.abort();
  });
  const page = await context.newPage();
  const run = async ({ allowance=0, unknown=[], invalidIdentity=false, duration=10000, delayMs=0, futureWait=false }={}) => {
    detailLoads=0;
    await page.goto('https://mms.pinduoduo.com/aftersales/aftersale_list');
    const result = await collectReturnRefundCandidates(page, context, {
      maxItems: 3, maxKnownSkippedItems: allowance, maxDurationMs: duration,
      scanCursor: { page:1, itemOffset:0 },
      resumeProof: await readReturnRefundScanResumeProof(page, {page:1,itemOffset:0}),
      completedRefunds: futureWait ? [] : rows.filter((_,i)=>!unknown.includes(i)).map(row => ({
        ...row, aftersaleNumber: invalidIdentity ? '23999999999999' : row.aftersaleNumber,
      })),
      deferredRefunds: futureWait ? rows.filter((_,i)=>!unknown.includes(i)).map(row => ({
        ...row, nextCheckAt: new Date(Date.now()+24*60*60_000).toISOString(),
      })) : [],
      delayMs, renderWaitMs:100,
      createBackgroundDetailPage: () => context.newPage(),
    });
    return { result, detailLoads };
  };
  let out=await run({allowance:20,unknown:[8,9,10,11]});
  assert.equal(out.result.scan.examined,11,'KNOWN_ROWS_MUST_NOT_HIDE_NEW_REFUNDS_AFTER_THE_THIRD_ROW');
  assert.equal(out.result.items.length,3);
  assert.deepEqual(out.result.items.map(x=>x.orderNumber),rows.slice(8,11).map(x=>x.orderNumber));
  assert.equal(out.detailLoads,3,'The ordinary three-detail cap must remain');
  assert.deepEqual(out.result.scan.nextCursor,{page:1,itemOffset:11});
  assert.equal(out.result.scan.knownSkippedAllowanceUsed,8);
  assert.equal(out.result.scan.budgetedItems,3);
  out=await run({allowance:20,unknown:[8,9,10,11],futureWait:true});
  assert.equal(out.result.scan.examined,11,'Future rechecks must leave the same opportunity for new refunds');
  assert.equal(out.result.scan.listResponseDiagnostics.rowsSkippedKnownWait,8);
  assert.equal(out.detailLoads,3);
  assert.deepEqual(out.result.items.map(x=>x.orderNumber),rows.slice(8,11).map(x=>x.orderNumber));
  out=await run();
  assert.equal(out.result.scan.examined,3,'Default callers retain their original row limit');
  assert.equal(out.detailLoads,0);
  out=await run({allowance:20});
  assert.equal(out.result.scan.examined,23,'A known-only batch must remain bounded');
  assert.equal(out.result.scan.knownSkippedAllowanceUsed,20);
  assert.equal(out.detailLoads,0);
  out=await run({allowance:500});
  assert.equal(out.result.scan.examined,23,'The extra allowance must be capped at twenty');
  out=await run({allowance:20,invalidIdentity:true});
  assert.equal(out.result.scan.examined,3,'Same order with another aftersale cannot consume the skip allowance');
  assert.equal(out.detailLoads,3);
  assert.equal(out.result.scan.knownSkippedAllowanceUsed,0);
  out=await run({allowance:20,duration:250,delayMs:40});
  assert(out.result.scan.examined<23,'The existing duration cap must still yield');
  assert.equal(out.detailLoads,0);
  await context.close();
  console.log('Refund known-row budget passed: discover new rows behind known waits/completions, retain three-detail cap, exact identity, capped extra skips, original default and duration boundary');
} finally { await browser.close(); }
