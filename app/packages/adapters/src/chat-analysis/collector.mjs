import { digest } from './rules.mjs';

export function orderDate(orderNumber) {
  const m = /^(\d{2})(\d{2})(\d{2})-/.exec(orderNumber || '');
  if (!m) return null;
  const value = `20${m[1]}-${m[2]}-${m[3]}`;
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value) ? value : null;
}
export function dateWindows(from, to, days = 30) {
  const result = []; let first = Date.parse(`${from}T00:00:00+08:00`);
  const end = Date.parse(`${to}T00:00:00+08:00`);
  if (!Number.isFinite(first) || !Number.isFinite(end) || end < first) return result;
  const date = (time) => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
  while (first <= end) { const last = Math.min(end, first + (days - 1) * 86400000); result.push({ from: date(first), to: date(last) }); first = last + 86400000; }
  return result;
}

// This function runs inside the merchant page. Retain message-level provenance,
// including unrecognised attachments, instead of reading the whole body as chat.
export function readChatDom({ sellerNamePrefix = '' } = {}) {
  const visible = (el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
  const datePattern = /^20\d\d[-/]\d\d[-/]\d\d\s+\d\d:\d\d(?::\d\d)?$/;
  const stamps = [...document.querySelectorAll('span,time,div,p')].filter((el) =>
    visible(el) && datePattern.test(el.textContent.trim()) && ![...el.children].some((child) => datePattern.test(child.textContent.trim())));
  const rows = [];
  for (const stamp of stamps) {
    let row = stamp.parentElement;
    for (let i = 0; i < 6 && row; i++, row = row.parentElement) {
      const className = String(row.className || '');
      // PDD renders the timestamp and speaker inside a small
      // `message-header` node nested in the real message item.  Treating
      // that header as the row loses the actual message body, because its
      // innerText contains only the sender name.  Keep walking upward until
      // the enclosing item/content node is reached.
      const headerOnly = /(?:^|[\s_-])message-header(?:$|[\s_-])/i.test(className)
        && !/(?:message-item|record-item|chat-item|message-content|content)/i.test(className);
      if (headerOnly) continue;
      const text = row.innerText || '';
      if ((text.match(/20\d\d[-/]\d\d[-/]\d\d\s+\d\d:\d\d/g) || []).length > 1) break;
      const rest = text.replace(stamp.textContent.trim(), '').trim();
      if (rest.length > 1 && (row.querySelector('img') || /message|chat.*item|record.*item/i.test(className) || i >= 3)) {
        const lines = rest.split('\n').map((s) => s.trim()).filter(Boolean);
        const speaker = lines[0] || '';
        const sameShopSeller = sellerNamePrefix
          && speaker.replace(/\s+/gu, '').startsWith(sellerNamePrefix);
        const role = /系统消息/.test(speaker) ? 'system'
          : /buyer|customer|consumer/i.test(row.className || '') || /[*＊]/.test(speaker) ? 'buyer'
          : /seller|service|merchant/i.test(className) || /客服|旗舰|专营|专卖|小店|官方|护理|海外|居家/.test(speaker)
            || sameShopSeller ? 'seller' : 'unknown';
        const images = [...row.querySelectorAll('img')].filter((img) => {
          const box = img.getBoundingClientRect();
          return box.width >= 70 && box.height >= 50 && !/avatar|head|icon|emoji/i.test(img.className || '');
        }).map((img) => ({ url: img.getAttribute('data-original') || img.getAttribute('data-src') || img.currentSrc || img.src,
          loaded: img.complete && img.naturalWidth > 0, width: img.naturalWidth, height: img.naturalHeight }));
        // Some chat rows do not render a separate speaker line.  Never discard
        // the first line in that case: it may be the actual message body.
        const hasSpeakerLine = role !== 'unknown' || /^(买家|客户|客服|商家|系统消息)/.test(speaker);
        const text = ((hasSpeakerLine ? lines.slice(1) : lines).join('\n').trim() || rest.trim());
        rows.push({ speaker: hasSpeakerLine ? speaker : '', role, timestamp: stamp.textContent.trim(), text, rawText: rest, images,
          unsupportedMedia: Boolean(row.querySelector('audio,video') || /\[语音\]|\[视频\]/.test(rest)),
          sourceClass: String(row.className || '') });
        break;
      }
    }
  }
  const scrollers = [...document.querySelectorAll('div')].filter((el) => visible(el) && el.scrollHeight > el.clientHeight + 15
    && el.clientHeight > 100 && /auto|scroll/.test(getComputedStyle(el).overflowY));
  const scroll = scrollers.filter((el) => stamps.some((stamp) => el.contains(stamp))).sort((a, b) => a.clientWidth - b.clientWidth)[0];
  if (scroll) scroll.setAttribute('data-pdd-chat-scroll', 'true');
  return { rows, hasScroll: Boolean(scroll), atBottom: !scroll || scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 5,
    totalHeight: scroll?.scrollHeight || 0, scrollTop: scroll?.scrollTop || 0,
    empty: /暂无聊天记录|暂无数据|没有查询到|无聊天记录/.test(document.body.innerText),
    loading: Boolean([...document.querySelectorAll('[class*="loading"],[class*="spin-spinning"]')].find(visible)) };
}

export async function collectConversation({ page, shopId, orderNumber, platformCaseKey, scenarioCode = null, workOrderType = null, orderFacts,
  expectedShopName = '',
  beforeAction = async () => {}, onProgress = async () => {}, maxDurationMs = 300000 }) {
  const issues = [], messages = new Map(), images = new Map(), coverage = [];
  const imageAttempts = new Map(), imageFailures = new Map();
  let imageBytes = 0;
  const started = Date.now(), to = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const from = orderFacts.orderDate || orderDate(orderNumber);
  const sellerNamePrefix = String(expectedShopName || '').replace(/\s+/gu, '')
    .replace(/(?:官方旗舰店|旗舰店|官方店|专营店|专卖店|店铺)$/u, '');
  const verifiedSellerNamePrefix = sellerNamePrefix.length >= 6
    && /\p{Script=Han}{2}/u.test(sellerNamePrefix) ? sellerNamePrefix : '';
  const windows = dateWindows(from, to);
  if (!windows.length) issues.push('订单日期无法确定，未确认聊天覆盖范围');
  const tick = async (stage) => { await beforeAction(page, stage); await onProgress(stage); if (Date.now() - started > maxDurationMs) throw new Error('CHAT_COLLECTION_TIME_BUDGET'); };
  const firstVisible = async (locators) => {
    for (const locator of locators) {
      if (!locator) continue;
      for (let i = 0; i < await locator.count(); i++) if (await locator.nth(i).isVisible()) return locator.nth(i);
    }
    return null;
  };
  try {
    await tick('chat-query-open');
    await page.goto('https://mms.pinduoduo.com/mms-chat/search?msfrom=mms_sidenav', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await tick('chat-query-ready');
    await page.getByText(/按订单[\/／]违规会话编号/).first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    const radio = await firstVisible([
      page.getByText(/按订单[\/／]违规会话编号查询/),
      page.getByRole('radio', { name: /按订单/ }),
      page.locator('label').filter({ hasText: /按订单[\/／]违规会话编号/ }),
      page.locator('input[type="radio"][aria-label*="按订单"], input[type="radio"][title*="按订单"]'),
    ]);
    if (!radio) throw new Error('CHAT_ORDER_QUERY_MODE_MISSING');
    await radio.click();
    const input = await firstVisible([page.getByRole('textbox', { name: /订单.*违规会话编号/ }), page.locator('input[placeholder*="订单"],input[placeholder*="会话"]')]);
    if (!input) throw new Error('CHAT_ORDER_INPUT_MISSING');
    await input.fill(orderNumber);
    if (await input.inputValue() !== orderNumber) throw new Error('CHAT_ORDER_INPUT_MISMATCH');
    for (const range of windows) {
      let sourceRange = range;
      await tick('chat-date-range');
      const allInputs = page.locator('input:visible');
      const dateInputs = [];
      for (let i = 0; i < await allInputs.count(); i++) {
        const value = await allInputs.nth(i).inputValue().catch(() => '');
        const placeholder = await allInputs.nth(i).getAttribute('placeholder') || '';
        if (/20\d\d[-/]\d\d[-/]\d\d/.test(value) || /开始日期|结束日期/.test(placeholder)) dateInputs.push(allInputs.nth(i));
      }
      if (dateInputs.length === 2) {
        for (const [i, value] of [range.from, range.to].entries()) {
          await dateInputs[i].fill(value); await dateInputs[i].press('Enter');
          const actual = (await dateInputs[i].inputValue()).match(/20\d\d-\d\d-\d\d/g) || [];
          if (actual.length !== 1 || actual[0] !== value) throw new Error('CHAT_DATE_RANGE_NOT_APPLIED');
        }
      } else if (dateInputs.length === 1) {
        const current = await dateInputs[0].inputValue();
        const dates = current.match(/20\d\d-\d\d-\d\d/g) || [];
        const readonly = await dateInputs[0].getAttribute('readonly') !== null;
        if (readonly) {
          // Beast's range picker is not a text editor. Its existing range can
          // cover this order; retain the actual queried range in provenance.
          if (dates.length !== 2 || dates[0] > range.from || dates[1] < range.to) {
            throw new Error('CHAT_READONLY_DATE_RANGE_DOES_NOT_COVER_ORDER');
          }
          sourceRange = { from: dates[0], to: dates[1] };
        } else if (dates.length !== 2 || dates[0] !== range.from || dates[1] !== range.to) {
          await dateInputs[0].fill(`${range.from} ~ ${range.to}`); await dateInputs[0].press('Enter');
          const actual = (await dateInputs[0].inputValue()).match(/20\d\d-\d\d-\d\d/g) || [];
          if (actual.length !== 2 || actual[0] !== range.from || actual[1] !== range.to) throw new Error('CHAT_DATE_RANGE_NOT_APPLIED');
        }
      } else throw new Error('CHAT_DATE_RANGE_UNREADABLE');
      const query = await firstVisible([page.getByRole('button', { name: '查询', exact: true }), page.getByText('查询', { exact: true })]);
      if (!query) throw new Error('CHAT_QUERY_BUTTON_MISSING');
      await query.click(); await page.waitForTimeout(1500);
      const queriedDates = (await Promise.all(dateInputs.map((field) => field.inputValue())))
        .join(' ').match(/20\d\d-\d\d-\d\d/g) || [];
      if (queriedDates.length !== 2 || queriedDates[0] !== sourceRange.from || queriedDates[1] !== sourceRange.to) {
        throw new Error('CHAT_DATE_RANGE_CHANGED_AFTER_QUERY');
      }
      const readPagination = async () => page.evaluate(() => {
        const visible = (element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        };
        const text = document.body.innerText || '';
        const pageMatches = [
          text.match(/第\s*(\d+)\s*页\s*(?:\/\s*)?(?:共\s*)?(\d+)\s*页/u),
          text.match(/第\s*(\d+)\s*页\s*(?:\/|共)\s*(\d+)\s*页/u),
          text.match(/(?:页码|分页)\s*[:：]?\s*(\d+)\s*\/\s*(\d+)/u),
          text.match(/第\s*(\d+)\s*\/\s*(\d+)\s*页/u),
        ].find(Boolean);
        const totalItems = Number(text.match(/共有\s*(\d+)\s*条/u)?.[1] || 0);
        const pageSize = Number(
          text.match(/(?:每页|页大小|显示)\s*(\d+)\s*(?:条|条记录)(?:\/页)?/u)?.[1]
          || text.match(/(\d+)\s*条\/页/u)?.[1]
          || [...document.querySelectorAll('select,[role="combobox"],input')]
            .map((node) => String(node.value || node.textContent || '').match(/(\d+)\s*条\/页/u)?.[1])
            .find(Boolean)
          || 0,
        );
        const currentNode = [...document.querySelectorAll(
          '[aria-current="page"],.ant-pagination-item-active,.is-active,[class*="pagination" i] [class*="active" i]',
        )].find(visible);
        const currentFromNode = Number(String(currentNode?.textContent || '').trim());
        const current = Number(pageMatches?.[1]) || (Number.isInteger(currentFromNode) ? currentFromNode : 1);
        const total = Number(pageMatches?.[2])
          || (totalItems > 0 && pageSize > 0 ? Math.ceil(totalItems / pageSize) : 0)
          || Math.max(...[...document.querySelectorAll(
          '.ant-pagination-item,[class*="pagination" i] li,[class*="pagination" i] button',
        )].filter(visible).map((node) => Number(String(node.textContent || '').trim()))
          .filter((value) => Number.isInteger(value) && value > 0 && value < 1000), 1);
        const result = { current: Math.max(1, current), total: Math.max(1, total), totalItems, pageSize };
        return result;
      }).catch(() => ({ current: 1, total: 1 }));
      const isEnabled = async (locator) => Boolean(locator)
        && await locator.isEnabled().catch(() => false)
        && await locator.getAttribute('aria-disabled').then((value) => value !== 'true').catch(() => true)
        && !/disabled/u.test(await locator.getAttribute('class').catch(() => '') || '');
      const clickPagination = async (control) => {
        try {
          await control.click({ timeout: 3_000 });
          return false;
        } catch (error) {
          const message = String(error?.message || error);
          if (!/intercepts pointer events/u.test(message)
            || !/umd_kits_home_entry/u.test(message)) throw error;
          await tick('chat-pagination-overlay-recovery');
          const blocker = page.locator('#umd_kits_home_entry').getByText('查看全部', { exact: true });
          if (!await blocker.isVisible().catch(() => false)
            || !await control.isVisible().catch(() => false)
            || !await isEnabled(control)) throw error;
          // Only the known PDD home widget may block this read-only pager.
          await control.evaluate((element) => element.click());
          return true;
        }
      };
      const paginationControl = async (direction) => firstVisible(['previous', 'backward'].includes(direction) ? [
        page.locator('li.ant-pagination-prev,button[aria-label="Previous Page"],[aria-label*="上一页"],[title="上一页"], [class*="pagination" i] [class*="prev" i]'),
        page.getByRole('button', { name: /上一页/ }),
        page.locator('[class*="pagination" i]').locator('a:visible,button:visible,[role="button"]:visible,[tabindex="0"]:visible').filter({ hasText: /^(?:‹|<|上一页)$/u }),
      ] : [
        page.locator('li.ant-pagination-next,button[aria-label="Next Page"],[aria-label*="下一页"],[title="下一页"], [class*="pagination" i] [class*="next" i]'),
        page.getByRole('button', { name: /下一页/ }),
        page.locator('[class*="pagination" i]').locator('a:visible,button:visible,[role="button"]:visible,[tabindex="0"]:visible').filter({ hasText: /^(?:›|>|下一页)$/u }),
      ]);
      const numberedPageControl = async (number) => firstVisible([
        page.locator(`li.ant-pagination-item-${number}:visible`),
        page.locator('[class*="pagination" i]').locator('li:visible,button:visible,a:visible,[role="button"]:visible,[tabindex="0"]:visible').filter({ hasText: new RegExp(`^\\s*${number}\\s*$`, 'u') }),
        page.locator('li:visible,button:visible,a:visible,[role="button"]:visible,[tabindex="0"]:visible').filter({ hasText: new RegExp(`^\\s*${number}\\s*$`, 'u') }),
        page.getByText(String(number), { exact: true }),
      ]);
      const initialPagination = await readPagination();
      await onProgress(`chat-pagination:${JSON.stringify(initialPagination)}`);
      let pageNumber = initialPagination.current;
      let direction = 'forward';
      const nextBeforeSeek = await paginationControl('next');
      const hasNextBeforeSeek = Boolean(nextBeforeSeek && await isEnabled(nextBeforeSeek));
      const paginationNeedsSeek = (initialPagination.total > 1
        && initialPagination.current < initialPagination.total)
        || (initialPagination.total <= 1 && hasNextBeforeSeek);
      if (paginationNeedsSeek) {
        const last = await firstVisible([
          await numberedPageControl(initialPagination.total),
          page.getByRole('button', { name: /最后一页/ }),
          page.locator('li.ant-pagination-item:last-of-type:visible').filter({ hasText: new RegExp(`^\\s*${initialPagination.total}\\s*$`, 'u') }),
        ]);
        let jumpedToLast = false;
        if (last && await isEnabled(last)) {
          const before = initialPagination.current;
          await clickPagination(last);
          await page.waitForTimeout(700);
          const after = await readPagination();
          if (after.current === initialPagination.total || after.current !== before) {
            pageNumber = after.current;
            direction = 'backward';
            jumpedToLast = true;
          }
        }
        if (!jumpedToLast) {
          // Some builds expose only next/previous. Walk to the end once, then
          // collect backwards so the newest messages are available first.
          let walked = initialPagination.current;
          while (true) {
            await tick('chat-pagination-seek');
            const next = await paginationControl('next');
            if (!next || !await isEnabled(next)) break;
            const before = await readPagination();
            await clickPagination(next); await page.waitForTimeout(700);
            const after = await readPagination();
            if (after.current <= before.current && after.current === walked) break;
            walked = after.current > before.current ? after.current : walked + 1;
            if (walked > 1000) { issues.push('分页超过单次采集预算'); break; }
          }
          if (walked > initialPagination.current) { pageNumber = walked; direction = 'backward'; }
        }
      }
      await onProgress(`chat-direction:${direction}:${pageNumber}`);
      const pageHashes = new Set();
      while (true) {
        await tick('chat-messages');
        const initial = await page.evaluate(readChatDom, { sellerNamePrefix: verifiedSellerNamePrefix });
        // The chat virtual list can be replaced between the DOM snapshot and
        // the scroll operation. Query inside the page instead of waiting on a
        // stale locator, otherwise Playwright can spend 30 seconds waiting for
        // an attribute that was removed during a normal re-render.
        if (initial.hasScroll) await page.evaluate(() => {
          const el = document.querySelector('[data-pdd-chat-scroll="true"]');
          if (el) el.scrollTop = 0;
        }).catch(() => {});
        let bottomPasses = 0, signature = ''; const pageIds = new Set();
        for (let pass = 0; pass < 500; pass++) {
          await tick('chat-scroll');
          let state = await page.evaluate(readChatDom, { sellerNamePrefix: verifiedSellerNamePrefix });
          if (state.loading) { await page.waitForTimeout(600); continue; }
          for (const row of state.rows) {
            const id = digest({ speaker: row.speaker, timestamp: row.timestamp, text: row.text, images: row.images.map((a) => a.url) }).slice(0, 32);
            pageIds.add(id);
            // A virtual/lazy row can be encountered before its image is loaded.
            // Revisit missing attachments, with a bounded per-image request count.
            if (messages.has(id) && messages.get(id).attachments.every((a) => a.status === 'ready')) continue;
            const attachments = [];
            for (const image of row.images) {
              const attachmentId = digest(image.url).slice(0, 32);
              let status = 'missing';
              if (images.has(attachmentId)) status = 'ready';
              else if (images.size < 80 && (imageAttempts.get(attachmentId) || 0) < 2) {
                await tick('chat-image-read');
                imageAttempts.set(attachmentId, (imageAttempts.get(attachmentId) || 0) + 1);
                // Persist bounded diagnostics without image URLs, cookies or
                // query tokens so a missing attachment has an actionable cause.
                const failure = { code: 'IMAGE_REQUEST_FAILED', attempt: imageAttempts.get(attachmentId),
                  domLoaded: image.loaded === true, width: image.width, height: image.height };
                try {
                  const url = new URL(image.url, page.url());
                  failure.protocol = url.protocol; failure.host = url.hostname;
                  if (!['https:', 'http:'].includes(url.protocol)
                    || !(url.hostname === 'chat-img.pddugc.com'
                      || /(?:^|\.)(?:pinduoduo\.com|pddpic\.com|yangkeduo\.com)$/.test(url.hostname))) {
                    failure.code = 'UNSUPPORTED_IMAGE_SOURCE'; throw new Error(failure.code);
                  }
                  const response = await page.request.get(url.href, { timeout: 15000 });
                  const bytes = await response.body(), mime = (response.headers()['content-type'] || '').split(';')[0];
                  failure.httpStatus = response.status(); failure.mime = mime; failure.bytes = bytes.length;
                  if (!response.ok() || !/^image\/(png|jpeg|webp|gif)$/.test(mime) || bytes.length > 4 * 1024 * 1024
                    || imageBytes + bytes.length > 16 * 1024 * 1024) {
                    failure.code = !response.ok() ? 'IMAGE_HTTP_ERROR' : !/^image\/(png|jpeg|webp|gif)$/.test(mime)
                      ? 'IMAGE_UNSUPPORTED_MIME' : 'IMAGE_SIZE_BUDGET';
                    throw new Error(failure.code);
                  }
                  imageBytes += bytes.length;
                  images.set(attachmentId, { id: attachmentId, mime, base64: bytes.toString('base64') }); status = 'ready';
                  imageFailures.delete(attachmentId);
                } catch (error) {
                  if (/Verification|Login|RateLimit/.test(error.constructor?.name || '')) throw error;
                  if (/timeout/i.test(String(error.message || ''))) failure.code = 'IMAGE_REQUEST_TIMEOUT';
                  imageFailures.set(attachmentId, failure);
                  // Completeness is evaluated after retries; a transient download
                  // failure must not taint a subsequently recovered attachment.
                }
              }
              attachments.push({ id: attachmentId, status });
            }
            if (row.unsupportedMedia) issues.push('聊天包含尚未解析的语音或视频');
            if (row.role === 'unknown') issues.push('部分消息发言人角色无法确认');
            messages.set(id, { id, speaker: row.speaker, role: row.role, timestamp: row.timestamp, text: row.text || row.rawText || '', rawText: row.rawText || row.text || '',
              attachments, source: { page: pageNumber, range: sourceRange, class: row.sourceClass }, unsupportedMedia: row.unsupportedMedia });
          }
          const nextSignature = digest([...pageIds]);
          if (state.atBottom && signature === nextSignature) bottomPasses++; else bottomPasses = 0;
          signature = nextSignature;
          if (bottomPasses >= 2) break;
          if (state.hasScroll) await page.evaluate(() => {
            const el = document.querySelector('[data-pdd-chat-scroll="true"]');
            if (el) el.scrollTop += Math.max(100, Math.floor(el.clientHeight * 0.75));
          }).catch(() => {});
          await page.waitForTimeout(400);
          if (pass === 499) issues.push('聊天滚动未到达确认终点');
        }
        if (!pageIds.size) { if (!(await page.evaluate(readChatDom, { sellerNamePrefix: verifiedSellerNamePrefix })).empty) issues.push('查询结果结构未识别或尚未加载'); break; }
        if (pageHashes.has(signature)) { issues.push('翻页后聊天内容未变化'); break; }
        pageHashes.add(signature);
        if (direction === 'backward' && pageNumber <= 1) break;
        // Beast's current paginator renders the previous arrow as an icon-only
        // button without a stable aria-label/title.  The adjacent page number
        // is a safer backwards control and remains visible around the active
        // page; retain the arrow as a fallback for older builds.
        const control = direction === 'backward' && pageNumber > 1
          ? await firstVisible([
            await numberedPageControl(pageNumber - 1),
            await paginationControl(direction),
          ])
          : await paginationControl(direction);
        await onProgress(`chat-control:${direction}:${Boolean(control)}:${control ? await isEnabled(control) : false}:${control ? await control.getAttribute('disabled').catch(() => null) : null}:${control ? await control.innerText().catch(() => '') : ''}`);
        if (!control || !await isEnabled(control)) {
          if (direction === 'backward' && pageNumber > 1) {
            issues.push('存在未采集的前页记录但上一页按钮不可用');
          } else if (direction === 'forward') {
            const text = await page.locator('body').innerText();
            if (/共\s*\d+\s*页/u.test(text) && !/共\s*1\s*页/u.test(text)) issues.push('存在多页记录但未识别下一页按钮');
          }
          break;
        }
        const beforePagination = await readPagination();
        const recoveredOverlay = await clickPagination(control);
        await page.waitForTimeout(1000);
        const afterPagination = await readPagination();
        if (recoveredOverlay && afterPagination.current === beforePagination.current) {
          issues.push('聊天分页被悬浮窗遮挡，恢复点击后页码仍未变化');
          break;
        }
        const expectedPage = direction === 'backward'
          ? Math.max(1, pageNumber - 1)
          : pageNumber + 1;
        pageNumber = afterPagination.current !== beforePagination.current
          ? afterPagination.current
          : expectedPage;
        if (pageNumber > 100) { issues.push('分页超过单次采集预算'); break; }
      }
      coverage.push(range);
    }
  } catch (error) {
    // Let the existing browser coordinator retain authentication/challenge locks.
    if (/Verification|Login|RateLimit/.test(error.constructor?.name || '')) throw error;
    issues.push(String(error.message || 'CHAT_COLLECTION_FAILED'));
  }
  // The same image can occur in multiple messages. A later successful read
  // resolves every reference, without changing message IDs or provenance.
  for (const message of messages.values()) {
    for (const attachment of message.attachments) {
      attachment.status = images.has(attachment.id) ? 'ready' : 'missing';
      if (attachment.status === 'missing') attachment.failure = imageFailures.get(attachment.id) || { code: 'IMAGE_COUNT_BUDGET' };
      if (attachment.status !== 'ready') issues.push('存在缺失图片或图片数量超过单次采集预算');
    }
  }
  const ordered = [...messages.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const snapshot = { version: 1, shopId, orderNumber, platformCaseKey, scenarioCode, workOrderType, orderFacts, messages: ordered,
    completeness: { complete: issues.length === 0 && coverage.length === windows.length && windows.length > 0,
      issues: [...new Set(issues)], requested: { from, to }, covered: coverage }, collectedAt: new Date().toISOString() };
  snapshot.contentHash = digest({ shopId, orderNumber, orderFacts, messages: ordered, completeness: snapshot.completeness });
  return { snapshot, images: [...images.values()] };
}
