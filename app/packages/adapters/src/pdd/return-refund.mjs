import crypto from 'node:crypto';

import { PDD_SESSION_MIN_USABLE_MS } from '../browser-auth-state.mjs';
import { isPddLoginUrl } from '../browser-runtime-state.mjs';
import {
  clickPddActionWithoutForegroundPopup,
  clickPddDetailInBackground,
} from './background-popup.mjs';
import {
  DEFAULT_PDD_RENDER_WAIT_MS,
  PddRenderWaitTimeoutError,
  hasVisiblePddLoadingState,
  waitForPddRenderedResult,
} from './render-wait.mjs';
import { clickVisiblePddStalePageRefresh } from './stale-page-refresh.mjs';
import { detectHumanVerification } from '../verification-detector/detect.mjs';

export const RETURN_REFUND_SCENARIO_CODE = 'return-refund';
export const RETURN_REFUND_WORK_ORDER_TYPE = '退货退款';
export const RETURN_REFUND_REQUIRED_STATUS = '待商家确认收货';
export const RETURN_REFUND_REQUIRED_STATUS_KEYWORD = '待商家';
export const RETURN_REFUND_REQUIRED_CITY = '长沙';
export const RETURN_REFUND_REQUIRED_DESTINATIONS = ['长沙', '衡水冀州'];
export const RETURN_REFUND_MAX_AMOUNT = 500;
export const RETURN_REFUND_MAX_LOGISTICS_AGE_HOURS = 72;
export const RETURN_REFUND_MAX_TRANSIT_SPAN_HOURS = 72;
export const RETURN_REFUND_NO_LOGISTICS_WAIT_HOURS = 72;
export const RETURN_REFUND_WAIT_RECHECK_MS = 4 * 60 * 60_000;
export const RETURN_REFUND_VERIFICATION_RECHECK_MS = 10 * 60_000;
export const RETURN_REFUND_UNKNOWN_RECHECK_MS = 10 * 60_000;
export const RETURN_REFUND_UNKNOWN_EFFECT_MIN_AGE_MS = 30 * 60_000;
export const RETURN_REFUND_UNKNOWN_PROOF_GAP_MS = 5 * 60_000;
export const RETURN_REFUND_MIN_PDD_SESSION_RUNWAY_MS = PDD_SESSION_MIN_USABLE_MS;
export const RETURN_REFUND_CONFIRM_ENABLE_WAIT_MS = 30_000;
export const RETURN_REFUND_MANUAL_REVIEW_RECHECK_MS = 30 * 60_000;
export const RETURN_REFUND_PAGE_ERROR_RECHECK_MS = 5 * 60_000;
// A scan that needed human verification can wait an hour before its next
// batch. Keep the unchanged list eligible for that continuation, while the
// exact page, URL, cursor, row count and row hash remain mandatory.
export const RETURN_REFUND_SCAN_RESUME_MAX_AGE_MS = 75 * 60_000;
export const RETURN_REFUND_WORKBENCH_URL = 'https://mms.pinduoduo.com/aftersales/aftersale_list?msfrom=mms_sidenav';

export const inspectReturnRefundPddSessionRunway = (cookies, nowMs = Date.now()) => {
  const sessionCookies = (cookies || []).filter((cookie) => (
    /^windows_app_shop_token(?:_\d+)?$/iu.test(String(cookie?.name || ''))
      && /(?:^|\.)pinduoduo\.com$/iu.test(String(cookie?.domain || '').replace(/^\./u, ''))
  ));
  if (!sessionCookies.length) return { status: 'missing', remainingMs: null };
  if (sessionCookies.some((cookie) => Number(cookie.expires) <= 0)) {
    return { status: 'sufficient', remainingMs: null };
  }
  const latestExpiryMs = Math.max(...sessionCookies.map((cookie) => Number(cookie.expires) * 1000));
  if (!Number.isFinite(latestExpiryMs)) return { status: 'unavailable', remainingMs: null };
  const remainingMs = Math.max(0, latestExpiryMs - nowMs);
  return {
    status: remainingMs <= 0 ? 'expired'
      : remainingMs < RETURN_REFUND_MIN_PDD_SESSION_RUNWAY_MS ? 'expiring' : 'sufficient',
    remainingMs,
  };
};

export class ReturnRefundTransientPageError extends Error {
  constructor(kind, message, { retryAfterMs = RETURN_REFUND_PAGE_ERROR_RECHECK_MS } = {}) {
    super(message);
    this.name = 'ReturnRefundTransientPageError';
    this.code = kind === 'rate-limited'
      ? 'PDD_RATE_LIMITED'
      : 'PDD_RETURN_REFUND_DETAIL_UNAVAILABLE';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
    this.retryable = true;
  }
}

export class ReturnRefundTerminalNotFoundError extends Error {
  constructor(message, { facts = null, signals = [] } = {}) {
    super(message);
    this.name = 'ReturnRefundTerminalNotFoundError';
    this.code = 'PDD_RETURN_REFUND_NOT_FOUND';
    this.kind = 'not-found';
    this.retryable = false;
    this.terminal = true;
    this.facts = facts;
    this.signals = signals;
  }
}

export const classifyReturnRefundUnexpectedFailure = (error, {
  externalEffectStarted = false,
  now = Date.now(),
} = {}) => {
  const message = String(error?.message || error || 'unknown return-refund error');
  if (error?.code === 'PDD_RETURN_REFUND_NOT_FOUND') {
    return {
      outcome: 'skipped-not-found',
      riskLevel: null,
      reasons: ['拼多多明确提示订单或售后单不存在，已永久跳过'],
      error: message,
      rules: {},
      terminal: true,
      completionMethod: 'return-refund-not-found',
      ...(error?.signals?.length ? { notFoundSignals: error.signals } : {}),
    };
  }
  const verificationRequired = error?.name === 'HumanVerificationRequiredError'
    || ['PDD_HUMAN_VERIFICATION_REQUIRED', 'PDD_LOGIN_REQUIRED'].includes(error?.code)
    || /检测到人工验证|人工验证|验证码|pdd-manual-login|human verification/iu.test(message);
  const retryAfterMs = Number(error?.retryAfterMs);
  const nextCheckAt = !verificationRequired && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? new Date(now + retryAfterMs).toISOString()
    : null;
  const rateLimited = error?.code === 'PDD_RATE_LIMITED';
  return {
    outcome: verificationRequired ? 'verification-required' : 'page-error',
    riskLevel: 'high',
    reasons: [verificationRequired
      ? `退款页面仍有人工验证，禁止重复点击：${message}`
      : externalEffectStarted
        ? `退款执行凭证仍待只读复核，不会重复点击：${message}`
      : rateLimited
        ? `拼多多页面限流，未执行退款，等待平台恢复后自动重试：${message}`
        : `退款页面加载或读取失败，未执行退款，将自动重试：${message}`],
    error: message,
    rules: {},
    ...(nextCheckAt ? { nextCheckAt } : {}),
    ...(error?.kind ? { retryKind: error.kind } : {}),
  };
};

const maybeBringReturnRefundPageToFront = async (page) => {
  const foregroundMode = String(process.env.WORKFLOW_FOREGROUND_MODE || 'manual-only').trim().toLowerCase();
  if (foregroundMode !== 'always' || !page || page.isClosed?.()) return false;
  try {
    await page.bringToFront();
    return true;
  } catch {
    return false;
  }
};

export const normalizeReturnRefundScanCursor = (value = {}) => ({
  page: Math.max(1, Math.min(10_000, Math.floor(Number(value?.page) || 1))),
  itemOffset: Math.max(0, Math.min(999, Math.floor(Number(value?.itemOffset) || 0))),
});

const normalizeText = (value) => String(value || '').normalize('NFKC').replace(/\u00a0/g, ' ').trim();
const compactText = (value) => normalizeText(value).replace(/\s+/g, ' ');
export const detectReturnRefundTransientPageState = (bodyText) => {
  const text = compactText(bodyText);
  if (/操作太过频繁[，,！!\s]*请稍后再试/u.test(text)) {
    return {
      kind: 'rate-limited',
      message: '拼多多页面提示“操作太过频繁，请稍后再试”',
    };
  }
  const unavailableSignals = [
    '未查询到相关订单信息',
    '订单不存在',
    '售后单不存在',
  ].filter((signal) => text.includes(signal));
  return unavailableSignals.length ? {
    kind: 'not-found',
    signals: unavailableSignals,
    message: `拼多多明确提示售后不存在：${unavailableSignals.join('、')}`,
  } : null;
};

// PDD's workbench can keep subresources open for a long time even after the
// target document has committed. Waiting for DOMContentLoaded here turns a
// usable page into a false page-error. Commit first, then let the existing
// rendered-content checks decide whether the page is actually ready.
const navigateReturnRefundPage = async (page, url, {
  timeout = 45_000,
  expectedPath = null,
} = {}) => {
  let navigationError = null;
  try {
    await page.goto(url, { waitUntil: 'commit', timeout });
  } catch (error) {
    navigationError = error;
  }
  const currentUrl = page.url();
  let pathMatches = false;
  try {
    const current = new URL(currentUrl);
    const expected = new URL(url);
    pathMatches = current.pathname === (expectedPath || expected.pathname);
  } catch {
    pathMatches = false;
  }
  if (navigationError && !pathMatches) throw navigationError;
  return { navigationError, url: currentUrl };
};
const returnRefundTerminalStatusPattern = /(?:退款成功|退款完成|退款失败|退款申请(?:已)?(?:撤销|取消|关闭)|退款(?:已)?(?:撤销|取消|关闭)|售后完成|售后关闭|售后申请(?:已)?(?:撤销|取消|关闭)|售后(?:已)?(?:撤销|取消)|平台已退款|已退款|已关闭|交易关闭)/u;
const returnRefundStandaloneTerminalStatusPattern = /^(?:(?:(?:商家)?同意退款[,，]?\s*)?(?:本单)?(?:退款成功|退款完成)|退款失败|此次退款失败|退款申请(?:已)?(?:撤销|取消|关闭)|退款(?:已)?(?:撤销|取消|关闭)|售后完成|售后关闭|售后申请(?:已)?(?:撤销|取消|关闭)|售后(?:已)?(?:撤销|取消)|平台已退款|已退款|已关闭|交易关闭)$/u;
// PDD sometimes adds an explanatory sentence around a terminal status, for
// example: "因消费者信誉良好,本单已极速退款成功,请商家及时验货". Keep the
// strict standalone check for generic navigation text, but accept an expanded
// status only when it contains explicit order/completion context.
const returnRefundExpandedTerminalStatusPattern = /(?:本单|订单|此次|商家同意|消费者信誉良好|(?:已|已经)[^\n]{0,12})[^\n]{0,16}(?:退款成功|退款完成|售后完成|售后关闭|平台已退款|已退款)/u;
const returnRefundPendingStatusPattern = /(?:待商家(?:处理|确认收货)|待消费者(?:寄出退货|寄货)|待买家(?:处理|寄出退货|发货)|买家已发货|商家处理中|待快递退回后退款|退款中)/u;
const returnRefundMerchantPendingStatusPattern = /(?:买家已发货[^\n]{0,20}待商家处理|待商家确认收货)/u;
const returnRefundCounterpartyPendingStatusPattern = /(?:待消费者(?:处理|寄出退货|寄货)|待买家(?:处理|处理中|寄出退货|发货))/u;
const returnRefundReadableStatusPattern = new RegExp(
  `(?:${returnRefundPendingStatusPattern.source}|${returnRefundTerminalStatusPattern.source})`,
  'u',
);
const labeledAftersaleStatusSources = new Set([
  'label-inline',
  'label-following-line',
  'inline-body-fallback',
]);
const firstMatch = (text, patterns) => {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return compactText(match[1]);
  }
  return null;
};

const extractLabeledValue = (lines, {
  labelPattern,
  valuePattern,
  maxLookahead = 3,
} = {}) => {
  const inlinePattern = new RegExp(`^(?:${labelPattern.source})\\s*[:：]\\s*(.+)$`, 'u');
  const labelOnlyPattern = new RegExp(`^(?:${labelPattern.source})\\s*[:：]?\\s*$`, 'u');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inline = line.match(inlinePattern)?.[1];
    if (inline && valuePattern.test(inline)) {
      return { value: compactText(inline), source: 'label-inline', labelLine: index + 1, valueLine: index + 1 };
    }
    if (!labelOnlyPattern.test(line)) continue;
    for (let offset = 1; offset <= maxLookahead && index + offset < lines.length; offset += 1) {
      const candidate = lines[index + offset];
      if (valuePattern.test(candidate)) {
        return {
          value: compactText(candidate),
          source: 'label-following-line',
          labelLine: index + 1,
          valueLine: index + offset + 1,
        };
      }
    }
  }
  return { value: null, source: 'not-found', labelLine: null, valueLine: null };
};

export const parseRefundAmount = (value) => {
  const match = normalizeText(value).replaceAll(',', '').match(/-?\d+(?:\.\d{1,2})?/);
  if (!match) return null;
  const amount = Number(match[0]);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
};

export const parseBeijingDateTime = (value) => {
  const match = normalizeText(value).match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '00'] = match;
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:${second}+08:00`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const logisticsEventPattern = /(?:快件|包裹|物流|揽收|收取|收件|寄件|取件|到达|离开|发往|运输|中转|转运|派送|派件|投递|签收|驿站|代收|暂存|入库|出库|装车|卸车|交付|退回)/u;
const nonLogisticsEventPattern = /(?:闪电退货|售后申请|售后享受|系统自动同意|协商详情|聊天记录|退款申请|剩余处理时间)/u;

export const extractLogisticsTimeline = (value, {
  capturedAt = new Date().toISOString(),
} = {}) => {
  const lines = normalizeText(value).split(/\r?\n/).map(compactText).filter(Boolean);
  const items = [];
  const capturedAtMs = Date.parse(capturedAt);
  for (let index = 0; index < lines.length; index += 1) {
    const occurredAt = parseBeijingDateTime(lines[index]);
    if (!occurredAt) continue;
    const previous = lines[index - 1] || '';
    const next = lines[index + 1] || '';
    const text = !parseBeijingDateTime(previous) && !/^(物流轨迹|退货物流|发货物流|查看全部)$/.test(previous)
      ? previous
      : !parseBeijingDateTime(next) ? next : '';
    if (!text || !logisticsEventPattern.test(text) || nonLogisticsEventPattern.test(text)) continue;
    const occurredAtMs = Date.parse(occurredAt);
    if (Number.isFinite(capturedAtMs) && occurredAtMs > capturedAtMs + 5 * 60_000) continue;
    const signature = `${occurredAt}:${text}`;
    if (!items.some((item) => item.signature === signature)) items.push({ occurredAt, text, signature });
  }
  return items
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
    .map(({ signature, ...item }) => item);
};

const logisticsDestinationFacts = (timeline = []) => {
  const matches = [];
  for (const item of timeline) {
    const text = normalizeText(item?.text);
    if (!text) continue;
    if (text.includes('长沙')) matches.push({ destination: '长沙', occurredAt: item.occurredAt, text });
    if (text.includes('衡水') && text.includes('冀州')) {
      matches.push({ destination: '衡水冀州', occurredAt: item.occurredAt, text });
    }
  }
  const containsChangsha = matches.some((item) => item.destination === '长沙');
  const containsHengshuiJizhou = matches.some((item) => item.destination === '衡水冀州');
  return {
    containsChangsha,
    containsHengshuiJizhou,
    matched: containsChangsha || containsHengshuiJizhou,
    matchedDestinations: [
      ...(containsChangsha ? ['长沙'] : []),
      ...(containsHengshuiJizhou ? ['衡水冀州'] : []),
    ],
    matches,
  };
};

const isSubstantiveLogisticsEvent = (item) => Boolean(item?.text)
  && !/(?:消费者已填写物流单号|待快递公司返回物流信息|暂无物流信息)/u.test(item.text);

export const extractReturnRefundFacts = (bodyText, {
  detailUrl = null,
  actionButtonVisible = null,
  capturedAt = new Date().toISOString(),
  returnLogisticsText = null,
  returnLogisticsSource = null,
} = {}) => {
  const body = normalizeText(bodyText);
  const lines = body.split(/\r?\n/).map(compactText).filter(Boolean);
  const logisticsStart = body.search(/(?:^|\n)退货物流(?:\r?\n|$)/u);
  const logisticsTail = logisticsStart >= 0 ? body.slice(logisticsStart) : '';
  const logisticsEnd = logisticsTail.search(/\n(?:协商详情|聊天记录|常见问题|收货信息)(?:\r?\n|$)/u);
  const fallbackLogisticsSection = logisticsEnd > 0 ? logisticsTail.slice(0, logisticsEnd) : logisticsTail;
  const logisticsSection = typeof returnLogisticsText === 'string'
    ? normalizeText(returnLogisticsText)
    : fallbackLogisticsSection;
  const logisticsSourceConfirmed = returnLogisticsSource
    ? returnLogisticsSource.status === 'confirmed'
    : logisticsStart >= 0;
  const timeline = logisticsSourceConfirmed
    ? extractLogisticsTimeline(logisticsSection, { capturedAt })
    : [];
  const substantiveTimeline = timeline.filter(isSubstantiveLogisticsEvent);
  const latestLogisticsAt = substantiveTimeline[0]?.occurredAt || null;
  const earliestLogisticsAt = substantiveTimeline.at(-1)?.occurredAt || null;
  const orderNumberField = extractLabeledValue(lines, {
    labelPattern: /订单(?:编号|号)/u,
    valuePattern: /^[0-9A-Za-z-]{10,}$/u,
  });
  const aftersaleNumberField = extractLabeledValue(lines, {
    labelPattern: /售后(?:编号|编码)/u,
    valuePattern: /^[0-9A-Za-z-]{8,}$/u,
  });
  const refundAmountField = extractLabeledValue(lines, {
    labelPattern: /退款金额/u,
    valuePattern: /(?:[¥￥]\s*\d|\d+(?:\.\d{1,2})?\s*元)/u,
    maxLookahead: 4,
  });
  const aftersaleTypeField = extractLabeledValue(lines, {
    labelPattern: /售后类型/u,
    valuePattern: /^(?:退货退款|仅退款|换货|维修|补寄|退货换货)/u,
    maxLookahead: 4,
  });
  const logisticsLines = logisticsSection.split(/\r?\n/).map(compactText).filter(Boolean);
  const returnTrackingField = extractLabeledValue(logisticsLines.length ? logisticsLines : lines, {
    labelPattern: /(?:退货)?快递单号/u,
    valuePattern: /^[0-9A-Za-z-]{6,}$/u,
  });
  const returnCarrierField = extractLabeledValue(logisticsLines.length ? logisticsLines : lines, {
    labelPattern: /(?:退货快递公司|快递公司)/u,
    valuePattern: /^[^\s:：]{2,20}$/u,
  });
  const statusCandidateLines = lines.filter((line) => (
    /售后状态/u.test(line) || returnRefundReadableStatusPattern.test(line)
  )).slice(0, 30);
  const aftersaleStatusField = extractLabeledValue(lines, {
    labelPattern: /售后状态/u,
    valuePattern: returnRefundReadableStatusPattern,
    maxLookahead: 4,
  });
  const inlineAftersaleType = body.match(
    /售后类型\s*[:：]?\s*(退货退款|仅退款|换货|维修|补寄|退货换货)/u,
  )?.[1] || null;
  const inlineRefundAmount = body.match(
    /退款金额\s*[:：]?\s*((?:[¥￥]\s*)?\d+(?:\.\d{1,2})?\s*(?:元)?)/u,
  )?.[1] || null;
  const inlineStatusCandidate = body.match(
    /售后状态\s*[:：]?\s*([^\n]*?)(?=\s*(?:退货物流|退款金额|订单(?:编号|号)|售后(?:编号|编码)|协商详情|$))/u,
  )?.[1] || null;
  const inlineAftersaleStatus = returnRefundReadableStatusPattern.test(inlineStatusCandidate || '')
    ? compactText(inlineStatusCandidate)
    : null;
  // The current PDD detail page can concatenate the type and state into one
  // field, for example "退货退款待商家处理", while leaving 售后状态 empty.
  // Only trust the labeled type value here so the workbench navigation text
  // "待商家处理售后" cannot be mistaken for the current case state.
  const combinedTypeStatus = /待商家/u.test(aftersaleTypeField.value || '')
    ? aftersaleTypeField.value
    : null;
  const readableStatusCandidate = statusCandidateLines.find((line) => (
    line !== '待商家处理售后' && returnRefundReadableStatusPattern.test(line)
  ));
  const aftersaleStatus = aftersaleStatusField.value
    || combinedTypeStatus
    || inlineAftersaleStatus
    || readableStatusCandidate
    || null;
  const orderNumber = orderNumberField.value || firstMatch(body, [
    /订单编号\s*[:：]\s*([0-9A-Za-z-]{10,})/u,
    /订单号\s*[:：]\s*([0-9A-Za-z-]{10,})/u,
  ]);
  const aftersaleNumber = aftersaleNumberField.value || firstMatch(body, [
    /售后(?:编号|编码)\s*[:：]\s*([0-9A-Za-z-]{8,})/u,
  ]);
  const aftersaleTypeValue = aftersaleTypeField.value || inlineAftersaleType;
  const aftersaleType = /退货退款/u.test(aftersaleTypeValue || '')
    ? RETURN_REFUND_WORK_ORDER_TYPE
    : aftersaleTypeValue || null;
  const refundAmountValue = refundAmountField.value || inlineRefundAmount;
  const returnTrackingNumber = returnTrackingField.value || null;
  const returnCarrier = returnCarrierField.value || null;
  const destination = logisticsDestinationFacts(substantiveTimeline);
  const logisticsTransitSpanHours = latestLogisticsAt && earliestLogisticsAt
    ? Math.max(0, (Date.parse(latestLogisticsAt) - Date.parse(earliestLogisticsAt)) / 3_600_000)
    : null;
  return {
    orderNumber,
    aftersaleNumber,
    detailUrl,
    aftersaleType,
    aftersaleStatus: aftersaleStatus ? compactText(aftersaleStatus).replace(/^售后状态\s*[:：]\s*/u, '') : null,
    refundAmount: parseRefundAmount(refundAmountValue),
    returnCarrier,
    returnTrackingNumber,
    logisticsTimeline: timeline,
    latestLogisticsAt,
    earliestLogisticsAt,
    logisticsTransitSpanHours,
    logisticsContainsChangsha: logisticsSourceConfirmed && destination.containsChangsha,
    logisticsContainsHengshuiJizhou: logisticsSourceConfirmed && destination.containsHengshuiJizhou,
    logisticsDirectionMatched: logisticsSourceConfirmed && destination.matched,
    logisticsMatchedDestinations: logisticsSourceConfirmed ? destination.matchedDestinations : [],
    logisticsDirectionMatches: logisticsSourceConfirmed ? destination.matches : [],
    hasReturnLogistics: substantiveTimeline.length > 0,
    actionButtonVisible: typeof actionButtonVisible === 'boolean' ? actionButtonVisible : null,
    pageIndicatesCompleted: returnRefundTerminalStatusPattern.test(body),
    pageIndicatesPendingMerchant: /(?:待商家处理|待商家确认收货|买家已发货)/u.test(body),
    pageIndicatesPendingCounterparty: returnRefundCounterpartyPendingStatusPattern
      .test(aftersaleStatus || ''),
    evidence: {
      capturedAt,
      detailUrl,
      pageTextSha256: crypto.createHash('sha256').update(body).digest('hex'),
      extractedLineCount: lines.length,
      returnLogisticsSource: returnLogisticsSource || {
        status: logisticsSourceConfirmed ? 'confirmed' : 'not-found',
        strategy: logisticsSourceConfirmed ? 'body-section-fallback' : 'not-found',
        lineCount: logisticsSection.split(/\r?\n/).map(compactText).filter(Boolean).length,
        textSha256: logisticsSection
          ? crypto.createHash('sha256').update(logisticsSection).digest('hex')
          : null,
      },
      returnLogisticsPreview: logisticsSection.split(/\r?\n/)
        .map(compactText)
        .filter(Boolean)
        .slice(0, 40),
      statusCandidateLines,
      fieldSources: {
        orderNumber: orderNumberField,
        aftersaleNumber: aftersaleNumberField,
        aftersaleType: aftersaleTypeField.value
          ? aftersaleTypeField
          : inlineAftersaleType
            ? { source: 'inline-body-fallback', value: inlineAftersaleType }
            : aftersaleTypeField,
        refundAmount: refundAmountField.value
          ? refundAmountField
          : inlineRefundAmount
            ? { source: 'inline-body-fallback', value: inlineRefundAmount }
            : refundAmountField,
        returnCarrier: returnCarrierField,
        returnTrackingNumber: returnTrackingField,
        aftersaleStatus: aftersaleStatusField.value
          ? aftersaleStatusField
          : combinedTypeStatus
            ? { source: 'aftersale-type-line', value: compactText(combinedTypeStatus) }
          : inlineAftersaleStatus
            ? { source: 'inline-body-fallback', value: compactText(inlineAftersaleStatus) }
          : aftersaleStatus
            ? { source: 'status-text', value: compactText(aftersaleStatus) }
            : { source: 'not-found', value: null },
      },
    },
  };
};

const hasScopedReturnRefundTerminalStatus = (facts) => {
  const statusSource = facts?.evidence?.fieldSources?.aftersaleStatus?.source;
  const normalizedStatus = normalizeText(facts?.aftersaleStatus);
  return labeledAftersaleStatusSources.has(statusSource)
    ? returnRefundTerminalStatusPattern.test(normalizedStatus)
    : statusSource === 'status-text'
      && (
        returnRefundStandaloneTerminalStatusPattern.test(normalizedStatus)
        || (
          returnRefundExpandedTerminalStatusPattern.test(normalizedStatus)
          && !returnRefundPendingStatusPattern.test(normalizedStatus)
        )
      );
};

export const confirmsReturnRefundCompletion = (facts) => (
  facts?.actionButtonVisible === false
    && Boolean(facts.orderNumber && facts.aftersaleNumber)
    && hasScopedReturnRefundTerminalStatus(facts)
);

export const isAutomatedReturnRefundCompletion = (result = {}) => (
  result?.outcome === 'auto-refunded'
  || (
    result?.outcome === 'manual-completed'
    && result?.readOnlyReview === true
    && result?.completionMethod === 'return-refund-read-only-page-completed'
  )
);

export const evaluateReturnRefundRules = (facts, {
  now = Date.now(),
  firstDiscoveredAt = facts.firstDiscoveredAt || null,
} = {}) => {
  const numericNow = Number(now);
  const parsedNow = Date.parse(String(now));
  const nowMs = Number.isFinite(numericNow)
    ? numericNow
    : Number.isFinite(parsedNow) ? parsedNow : Date.now();
  const capturedAtMs = Date.parse(facts.evidence?.capturedAt || '');
  const firstDiscoveredAtMs = Date.parse(firstDiscoveredAt || '');
  const waitStartedAtMs = Number.isFinite(firstDiscoveredAtMs)
    ? firstDiscoveredAtMs
    : Number.isFinite(capturedAtMs) ? capturedAtMs : nowMs;
  const noLogisticsWaitHours = Number.isFinite(nowMs) && Number.isFinite(waitStartedAtMs)
    ? Math.max(0, (nowMs - waitStartedAtMs) / 3_600_000)
    : 0;
  const noLogisticsDeadlineAt = Number.isFinite(waitStartedAtMs)
    ? new Date(waitStartedAtMs + RETURN_REFUND_NO_LOGISTICS_WAIT_HOURS * 3_600_000).toISOString()
    : null;
  const latestLogisticsAtMs = Date.parse(facts.latestLogisticsAt || '');
  const earliestLogisticsAtMs = Date.parse(facts.earliestLogisticsAt || '');
  const logisticsAgeHours = Number.isFinite(nowMs) && Number.isFinite(latestLogisticsAtMs)
    ? Math.max(0, (nowMs - latestLogisticsAtMs) / 3_600_000)
    : null;
  const logisticsTransitSpanHours = Number.isFinite(Number(facts.logisticsTransitSpanHours))
    ? Math.max(0, Number(facts.logisticsTransitSpanHours))
    : Number.isFinite(latestLogisticsAtMs) && Number.isFinite(earliestLogisticsAtMs)
      ? Math.max(0, (latestLogisticsAtMs - earliestLogisticsAtMs) / 3_600_000)
      : facts.hasReturnLogistics ? 0 : null;
  const containsChangsha = facts.logisticsContainsChangsha === true;
  const containsHengshuiJizhou = facts.logisticsContainsHengshuiJizhou === true;
  // “衡水冀州” is one qualifying location: both words must occur in the
  // same substantive logistics node. Never trust a stale aggregate flag.
  const directionMatched = containsChangsha || containsHengshuiJizhou;
  const terminalStatusPresent = hasScopedReturnRefundTerminalStatus(facts);
  const rules = {
    type: {
      passed: facts.aftersaleType === RETURN_REFUND_WORK_ORDER_TYPE,
      actual: facts.aftersaleType,
      expected: RETURN_REFUND_WORK_ORDER_TYPE,
    },
    status: {
      passed: true,
      actual: facts.aftersaleStatus,
      expected: '售后状态仅作流程证据，不作为自动退款前置条件',
      required: false,
      legacyKeywordMatched: normalizeText(facts.aftersaleStatus)
        .includes(RETURN_REFUND_REQUIRED_STATUS_KEYWORD),
    },
    amount: {
      passed: Number.isFinite(facts.refundAmount) && facts.refundAmount < RETURN_REFUND_MAX_AMOUNT,
      actual: facts.refundAmount,
      expected: `<${RETURN_REFUND_MAX_AMOUNT}`,
    },
    nonTerminalPage: {
      passed: facts.actionButtonVisible === true && !terminalStatusPresent,
      actual: {
        actionButtonVisible: facts.actionButtonVisible,
        aftersaleStatus: facts.aftersaleStatus,
        pageIndicatesCompleted: facts.pageIndicatesCompleted === true,
        pageIndicatesPendingCounterparty: facts.pageIndicatesPendingCounterparty === true,
        scopedTerminalStatusPresent: terminalStatusPresent,
      },
      expected: '同意退款按钮可见且页面没有退款完成终态',
    },
    destination: {
      passed: directionMatched,
      actual: {
        containsChangsha,
        containsHengshuiJizhou,
        matchedDestinations: facts.logisticsMatchedDestinations || [
          ...(containsChangsha ? ['长沙'] : []),
          ...(containsHengshuiJizhou ? ['衡水冀州'] : []),
        ],
      },
      expected: '长沙或衡水冀州',
    },
    logisticsAge: {
      passed: logisticsAgeHours !== null && logisticsAgeHours <= RETURN_REFUND_MAX_LOGISTICS_AGE_HOURS,
      actualHours: logisticsAgeHours,
      expected: `<=${RETURN_REFUND_MAX_LOGISTICS_AGE_HOURS}`,
    },
    logisticsTransitSpan: {
      passed: logisticsTransitSpanHours !== null
        && logisticsTransitSpanHours > RETURN_REFUND_MAX_TRANSIT_SPAN_HOURS,
      actualHours: logisticsTransitSpanHours,
      expected: `>${RETURN_REFUND_MAX_TRANSIT_SPAN_HOURS}时未命中方向才转人工`,
    },
    noLogisticsWait: {
      passed: noLogisticsWaitHours <= RETURN_REFUND_NO_LOGISTICS_WAIT_HOURS,
      actualHours: noLogisticsWaitHours,
      expected: `<=${RETURN_REFUND_NO_LOGISTICS_WAIT_HOURS}`,
      startedAt: Number.isFinite(waitStartedAtMs) ? new Date(waitStartedAtMs).toISOString() : null,
      deadlineAt: noLogisticsDeadlineAt,
    },
  };

  if (confirmsReturnRefundCompletion(facts)) {
    return {
      outcome: 'manual-completed',
      riskLevel: null,
      reasons: [],
      rules,
      readOnlyReview: true,
      completionMethod: 'return-refund-read-only-page-completed',
    };
  }

  if (facts.actionButtonVisible !== true
    && facts.orderNumber
    && facts.aftersaleNumber
    && facts.pageIndicatesPendingCounterparty
    && !terminalStatusPresent) {
    return {
      outcome: 'wait-logistics',
      waitReasonCode: 'counterparty-action-pending',
      nextCheckAt: new Date(nowMs + RETURN_REFUND_WAIT_RECHECK_MS).toISOString(),
      riskLevel: null,
      reasons: ['售后当前等待买家或消费者处理，页面没有商家可执行的同意退款操作，4小时后只读复查'],
      rules,
    };
  }

  if (facts.actionButtonVisible === false) {
    if (facts.orderNumber && facts.aftersaleNumber
      && facts.pageIndicatesPendingMerchant
      && !facts.hasReturnLogistics) {
      if (rules.noLogisticsWait.passed) {
        return {
          outcome: 'wait-logistics',
          waitReasonCode: 'no-logistics-within-72-hours',
          nextCheckAt: noLogisticsDeadlineAt,
          riskLevel: null,
          reasons: ['尚未产生有效退货物流，等待首次发现满72小时后复查'],
          rules,
        };
      }
      return {
        outcome: 'wait-logistics',
        waitReasonCode: 'no-logistics-over-72-hours-action-unavailable',
        nextCheckAt: new Date(nowMs + RETURN_REFUND_WAIT_RECHECK_MS).toISOString(),
        riskLevel: null,
        reasons: ['首次发现超过72小时仍未产生有效退货物流，但页面没有可用退款按钮，4小时后只读复查'],
        rules,
      };
    }
    return {
      outcome: 'page-error',
      riskLevel: 'high',
      reasons: ['“同意退款”按钮不可见，但售后状态字段未显示明确完结状态'],
      rules,
    };
  }

  if (!facts.hasReturnLogistics) {
    if (rules.noLogisticsWait.passed) {
      return {
        outcome: 'wait-logistics',
        waitReasonCode: 'no-logistics-within-72-hours',
        nextCheckAt: noLogisticsDeadlineAt,
        riskLevel: null,
        reasons: ['尚未产生有效退货物流，等待首次发现满72小时后复查'],
        rules,
      };
    }
    const noLogisticsRuleFailures = [];
    if (!facts.orderNumber) noLogisticsRuleFailures.push('订单号读取失败');
    if (!facts.aftersaleNumber) noLogisticsRuleFailures.push('售后编号读取失败');
    if (!rules.type.passed) noLogisticsRuleFailures.push('售后类型不是退货退款');
    if (!Number.isFinite(facts.refundAmount)) noLogisticsRuleFailures.push('退款金额读取失败');
    else if (!rules.amount.passed) noLogisticsRuleFailures.push(`退款金额达到或超过${RETURN_REFUND_MAX_AMOUNT}元`);
    if (facts.actionButtonVisible !== true) noLogisticsRuleFailures.push('同意退款按钮不可用');
    else if (!rules.nonTerminalPage.passed) noLogisticsRuleFailures.push('页面出现退款完成终态，禁止重复退款');

    if (!noLogisticsRuleFailures.length) {
      return {
        outcome: 'auto-refund',
        riskLevel: null,
        reasons: [],
        policyReasonCode: 'return-refund-no-logistics-over-72-hours-auto-approved',
        rules,
      };
    }
    return {
      outcome: 'manual-review',
      manualReasonCode: 'return-refund-core-rule-failed',
      riskLevel: 'high',
      reasons: ['首次发现超过72小时仍未产生有效退货物流，但自动退款必要条件未全部满足', ...noLogisticsRuleFailures],
      rules,
    };
  }

  const autoRefundFailures = [];
  if (!facts.orderNumber) autoRefundFailures.push('订单号读取失败');
  if (!facts.aftersaleNumber) autoRefundFailures.push('售后编号读取失败');
  if (!rules.type.passed) autoRefundFailures.push('售后类型不是退货退款');
  if (!Number.isFinite(facts.refundAmount)) autoRefundFailures.push('退款金额读取失败');
  else if (!rules.amount.passed) autoRefundFailures.push(`退款金额达到或超过${RETURN_REFUND_MAX_AMOUNT}元`);
  if (!facts.latestLogisticsAt) autoRefundFailures.push('最新物流时间读取失败');
  if (facts.actionButtonVisible !== true) autoRefundFailures.push('同意退款按钮不可用');
  else if (!rules.nonTerminalPage.passed) autoRefundFailures.push('页面出现退款完成终态，禁止重复退款');

  // The live detail page is reread immediately before this decision, so stale
  // database evidence never authorizes the irreversible refund click.
  if (!rules.logisticsAge.passed) {
    if (!autoRefundFailures.length) {
      return {
        outcome: 'auto-refund',
        riskLevel: null,
        reasons: [],
        policyReasonCode: 'return-refund-stale-logistics-auto-approved',
        rules,
      };
    }
    return {
      outcome: 'manual-review',
      manualReasonCode: 'return-refund-latest-logistics-stale',
      riskLevel: 'high',
      reasons: [
        `当前时间距最新物流节点超过${RETURN_REFUND_MAX_LOGISTICS_AGE_HOURS}小时`,
        ...autoRefundFailures,
      ],
      rules,
    };
  }

  if (!rules.destination.passed) {
    if (!rules.logisticsTransitSpan.passed) {
      return {
        outcome: 'wait-logistics',
        waitReasonCode: 'direction-in-progress',
        nextCheckAt: new Date(nowMs + RETURN_REFUND_WAIT_RECHECK_MS).toISOString(),
        riskLevel: null,
        reasons: ['任一物流节点尚未出现长沙或衡水冀州，首尾物流跨度未超过72小时，等待下一轮检查'],
        rules,
      };
    }
    if (!autoRefundFailures.length) {
      return {
        outcome: 'auto-refund',
        riskLevel: null,
        reasons: [],
        policyReasonCode: 'return-refund-direction-timeout-auto-approved',
        rules,
      };
    }
    return {
      outcome: 'manual-review',
      manualReasonCode: 'return-refund-direction-timeout',
      riskLevel: 'high',
      reasons: [
        '物流首尾时间跨度超过72小时，任一节点仍未出现长沙或衡水冀州',
        ...autoRefundFailures,
      ],
      rules,
    };
  }

  return autoRefundFailures.length
    ? { outcome: 'manual-review', riskLevel: 'high', reasons: autoRefundFailures, rules }
    : { outcome: 'auto-refund', riskLevel: null, reasons: [], rules };
};

const visibleLocator = async (locator) => {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
};

export const findApproveRefundAction = async (page) => {
  const candidates = [
    page.getByRole('button', { name: '同意退款', exact: true }),
    page.getByRole('link', { name: '同意退款', exact: true }),
    page.locator('button, a, [role="button"], [role="link"]').filter({
      hasText: /^\s*同意退款\s*$/u,
    }),
    // PDD also renders this action as a small clickable text node after “其他操作”.
    page.getByText('同意退款', { exact: true }),
  ];
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      if (!await candidate.isEnabled().catch(() => true)) continue;
      return candidate;
    }
  }
  return null;
};

export const resolveReturnRefundReadOnlyReview = (facts, decision, { now = Date.now() } = {}) => {
  if (confirmsReturnRefundCompletion(facts)) {
    return {
      outcome: 'manual-completed',
      riskLevel: null,
      reasons: [],
      facts,
      rules: decision?.rules || {},
      readOnlyReview: true,
      completionMethod: 'return-refund-read-only-page-completed',
    };
  }
  return {
    outcome: 'manual-review',
    manualReasonCode: decision?.manualReasonCode || 'return-refund-manual-review',
    riskLevel: decision?.riskLevel || 'high',
    reasons: decision?.reasons?.length
      ? decision.reasons
      : ['只读复核未发现明确完结状态，保持人工处理且不执行退款操作'],
    nextCheckAt: new Date(now + RETURN_REFUND_MANUAL_REVIEW_RECHECK_MS).toISOString(),
    facts,
    rules: decision?.rules || {},
    readOnlyReview: true,
  };
};

const returnRefundConfirmationSelector = [
  '[role="dialog"]:visible',
  '[data-testid="beast-core-modal"]:visible',
  '[data-testid="beast-core-modal-container"]:visible',
  '.beast-core-modal:visible',
  '.ant-modal:visible',
  '[class*="Modal"]:visible',
  '[class*="modal"]:visible',
  '[class*="Popover"]:visible',
  '[class*="popover"]:visible',
].join(', ');

const returnRefundConfirmationTextPattern = /(?:确认(?:同意)?退款|是否(?:确认)?同意退款|是否同意退款|确认退款操作|退款将原路退回|确认后.{0,30}(?:退款|退货退款))/u;
const returnRefundConfirmationActionPattern = /^\s*(?:确认|确定|同意|确认退款|确认同意|同意退款)(?:\s*[(（]\s*\d{1,3}\s*(?:s|秒)\s*[)）])?\s*$/u;
const returnRefundAcknowledgementPattern = /^(?:我确认同意退款|我已确认同意退款)$/u;
const returnRefundDetailIdentityPattern = /(?:售后编号|售后编码)/u;
const returnRefundDetailFieldPattern = /(?:订单编号|售后类型|退货物流)/u;

const findReturnRefundAcknowledgement = async (container) => {
  const candidates = [
    container.getByRole('checkbox', { name: returnRefundAcknowledgementPattern, exact: true }),
    container.locator('[role="checkbox"], label').filter({
      hasText: /^\s*(?:我确认同意退款|我已确认同意退款)\s*$/u,
    }),
    container.getByText(returnRefundAcknowledgementPattern, { exact: true }),
    container.locator('input[type="checkbox"]'),
  ];
  for (const locator of candidates) {
    const acknowledgement = await visibleLocator(locator);
    if (acknowledgement) return acknowledgement;
  }
  return null;
};

const isReturnRefundAcknowledgementChecked = async (acknowledgement, {
  timeoutMs = 1_500,
} = {}) => {
  if (!acknowledgement) return false;
  return acknowledgement.evaluate((element) => {
    const control = element.matches('input[type="checkbox"], [role="checkbox"]')
      ? element
      : element.querySelector('input[type="checkbox"], [role="checkbox"]')
        || element.closest('label, [role="checkbox"]')?.querySelector('input[type="checkbox"], [role="checkbox"]');
    const candidates = [control, element, element.closest('label, [role="checkbox"]')].filter(Boolean);
    return candidates.some((candidate) => candidate.checked === true
      || candidate.getAttribute('aria-checked') === 'true'
      || /(?:^|[-_\s])(?:checked|selected|active)(?:$|[-_\s])/i.test(String(candidate.className || '')));
  }, { timeout: Math.max(0, Number(timeoutMs) || 0) }).catch(() => false);
};

const isReturnRefundConfirmationActionEnabled = async (action, {
  timeoutMs = 1_500,
} = {}) => {
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  if (!action || !await action.isEnabled({ timeout }).catch(() => false)) return false;
  if (await action.getAttribute('aria-disabled', { timeout }).catch(() => null) === 'true') return false;
  return action.evaluate((element) => !element.hasAttribute('disabled')
    && !/(?:^|[-_\s])disabled(?:$|[-_\s])/i.test(String(element.className || ''))
    && !/[(（]\s*\d{1,3}\s*(?:s|秒)\s*[)）]\s*$/u.test(String(element.innerText || element.textContent || '')), {
    timeout,
  })
    .catch(() => false);
};

export const findReturnRefundConfirmationAction = async (page, {
  timeoutMs = 8_000,
} = {}) => {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  do {
    const containers = page.locator(returnRefundConfirmationSelector);
    const count = await containers.count().catch(() => 0);
    const matches = [];
    for (let index = count - 1; index >= 0; index -= 1) {
      const container = containers.nth(index);
      if (!await container.isVisible().catch(() => false)) continue;
      const text = compactText(await container.innerText().catch(() => ''));
      if (!returnRefundConfirmationTextPattern.test(text)) continue;
      // PDD renders the aftersale detail itself in a modal. Its text includes
      // the refund amount and the main approve action, but it is not the
      // irreversible confirmation dialog.
      if (returnRefundDetailIdentityPattern.test(text)
        && returnRefundDetailFieldPattern.test(text)) continue;
      const acknowledgement = await findReturnRefundAcknowledgement(container);
      const candidates = [
        container.getByRole('button', { name: returnRefundConfirmationActionPattern, exact: true }),
        container.getByRole('link', { name: returnRefundConfirmationActionPattern, exact: true }),
        container.locator('button, a, [role="button"], [role="link"]').filter({
          hasText: returnRefundConfirmationActionPattern,
        }),
        // The dialog heading is also “同意退款”. During the button countdown
        // plain text must never be selected as an irreversible action.
      ];
      for (const locator of candidates) {
        const action = await visibleLocator(locator);
        if (!action) continue;
        matches.push({ action, acknowledgement, container, text, index });
        break;
      }
    }
    if (matches.length) {
      // Nested modal selectors can resolve the same dialog at several levels.
      // The shortest matching text is the most specific confirmation scope.
      matches.sort((left, right) => left.text.length - right.text.length
        || right.index - left.index);
      const [{ index: _index, ...match }] = matches;
      return match;
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(200);
  } while (true);
  return null;
};

export const clickReturnRefundConfirmationActionOnce = async (confirmation, {
  timeoutMs = RETURN_REFUND_CONFIRM_ENABLE_WAIT_MS,
  onWait = null,
  onDispatch = null,
  resolveConfirmation = null,
  maintainAcknowledgement = false,
  locatorTimeoutMs = 1_500,
} = {}) => {
  if (!confirmation?.action) return false;
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let current = confirmation;
  const resolveCurrent = async () => {
    if (typeof resolveConfirmation !== 'function') return current;
    return await resolveConfirmation() || null;
  };
  while (true) {
    current = await resolveCurrent();
    if (maintainAcknowledgement && current?.acknowledgement) {
      await clickReturnRefundAcknowledgementOnce(current.acknowledgement, {
        resolveAcknowledgement: async () => (await resolveCurrent())?.acknowledgement || null,
        timeoutMs: locatorTimeoutMs,
      });
      current = await resolveCurrent();
    }
    if (await isReturnRefundConfirmationActionEnabled(current?.action, {
      timeoutMs: locatorTimeoutMs,
    })) break;
    if (Date.now() >= deadline) {
      const error = new Error(`退款确认按钮等待 ${Math.max(0, Number(timeoutMs) || 0)} 毫秒仍未启用，未执行提交`);
      error.code = 'PDD_RETURN_REFUND_CONFIRMATION_NOT_DISPATCHED';
      error.retryable = true;
      error.confirmationDispatched = false;
      throw error;
    }
    await onWait?.(current);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  // DOM click is intentionally dispatched once. Playwright's retrying click
  // semantics are unsuitable for an irreversible refund confirmation.
  await onDispatch?.();
  await current.action.evaluate((element) => element.click(), {
    timeout: Math.max(0, Number(locatorTimeoutMs) || 0),
  });
  return true;
};

export const clickReturnRefundAcknowledgementOnce = async (acknowledgement, {
  resolveAcknowledgement = null,
  maxAttempts = 3,
  timeoutMs = 1_500,
} = {}) => {
  if (!acknowledgement) return false;
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  let current = acknowledgement;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1 && typeof resolveAcknowledgement === 'function') {
      current = await resolveAcknowledgement() || null;
    }
    if (!current) continue;
    if (await isReturnRefundAcknowledgementChecked(current, { timeoutMs })) return false;
    try {
      const clicked = await current.evaluate((element) => {
        const control = element.matches('input[type="checkbox"], [role="checkbox"]')
          ? element
          : element.querySelector('input[type="checkbox"], [role="checkbox"]')
            || element.closest('label, [role="checkbox"]')
            || element;
        control.click();
        return true;
      }, { timeout: Math.max(0, Number(timeoutMs) || 0) });
      return clicked === true;
    } catch (error) {
      lastError = error;
      if (typeof resolveAcknowledgement !== 'function' || attempt >= attempts) throw error;
    }
  }
  if (lastError) throw lastError;
  return false;
};

const returnRefundModalSelector = [
  '[data-testid="beast-core-modal"]:visible',
  '[role="dialog"]:visible',
  '.ant-modal:visible',
].join(', ');

const returnRefundModalCloseSelector = [
  '[data-testid="beast-core-modal-close-button"]',
  '[aria-label="关闭"]',
  '[aria-label="Close"]',
  '[data-testid*="close"]',
  '[class*="closeIcon"]',
  '[class*="CloseIcon"]',
  '[class*="close"]',
].join(', ');

const returnRefundVerificationTextPattern = /(?:正在进行安全验证|请完成安全验证|安全验证|验证码|滑块验证|滑动验证|完成拼图|拖动.*滑块|请向右滑)/u;

export const isReturnRefundDetailUrl = (value) => {
  try {
    const url = new URL(String(value || ''));
    return url.hostname === 'mms.pinduoduo.com'
      && url.pathname === '/aftersales-ssr/detail';
  } catch {
    return false;
  }
};

export const isReturnRefundExcludedDetailUrl = (value) => {
  try {
    const url = new URL(String(value || ''));
    const pathname = url.pathname.replace(/\/+$/u, '').toLowerCase();
    return url.hostname === 'mms.pinduoduo.com'
      && pathname === '/orders/appeals/negativeexperiencedetail';
  } catch {
    return false;
  }
};

const hasReturnRefundDetailOverlay = async (page) => {
  const modals = page.locator(returnRefundModalSelector);
  const count = await modals.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const modal = modals.nth(index);
    if (!await modal.isVisible().catch(() => false)) continue;
    const modalText = compactText(await modal.innerText().catch(() => ''));
    if (/(?:售后编号|售后编码)/u.test(modalText)
      && /(?:退款金额|售后类型|退货物流)/u.test(modalText)) return true;
  }
  return false;
};

export const waitForReturnRefundDetailTarget = async (page, context, pagesBefore, {
  listUrl = page.url(),
  timeoutMs = 15_000,
} = {}) => {
  const previousPages = pagesBefore instanceof Set ? pagesBefore : new Set(pagesBefore || []);
  const deadline = Date.now() + timeoutMs;
  do {
    const openedPages = context.pages().filter((candidate) => (
      candidate !== page && !candidate.isClosed() && !previousPages.has(candidate)
    ));
    const detailPage = openedPages.find((candidate) => isReturnRefundDetailUrl(candidate.url()));
    if (detailPage) return detailPage;
    const navigatedPage = openedPages.find((candidate) => candidate.url() !== 'about:blank');
    if (navigatedPage) return navigatedPage;
    if (page.url() !== listUrl || await hasReturnRefundDetailOverlay(page)) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);

  return context.pages().find((candidate) => (
    candidate !== page && !candidate.isClosed() && !previousPages.has(candidate)
  )) || null;
};

export const closeStaleReturnRefundDetailPages = async (context, {
  anchorPage = null,
  preserveVerification = false,
  protectedPages = [],
} = {}) => {
  let closed = 0;
  let preservedPage = null;
  const protectedSet = new Set(protectedPages.filter((page) => page && !page.isClosed?.()));
  const candidates = context.pages().filter((candidate) => (
    candidate !== anchorPage
    && !protectedSet.has(candidate)
    && !candidate.isClosed()
    && isReturnRefundDetailUrl(candidate.url())
  ));
  for (const candidate of candidates) {
    const shouldPreserve = preserveVerification && !preservedPage
      && await detectHumanVerification(candidate).catch(() => false);
    if (shouldPreserve) {
      preservedPage = candidate;
      continue;
    }
    await candidate.close({ runBeforeUnload: false }).catch(() => {});
    if (candidate.isClosed()) closed += 1;
  }
  return { closed, preservedPage };
};

const isRefundConfirmationModal = async (modal, modalText) => {
  if (!returnRefundConfirmationTextPattern.test(modalText)) return false;
  const action = await visibleLocator(modal.locator('button, a, [role="button"], [role="link"]').filter({
    hasText: /^\s*(?:确认|确定|同意|确认退款|确认同意|同意退款)\s*$/u,
  }));
  return Boolean(action);
};

const closeReturnRefundModal = async (page, modal, step, stage, modalText, {
  allowEscape = false,
} = {}) => {
  if (returnRefundVerificationTextPattern.test(modalText)
    || await detectHumanVerification(page)) return false;
  await step(stage, async () => {
    if (!await modal.isVisible().catch(() => false)) return;
    if (await detectHumanVerification(page)) return;
    const close = await visibleLocator(modal.locator(returnRefundModalCloseSelector));
    if (close) {
      await close.click({ force: true, timeout: 5_000 }).catch(async (error) => {
        if (!await modal.isVisible().catch(() => false)) return;
        throw error;
      });
    } else if (allowEscape) {
      await page.keyboard.press('Escape').catch(() => {});
    }
    await modal.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => {});
    if (allowEscape && await modal.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape').catch(() => {});
      await modal.waitFor({ state: 'hidden', timeout: 2_000 }).catch(() => {});
    }
  }, { modalText: modalText.slice(0, 120) });
  return !await modal.isVisible().catch(() => false);
};

const dismissReturnRefundBlockingPromotion = async (page, step) => {
  for (let pass = 0; pass < 4; pass += 1) {
    if (await detectHumanVerification(page)) return false;
    const modals = page.locator(returnRefundModalSelector);
    const count = await modals.count().catch(() => 0);
    let closed = false;
    for (let index = count - 1; index >= 0; index -= 1) {
      const modal = modals.nth(index);
      if (!await modal.isVisible().catch(() => false)) continue;
      const modalText = compactText(await modal.innerText().catch(() => ''));
      if (returnRefundVerificationTextPattern.test(modalText)) return false;
      if (await isRefundConfirmationModal(modal, modalText)) continue;
      closed = await closeReturnRefundModal(
        page,
        modal,
        step,
        'return-refund-dismiss-blocking-modal',
        modalText,
      );
      if (closed) break;
    }
    if (!closed) return pass > 0;
  }
  return true;
};

export const closeReturnRefundDetailOverlay = async (page, options = {}) => {
  const step = createVisiblePddStep(page, options);
  const modals = page.locator(returnRefundModalSelector);
  const count = await modals.count().catch(() => 0);
  for (let index = count - 1; index >= 0; index -= 1) {
    const modal = modals.nth(index);
    if (!await modal.isVisible().catch(() => false)) continue;
    const modalText = compactText(await modal.innerText().catch(() => ''));
    if (!/(?:售后编号|售后编码)/u.test(modalText)
      || !/(?:退款金额|售后类型|退货物流)/u.test(modalText)) continue;
    return closeReturnRefundModal(
      page,
      modal,
      step,
      'return-refund-close-detail-overlay',
      modalText,
      { allowEscape: true },
    );
  }
  return false;
};

export const readReturnRefundListRowIdentity = async (action) => {
  if (!action) return { orderNumber: null, aftersaleNumber: null, source: 'unavailable' };
  return action.evaluate((element) => {
    const normalized = (value) => String(value || '')
      .normalize('NFKC')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const isDetailAction = (candidate) => normalized(
      candidate.innerText || candidate.textContent,
    ) === '查看详情';
    const detailActionCount = (container) => [
      container,
      ...container.querySelectorAll('*'),
    ].filter((candidate) => isDetailAction(candidate)
      // PDD also renders clickable spans/divs without a semantic button role.
      // Count the innermost label once, not its identical text wrappers.
      && ![...candidate.children].some(isDetailAction)
      && candidate.getClientRects().length > 0
      && getComputedStyle(candidate).visibility !== 'hidden').length;
    const hrefsFor = (container) => [container, ...container.querySelectorAll(
      'a[href], [data-href], [data-url]',
    )].flatMap((candidate) => [
      candidate.getAttribute?.('href'),
      candidate.getAttribute?.('data-href'),
      candidate.getAttribute?.('data-url'),
    ]).filter(Boolean);
    const identityFromUrls = (hrefs) => {
      for (const href of hrefs) {
        try {
          const url = new URL(href, window.location.href);
          const orderNumber = ['orderSn', 'order_sn', 'orderNumber', 'order_number']
            .map((name) => url.searchParams.get(name))
            .find((value) => /^\d{6}-\d{12,}$/u.test(value || '')) || null;
          const id = url.searchParams.get('id');
          const aftersaleNumber = /\/aftersales?(?:-ssr)?\//iu.test(url.pathname)
            && /^\d{8,}$/u.test(id || '') ? id : null;
          if (orderNumber || aftersaleNumber) return { orderNumber, aftersaleNumber };
        } catch { /* ignore malformed row links */ }
      }
      return { orderNumber: null, aftersaleNumber: null };
    };
    const attributeCandidateIds = (container) => {
      const candidates = new Set();
      for (const node of [container, ...container.querySelectorAll('*')]) {
        for (const attribute of node.attributes || []) {
          if (!/(?:after.?sale|refund|service|(?:^|-)id$)/iu.test(attribute.name)) continue;
          const match = String(attribute.value || '').match(/(?:^|\D)(\d{8,18})(?=\D|$)/u);
          if (match) candidates.add(match[1]);
          if (candidates.size >= 8) return [...candidates];
        }
      }
      return [...candidates];
    };

    let current = element;
    for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) {
      if (detailActionCount(current) !== 1) continue;
      const text = normalized(current.innerText || current.textContent);
      const urlIdentity = identityFromUrls(hrefsFor(current));
      const rowOrderNumbers = [...new Set(text.match(/\d{6}-\d{12,}/gu) || [])];
      if (rowOrderNumbers.length > 1
        || (rowOrderNumbers[0] && urlIdentity.orderNumber
          && rowOrderNumbers[0] !== urlIdentity.orderNumber)) {
        return { orderNumber: null, aftersaleNumber: null, source: 'ambiguous-list-row' };
      }
      const orderNumber = rowOrderNumbers[0] || urlIdentity.orderNumber;
      const aftersaleNumber = text.match(/售后(?:编号|编码)\s*[:：]?\s*([0-9A-Za-z-]{8,})/u)?.[1]
        || urlIdentity.aftersaleNumber;
      if (orderNumber || aftersaleNumber) {
        const candidates = attributeCandidateIds(current);
        return {
          orderNumber: orderNumber || null,
          aftersaleNumber: aftersaleNumber || null,
          source: 'list-row-or-detail-link',
          rowDepth: depth,
          ...(candidates.length ? { attributeCandidateIds: candidates } : {}),
        };
      }
    }
    return { orderNumber: null, aftersaleNumber: null, source: 'unavailable' };
  }).catch(() => ({ orderNumber: null, aftersaleNumber: null, source: 'unavailable' }));
};

export const readReturnRefundActivePageNumber = async (page) => {
  const locator = page.locator([
    '[aria-current="page"]',
    // The current PDD refund workbench uses PGT_pagerItemActive_<version>.
    '[class*="pagerItemActive"]',
    // Ant pagination marks the selected <li> itself as active.
    '[class*="pagination-item-active"]',
    '[class*="Pagination-item-active"]',
    '[class*="pagination"] [class*="active"]',
    '[class*="Pagination"] [class*="active"]',
    '[class*="pagination"] [class*="selected"]',
    '[class*="Pagination"] [class*="selected"]',
  ].join(', '));
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const text = compactText(await candidate.innerText().catch(() => ''));
    if (!/^\d{1,5}$/u.test(text)) continue;
    const pageNumber = Number(text);
    if (Number.isSafeInteger(pageNumber) && pageNumber > 0) return pageNumber;
  }
  return null;
};

const RETURN_REFUND_LIST_ACTION_SCOPE = 'refund-list-without-platform-messages-v1';

// Cursor scope describes row indexing, not a reusable live browser page.
// Keep it across restarts only when the persisted scan or page proof owns
// this cursor. This marker alone never authorizes reusing a live page.
export const returnRefundCursorActionScope = (cursor, proof) =>
  proof?.actionScope === RETURN_REFUND_LIST_ACTION_SCOPE
  && Number.isSafeInteger(cursor?.page) && cursor.page > 0 && cursor.page <= 10_000
  && Number.isSafeInteger(cursor?.itemOffset) && cursor.itemOffset >= 0 && cursor.itemOffset <= 999
  && proof.nextCursor?.page === cursor.page
  && proof.nextCursor?.itemOffset === cursor.itemOffset
    ? RETURN_REFUND_LIST_ACTION_SCOPE : null;
export const returnRefundListDetailActions = (page) => page.getByText('查看详情', { exact: true })
  .and(page.locator(':not([class*="MsgItem_"], [class*="MsgItem_"] *, '
    + '[class*="ImportantList_"], [class*="ImportantList_"] *)'));

const returnRefundPageSignature = async (page) => {
  const [activePage, rowSignature] = await Promise.all([
    readReturnRefundActivePageNumber(page),
    returnRefundListDetailActions(page)
      .evaluateAll((elements) => elements.slice(0, 4).map((element) => {
    let cursor = element;
    for (let depth = 0; cursor && depth < 10; depth += 1, cursor = cursor.parentElement) {
      const text = String(cursor.innerText || cursor.textContent || '').replace(/\s+/g, ' ').trim();
      const orderNumber = text.match(/\b\d{6}-\d{12,}\b/u)?.[0];
      if (orderNumber) return orderNumber;
    }
    return String(element.parentElement?.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
  }).join('|'))
      .catch(() => ''),
  ]);
  return rowSignature ? `${activePage || 'unknown'}:${rowSignature}` : '';
};

// Diagnostic hashes only. Dates/countdowns can explain a rejected proof, but
// removing their text must never make a changed list eligible for reuse.
export const summarizeReturnRefundScanRows = (rows) => {
  const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const orderSequences = rows.map((row) => [...new Set(row.match(/\b\d{6}-\d{12,}\b/gu) || [])]);
  const timeTokenCounts = { clock: 0, duration: 0 };
  const withoutTimeTokens = rows.map((row) => row
    .replace(/(?<!\d)\d{1,3}:\d{2}(?::\d{2})?(?!\d)/gu, () => {
      timeTokenCounts.clock += 1;
      return '<clock>';
    })
    .replace(/(?<!\d)(?:\d{1,4}\s*(?:天|小时|时|分钟|分|秒)\s*)+/gu, () => {
      timeTokenCounts.duration += 1;
      return '<duration>';
    }));
  return {
    version: 1,
    orderSequenceSha256: hash(orderSequences),
    rowOrderCounts: orderSequences.map((orders) => orders.length),
    rowsWithoutTimeTokensSha256: hash(withoutTimeTokens),
    timeTokenCounts,
  };
};

// Only the platform's explicitly labelled automatic-refund countdown may
// change while retaining a list cursor. Application dates, logistics times,
// amounts, status text and every other character remain part of the hash.
export const returnRefundCountdownProofForRows = (rows, { diagnostics = null } = {}) => {
  const seconds = [];
  let valid = rows.length > 0;
  const rowShapes = [];
  const normalized = rows.map((row) => {
    let matches = 0;
    let remaining = null;
    let invalidValue = false;
    const text = row.replace(
      /(申请时间\s*[:：]\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s*[（(]\s*)(\d{1,3})\s*天\s*(\d{1,2})\s*时\s*(\d{1,2})\s*分\s*(\d{1,2})\s*秒(?=\s*(?:未处理|物流无退回轨迹)\s*[，,]\s*系统将自动退款\s*[）)])/gu,
      (_match, prefix, days, hours, minutes, secs) => {
        matches += 1;
        remaining = Number(days) * 86_400 + Number(hours) * 3_600
          + Number(minutes) * 60 + Number(secs);
        if (Number(hours) > 23 || Number(minutes) > 59 || Number(secs) > 59
          || remaining <= 0) { valid = false; invalidValue = true; }
        return `${prefix}<auto-refund-countdown>`;
      },
    );
    const orderCount = new Set(row.match(/\b\d{6}-\d{12,}\b/gu) || []).size;
    if (matches > 1 || orderCount !== 1) valid = false;
    rowShapes.push({
      orderCount, matchingCountdowns: matches, invalidValue,
      applicationTimeLabel: /申请时间/u.test(row),
      applicationTimestamp: /申请时间\s*[:：]\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/u.test(row),
      autoRefundNotice: /(?:未处理|物流无退回轨迹)\s*[，,]\s*系统将自动退款/u.test(row),
      durationWithSpacing: /\d+\s*天\s*\d+\s*时\s*\d+\s*分\s*\d+\s*秒/u.test(row),
    });
    seconds.push(remaining);
    return text;
  });
  if (diagnostics) Object.assign(diagnostics, { rowShapes, valid,
    matchedRows: seconds.filter((value) => value !== null).length });
  if (!valid || !seconds.some((value) => value !== null)) return null;
  return {
    version: 1,
    rowsSha256: crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex'),
    seconds,
  };
};

const sameReturnRefundRowsExceptCountdown = (previous, observed) => {
  const before = previous?.countdownProof;
  const after = observed?.countdownProof;
  if (before?.version !== 1 || after?.version !== 1
    || before.rowsSha256 !== after.rowsSha256
    || !Array.isArray(before.seconds) || !Array.isArray(after.seconds)
    || before.seconds.length !== previous.rowCount
    || after.seconds.length !== previous.rowCount) return false;
  const elapsedSeconds = (Date.parse(observed.capturedAt) - Date.parse(previous.capturedAt)) / 1_000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) return false;
  return before.seconds.some((value) => value !== null)
    && before.seconds.every((value, index) => {
      const current = after.seconds[index];
      if (value === null || current === null) return value === current;
      // Background tabs may update their timers once per minute. A reset,
      // expiry or materially changed deadline still rejects the saved cursor.
      return Number.isSafeInteger(value) && Number.isSafeInteger(current)
        && current > 0 && current <= value
        && Math.abs(value - current - elapsedSeconds) <= 90;
    });
};

export const readReturnRefundScanResumeProof = async (page, nextCursor) => {
  if (!page || page.isClosed?.()) return null;
  let listUrl;
  try { listUrl = new URL(page.url()); } catch { return null; }
  if (listUrl.origin !== 'https://mms.pinduoduo.com'
    || listUrl.pathname !== '/aftersales/aftersale_list') return null;
  const [activePage, rows, totalDetailActions] = await Promise.all([
    readReturnRefundActivePageNumber(page),
    returnRefundListDetailActions(page).evaluateAll((elements) => elements.map((element) => {
      let cursor = element;
      for (let depth = 0; cursor && depth < 10; depth += 1, cursor = cursor.parentElement) {
        const value = String(cursor.innerText || cursor.textContent || '').replace(/\s+/g, ' ').trim();
        if (/\b\d{6}-\d{12,}\b/u.test(value)) return value;
      }
      return String(element.parentElement?.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
    })).catch(() => []),
    page.getByText('查看详情', { exact: true }).count().catch(() => 0),
  ]);
  if (!Number.isSafeInteger(activePage) || activePage < 1 || !rows.length || rows.some((row) => !row)) return null;
  const countdownDiagnostics = {};
  const countdownProof = returnRefundCountdownProofForRows(rows, { diagnostics: countdownDiagnostics });
  return {
    page: activePage,
    actionScope: RETURN_REFUND_LIST_ACTION_SCOPE,
    excludedMessageActionCount: Math.max(0, totalDetailActions - rows.length),
    capturedAt: new Date().toISOString(),
    urlSha256: crypto.createHash('sha256').update(page.url()).digest('hex'),
    rowCount: rows.length,
    rowsSha256: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    rowTextDiagnostics: summarizeReturnRefundScanRows(rows),
    countdownProof,
    countdownDiagnostics,
    nextCursor: normalizeReturnRefundScanCursor(nextCursor),
  };
};

export const readReturnRefundListResourcePaths = async (page) => {
  if (!page || page.isClosed?.()) return [];
  return page.evaluate(() => {
    const paths = new Set();
    for (const entry of performance.getEntriesByType('resource').slice(-500)) {
      if (!['fetch', 'xmlhttprequest'].includes(entry.initiatorType)) continue;
      try {
        const url = new URL(entry.name);
        if (!url.hostname.endsWith('.pinduoduo.com')) continue;
        if (!/(?:mercury|after.?sale|refund)/iu.test(url.pathname)) continue;
        const safePath = url.pathname
          .replace(/\/\d{8,}(?=\/|$)/gu, '/:id')
          .replace(/[A-Za-z0-9_-]{40,}/gu, ':value');
        paths.add(`${url.hostname}${safePath}`);
      } catch { /* ignore malformed resource URLs */ }
      if (paths.size >= 30) break;
    }
    return [...paths];
  }).catch(() => []);
};

// Observe the list response already requested by the PDD page. This is diagnostic
// evidence only: an API row must never replace the rendered detail as business proof.
export const createReturnRefundListResponseObserver = (page) => {
  const emitter = page?.context?.() || page;
  if (typeof emitter?.on !== 'function') {
    return { snapshot: async () => null, diagnostics: () => ({}), stop: () => {} };
  }
  let latest = null;
  let pending = Promise.resolve();
  let sequence = 0;
  const diagnostics = { pathResponses: 0, postResponses: 0,
    successfulJson: 0, recognizedLists: 0, queryListResponses: 0 };
  const onResponse = (response) => {
    let url;
    try { url = new URL(response.url()); } catch { return; }
    const pathname = url.pathname.toLowerCase();
    if (!['/mercury/aftersales/list', '/mercury/mms/aftersales/querylist']
      .includes(pathname) || !url.hostname.endsWith('.pinduoduo.com')) return;
    // Several PDD tabs share one browser context. A response from another tab
    // must never supply an aftersale ID for this list page.
    let requestPage;
    try { requestPage = response.request().frame().page(); } catch { return; }
    if (requestPage !== page) return;
    diagnostics.pathResponses += 1;
    if (pathname.endsWith('/querylist')) diagnostics.queryListResponses += 1;
    if (response.request?.().method?.() === 'POST') diagnostics.postResponses += 1;
    const currentSequence = ++sequence;
    pending = Promise.resolve().then(async () => {
      if (!response.ok()) return;
      const body = await response.json();
      diagnostics.successfulJson += 1;
      const roots = [body, body?.result, body?.data, body?.result?.data];
      const list = roots.flatMap((value) => value && typeof value === 'object'
        ? [value.afterSalesList, value.list, value.rows, value.records,
          value.dataList, value.data?.afterSalesList, value.data?.list]
        : []).find((value) => Array.isArray(value)
          && value.some((item) => item && typeof item === 'object'
            && /^\d{8,18}$/u.test(String(item.id || ''))
            && /^\d{6}-\d{12,}$/u.test(String(item.orderSn || ''))));
      if (!list || currentSequence !== sequence) return;
      diagnostics.recognizedLists += 1;
      latest = {
        receivedAt: Date.now(),
        items: list.slice(0, 100).map((item) => ({
          id: /^\d{8,18}$/u.test(String(item?.id || '')) ? String(item.id) : null,
          orderSn: /^\d{6}-\d{12,}$/u.test(String(item?.orderSn || ''))
            ? String(item.orderSn) : null,
        })),
      };
    }).catch(() => {});
  };
  emitter.on('response', onResponse);
  return {
    snapshot: async () => {
      await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, 300))]);
      return latest;
    },
    diagnostics: () => ({ ...diagnostics }),
    stop: () => emitter.off?.('response', onResponse),
  };
};

const resolveExactReturnRefundListIdentity = ({
  targetIdentity, responseRow = null, listResponseMatchesPage = false,
  responseOrderCount = 0,
} = {}) => {
  const orderNumber = String(targetIdentity?.orderNumber || '');
  if (!/^\d{6}-\d{12,}$/u.test(orderNumber)) return null;
  const renderedId = /^\d{8,18}$/u.test(String(targetIdentity?.aftersaleNumber || ''))
    ? String(targetIdentity.aftersaleNumber) : null;
  if (renderedId && listResponseMatchesPage && responseRow?.id
    && renderedId !== responseRow.id) return null;
  const responseId = listResponseMatchesPage && responseOrderCount === 1
    && responseRow?.orderSn === orderNumber
    && /^\d{8,18}$/u.test(String(responseRow?.id || ''))
    ? String(responseRow.id) : null;
  const aftersaleNumber = renderedId || responseId;
  if (!aftersaleNumber) return null;
  return {
    orderNumber,
    aftersaleNumber,
    identitySource: renderedId ? 'rendered-list-row' : 'matched-list-response',
  };
};

export const identifyKnownFutureRefundRecheck = ({
  targetIdentity, responseRow = null, listResponseMatchesPage = false,
  responseOrderCount = 0, deferredRefundLookup, nowMs = Date.now(),
} = {}) => {
  if (!(deferredRefundLookup instanceof Map)) return null;
  const identity = resolveExactReturnRefundListIdentity({
    targetIdentity, responseRow, listResponseMatchesPage, responseOrderCount,
  });
  if (!identity) return null;
  const { orderNumber, aftersaleNumber } = identity;
  const deferredUntil = deferredRefundLookup.get(`${orderNumber}\u0000${aftersaleNumber}`);
  if (!Number.isFinite(deferredUntil) || deferredUntil <= nowMs + 60_000) return null;
  return {
    aftersaleNumber,
    nextCheckAt: new Date(deferredUntil).toISOString(),
    identitySource: identity.identitySource,
  };
};

export const identifyKnownCompletedRefund = ({
  targetIdentity, responseRow = null, listResponseMatchesPage = false,
  responseOrderCount = 0, completedRefundLookup,
} = {}) => {
  if (!(completedRefundLookup instanceof Set)) return null;
  const identity = resolveExactReturnRefundListIdentity({
    targetIdentity, responseRow, listResponseMatchesPage, responseOrderCount,
  });
  if (!identity || !completedRefundLookup.has(
    `${identity.orderNumber}\u0000${identity.aftersaleNumber}`,
  )) return null;
  return identity;
};

// A PDD page can render one extra "view detail" action outside the API list.
// Only associate response IDs with actions when every API order matches the
// visible actions in order and there is exactly one possible extra action.
// Ambiguous duplicate orders retain the normal detail inspection path.
export const describeReturnRefundListResponseMatch = (identities, responseItems) => {
  const rows = Array.isArray(identities) ? identities : [];
  const items = Array.isArray(responseItems) ? responseItems : [];
  const validOrder = (value) => /^\d{6}-\d{12,}$/u.test(String(value || ''));
  const actionOrders = rows.map((identity) => validOrder(identity?.orderNumber) ? identity.orderNumber : null);
  const responseOrders = items.map((item) => validOrder(item?.orderSn) ? item.orderSn : null);
  const duplicates = (orders) => orders.filter(Boolean).length - new Set(orders.filter(Boolean)).size;
  const sources = {};
  for (const identity of rows) {
    const source = ['list-row-or-detail-link', 'ambiguous-list-row', 'hidden-action', 'unavailable']
      .includes(identity?.source) ? identity.source : 'other';
    sources[source] = (sources[source] || 0) + 1;
  }
  return {
    attempted: Array.isArray(identities),
    actionCount: rows.length,
    responseCount: items.length,
    missingActionOrders: actionOrders.filter((order) => !order).length,
    invalidResponseRows: items.filter((item) => !validOrder(item?.orderSn)
      || !/^\d{8,18}$/u.test(String(item?.id || ''))).length,
    duplicateActionOrders: duplicates(actionOrders),
    duplicateResponseOrders: duplicates(responseOrders),
    sources,
    // Positions only: never persist raw order numbers or response contents.
    // -1 means missing/unmatched; -2 means the response order is ambiguous.
    responseIndexByAction: actionOrders.map((order) => {
      if (!order) return -1;
      const indices = responseOrders.flatMap((candidate, index) => candidate === order ? [index] : []);
      return indices.length === 1 ? indices[0] : indices.length > 1 ? -2 : -1;
    }),
  };
};

export const matchReturnRefundListResponseToActions = (identities, responseItems) => {
  if (!Array.isArray(identities) || !Array.isArray(responseItems)
    || responseItems.length === 0 || identities.length > 100
    || identities.length - responseItems.length < 0
    || identities.length - responseItems.length > 1
    || responseItems.some((row) => !/^\d{6}-\d{12,}$/u.test(String(row?.orderSn || ''))
      || !/^\d{8,18}$/u.test(String(row?.id || '')))) return null;
  const orders = identities.map((identity) => String(identity?.orderNumber || ''));
  const extraCount = identities.length - responseItems.length;
  const candidates = extraCount === 0 ? [-1]
    : identities.map((_, index) => index);
  const matchingExtras = candidates.filter((extraIndex) => {
    const remaining = orders.filter((_, index) => index !== extraIndex);
    return remaining.every((order, index) => order === responseItems[index].orderSn);
  });
  if (matchingExtras.length !== 1) return null;
  const extraIndex = matchingExtras[0];
  return {
    extraActionIndex: extraIndex,
    responseByActionIndex: identities.map((_, index) => index === extraIndex
      ? null : responseItems[index - Number(extraIndex >= 0 && index > extraIndex)]),
  };
};

export const matchesReturnRefundScanResumeProof = (previous, observed, requestedCursor) => {
  if (!previous || !observed) return false;
  const proofAgeMs = Date.now() - Date.parse(String(previous.capturedAt || ''));
  if (!Number.isFinite(proofAgeMs) || proofAgeMs < 0
    || proofAgeMs > RETURN_REFUND_SCAN_RESUME_MAX_AGE_MS) return false;
  const requested = normalizeReturnRefundScanCursor(requestedCursor);
  return previous.actionScope === RETURN_REFUND_LIST_ACTION_SCOPE
    && observed.actionScope === RETURN_REFUND_LIST_ACTION_SCOPE
    && previous.urlSha256 === observed.urlSha256
    && previous.page === observed.page
    && requested.page >= observed.page
    && requested.page <= observed.page + 1
    && previous.rowCount === observed.rowCount
    && (previous.rowsSha256 === observed.rowsSha256
      || sameReturnRefundRowsExceptCountdown(previous, observed))
    && previous.nextCursor?.page === requested.page
    && previous.nextCursor?.itemOffset === requested.itemOffset;
};

export const waitForReturnRefundPageTransition = async (page, {
  previousSignature = '',
  expectedPage = null,
  onVerification = null,
  stage = 'return-refund-page-change',
  timeoutMs = 30_000,
} = {}) => {
  const boundedTimeoutMs = Math.max(0, Math.min(30_000, Number(timeoutMs) || 0));
  const deadline = Date.now() + boundedTimeoutMs;
  do {
    await onVerification?.(page, stage);
    const [activePage, signature] = await Promise.all([
      readReturnRefundActivePageNumber(page),
      returnRefundPageSignature(page),
    ]);
    const expectedPageSelected = Number.isSafeInteger(expectedPage)
      && activePage === expectedPage;
    const rowSetChanged = Boolean(signature && signature !== previousSignature);
    // A same-page refresh can change the row set without completing a page turn.
    // When the UI exposes an active page, require it to match the target.
    const selectedPageMatches = !Number.isSafeInteger(expectedPage)
      || activePage == null
      || expectedPageSelected;
    if (signature && selectedPageMatches && (expectedPageSelected || rowSetChanged)) {
      return { activePage, signature };
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(Math.min(300, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return null;
};

const recoverStalePddPage = async (page, stage, onStep) => {
  const result = await clickVisiblePddStalePageRefresh(page, {
    cooldownMs: 0,
    settleMs: 700,
  }).catch(() => ({ handled: false }));
  if (!result?.handled) return false;
  await onStep?.(`${stage}-stale-page-refresh`, {
    beforeUrl: result.beforeUrl,
    afterUrl: result.afterUrl,
    handledAt: result.handledAt,
  });
  return true;
};

export const findNextReturnRefundPageAction = async (page) => {
  const candidates = [
    page.getByRole('button', { name: /下一页/u }),
    page.locator([
      '[aria-label="下一页"]',
      '[title="下一页"]',
      '[data-testid*="pagination-next"]',
      '[class*="pagination"] [class*="next"]',
      '[class*="Pagination"] [class*="next"]',
    ].join(', ')),
  ];
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      if (!await candidate.isEnabled().catch(() => true)) continue;
      const ariaDisabled = await candidate.getAttribute('aria-disabled').catch(() => null);
      const disabled = await candidate.getAttribute('disabled').catch(() => null);
      const className = await candidate.getAttribute('class').catch(() => '');
      if (ariaDisabled === 'true' || disabled != null || /(?:^|[-_\s])disabled(?:$|[-_\s])/iu.test(className || '')) continue;
      return candidate;
    }
  }
  return null;
};

export const createVisiblePddStep = (page, {
  delayMs = 900,
  onStep = null,
  onVerification = null,
} = {}) => async (stage, operation = null, metadata = {}, {
  retryAfterVerification = true,
} = {}) => {
  await maybeBringReturnRefundPageToFront(page);
  await onVerification?.(page, `${stage}-before`);
  const refreshedBeforeAction = await recoverStalePddPage(page, stage, onStep);
  if (refreshedBeforeAction) {
    await onVerification?.(page, `${stage}-after-stale-refresh`);
  }
  if (operation) {
    try {
      await operation();
    } catch (error) {
      const verificationHandled = await onVerification?.(page, `${stage}-action-error`);
      const refreshedAfterError = verificationHandled
        ? false
        : await recoverStalePddPage(page, stage, onStep);
      if (!verificationHandled && !refreshedAfterError) throw error;
      if (retryAfterVerification) await operation();
    }
  }
  await onVerification?.(page, `${stage}-after`);
  await recoverStalePddPage(page, `${stage}-after`, onStep);
  await onStep?.(stage, metadata);
  if (!page.isClosed()) await page.waitForTimeout(delayMs);
  else await new Promise((resolve) => setTimeout(resolve, delayMs));
};

export const openReturnRefundWorkbench = async (page, options = {}) => {
  const step = createVisiblePddStep(page, options);
  const assertPddLoginStillValid = (stage) => {
    if (!isPddLoginUrl(page.url())) return;
    const error = new Error(`拼多多售后列表已跳转登录页（阶段: ${stage}，URL: ${page.url()}）`);
    error.code = 'PDD_LOGIN_REQUIRED';
    throw error;
  };
  const downstreamEntryPattern = /^\s*(?:待商家处理|退货退款|退货待处理)\s*(?:[（(]\s*\d+\+?\s*[)）]|\d+\+?)?\s*$/u;
  const waitForVisibleText = async (pattern, timeout = 20_000) => {
    const locator = page.getByText(pattern);
    const deadline = Date.now() + timeout;
    do {
      assertPddLoginStillValid('return-refund-wait-navigation-entry');
      await options.onVerification?.(page, 'return-refund-wait-navigation-entry');
      assertPddLoginStillValid('return-refund-wait-navigation-entry');
      const target = await visibleLocator(locator);
      if (target) return target;
      await page.waitForTimeout(250);
    } while (Date.now() < deadline);
    return null;
  };
  const clickText = async (label, pattern, stage, {
    required = true,
    timeouts = [8_000, 12_000],
    refreshOnce = false,
    afterRefresh = null,
  } = {}) => {
    let lastError = null;
    let refreshed = false;
    const refreshForRetry = async (attempt, reason) => {
      if (!refreshOnce || refreshed || attempt >= timeouts.length) return;
      refreshed = true;
      await step(`${stage}-refresh`, () => page.reload({
        waitUntil: 'commit',
        timeout: 45_000,
      }), { attempt, reason });
      await afterRefresh?.({ attempt, reason });
    };
    for (let attempt = 1; attempt <= timeouts.length; attempt += 1) {
      await dismissReturnRefundBlockingPromotion(page, step);
      const target = await waitForVisibleText(pattern, timeouts[attempt - 1]);
      if (!target) {
        lastError = new Error(`PDD页面未找到“${label}”入口`);
        await refreshForRetry(attempt, 'entry-not-rendered');
        continue;
      }
      try {
        await step(stage, () => target.click({ timeout: 8_000 }), { attempt });
        return true;
      } catch (error) {
        lastError = error;
        if (!/intercepts pointer events|Timeout/u.test(String(error?.message || error))) throw error;
        await dismissReturnRefundBlockingPromotion(page, step);
        await refreshForRetry(attempt, 'entry-click-timeout');
      }
    }
    assertPddLoginStillValid(stage);
    if (!required) return false;
    throw lastError || new Error(`PDD页面未找到“${label}”入口`);
  };
  const ensureRefundAfterSalesView = async (stage, {
    probeTimeout = 1_500,
    tabTimeouts = [3_000, 5_000],
  } = {}) => {
    if (await waitForVisibleText(downstreamEntryPattern, probeTimeout)) return true;
    const tabSelected = await clickText(
      '退款/售后',
      /^\s*退款\s*[/／]\s*售后\s*(?:\d+\+?)?\s*$/u,
      stage,
      { required: false, timeouts: tabTimeouts },
    );
    if (!tabSelected) return false;
    return Boolean(await waitForVisibleText(
      downstreamEntryPattern,
      Math.max(3_000, Math.min(10_000, Number(options.renderWaitMs ?? 10_000) || 0)),
    ));
  };
  assertPddLoginStillValid('return-refund-open-workbench');
  await dismissReturnRefundBlockingPromotion(page, step);
  if (!page.url().includes('/aftersales/aftersale_list')) {
    let directFallbackReason = '';
    try {
      await clickText(
        '售后工作台',
        /^售后工作台\s*(?:\d+\+?)?$/u,
        'return-refund-open-workbench',
      );
      const downstreamEntry = page.url().includes('/aftersales/aftersale_list')
        ? true
        : Boolean(await waitForVisibleText(
          downstreamEntryPattern,
          Math.max(0, Math.min(1_500, Number(options.renderWaitMs ?? 1_500) || 0)),
        ));
      if (!downstreamEntry) directFallbackReason = 'workbench-entry-click-did-not-navigate';
    } catch (error) {
      if (error?.code === 'PDD_LOGIN_REQUIRED') throw error;
      directFallbackReason = String(error?.message || error).slice(0, 300);
    }
    if (directFallbackReason) {
      await step('return-refund-open-workbench-direct', () => navigateReturnRefundPage(
        page,
        RETURN_REFUND_WORKBENCH_URL,
        { expectedPath: '/aftersales/aftersale_list' },
      ), { fallbackReason: directFallbackReason });
    }
  } else {
    await step('return-refund-workbench-already-open');
  }
  await dismissReturnRefundBlockingPromotion(page, step);
  let refundViewReady = await ensureRefundAfterSalesView('return-refund-open-refund-aftersales-tab', {
    probeTimeout: Math.max(0, Math.min(1_500, Number(options.renderWaitMs ?? 1_500) || 0)),
  });
  if (!refundViewReady) {
    await step('return-refund-reopen-workbench-direct', () => navigateReturnRefundPage(
      page,
      RETURN_REFUND_WORKBENCH_URL,
      { expectedPath: '/aftersales/aftersale_list' },
    ), { fallbackReason: 'workbench-url-or-content-stale' });
    refundViewReady = await ensureRefundAfterSalesView(
      'return-refund-reopen-refund-aftersales-tab-after-direct',
    );
  }
  const selectMerchantPending = (stage = 'return-refund-open-merchant-pending',
    timeouts = [1_500, 2_500]) => clickText(
    '待商家处理',
    /^\s*待商家处理\s*(?:\d+\+?)?\s*$/u,
    stage,
    { required: false, timeouts },
  );
  const merchantPendingSelected = await selectMerchantPending();
  if (!merchantPendingSelected) {
    await step('return-refund-merchant-pending-optional-missing', null, {
      fallback: 'continue-through-return-refund-type',
    });
  }
  const configuredRenderWaitMs = Number(options.renderWaitMs ?? DEFAULT_PDD_RENDER_WAIT_MS);
  const typeEntryWaitMs = Math.max(0, Math.min(
    30_000,
    Number.isFinite(configuredRenderWaitMs) ? configuredRenderWaitMs : DEFAULT_PDD_RENDER_WAIT_MS,
  ));
  let refundTypeSelected = await clickText(
    '退货退款',
    /^\s*退货退款\s*(?:[（(]\s*\d+\+?\s*[)）]|\d+\+?)?\s*$/u,
    'return-refund-select-type',
    {
      required: false,
      timeouts: [typeEntryWaitMs, typeEntryWaitMs],
      refreshOnce: true,
      afterRefresh: async () => {
        await ensureRefundAfterSalesView('return-refund-reopen-refund-aftersales-tab-after-refresh');
        const reselected = await selectMerchantPending(
          'return-refund-reopen-merchant-pending-after-refresh',
          [8_000, 12_000],
        );
        if (!reselected) {
          await step('return-refund-merchant-pending-after-refresh-missing', null, {
            fallback: 'use-direct-return-pending-entry',
          });
        }
      },
    },
  );
  if (!refundTypeSelected) {
    const recoveredRefundView = await ensureRefundAfterSalesView(
      'return-refund-recover-refund-aftersales-tab',
      { probeTimeout: 500, tabTimeouts: [3_000, 5_000] },
    );
    if (recoveredRefundView) {
      await selectMerchantPending('return-refund-recover-merchant-pending', [3_000, 5_000]);
      refundTypeSelected = await clickText(
        '退货退款',
        /^\s*退货退款\s*(?:[（(]\s*\d+\+?\s*[)）]|\d+\+?)?\s*$/u,
        'return-refund-recover-select-type',
        { required: false, timeouts: [3_000, 5_000] },
      );
    }
  }
  if (!refundTypeSelected) {
    assertPddLoginStillValid('return-refund-select-type');
    const directPendingSelected = await clickText(
      '退货待处理',
      /^\s*退货待处理\s*(?:\d+\+?)?\s*$/u,
      'return-refund-open-direct-pending',
      { required: false, timeouts: [3_000, 5_000] },
    );
    if (!directPendingSelected) throw new Error('PDD页面未找到“退货退款”入口');
  }
  await dismissReturnRefundBlockingPromotion(page, step);
  return { url: page.url() };
};

export const readReturnLogisticsRegion = async (page) => page.evaluate(() => {
  const normalized = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 20 && rect.height > 15
      && rect.right > 0 && rect.bottom > 0
      && rect.left < (document.documentElement.clientWidth || window.innerWidth)
      && rect.top < (document.documentElement.clientHeight || window.innerHeight)
      && style.display !== 'none' && style.visibility !== 'hidden'
      && Number(style.opacity || 1) > 0;
  };
  const hasTimeline = (text) => /20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?\s+\d{1,2}:\d{2}/u.test(text);
  const hasPendingState = (text) => /(?:暂无物流信息|待快递公司返回物流信息|消费者已填写物流单号)/u.test(text);
  const hasLogisticsText = (text) => /(?:快件|包裹|物流|揽收|收取|取件|到达|离开|发往|运输|中转|转运|派送|投递|签收|驿站|代收|退回)/u.test(text);
  const candidates = [];
  const addCandidate = (element, strategy, requiresReturnTab) => {
    if (!visible(element) || element === document.body || element === document.documentElement) return;
    const text = normalized(element.innerText || element.textContent || '');
    if (!text || text.length > 30_000) return;
    if (requiresReturnTab && !text.includes('退货物流')) return;
    if (!(hasTimeline(text) && hasLogisticsText(text)) && !hasPendingState(text)) return;
    const rect = element.getBoundingClientRect();
    candidates.push({
      text,
      strategy,
      area: Math.round(rect.width * rect.height),
      lineCount: text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length,
    });
  };

  for (const selector of [
    '[role="dialog"]',
    '[data-testid*="modal" i]',
    '[class*="modal" i]',
    '[class*="drawer" i]',
  ]) {
    for (const element of document.querySelectorAll(selector)) {
      addCandidate(element, 'expanded-overlay', false);
    }
  }

  for (const element of document.querySelectorAll('*')) {
    if (!visible(element) || normalized(element.textContent) !== '退货物流') continue;
    let ancestor = element.parentElement;
    for (let depth = 1; ancestor && depth <= 10; depth += 1, ancestor = ancestor.parentElement) {
      addCandidate(ancestor, `return-logistics-module-depth-${depth}`, true);
    }
  }

  candidates.sort((left, right) => left.area - right.area || left.text.length - right.text.length);
  const selected = candidates[0];
  return selected ? {
    status: 'confirmed',
    strategy: selected.strategy,
    text: selected.text,
    lineCount: selected.lineCount,
  } : {
    status: 'not-found',
    strategy: 'not-found',
    text: '',
    lineCount: 0,
  };
}).catch(() => ({
  status: 'not-found', strategy: 'evaluation-failed', text: '', lineCount: 0,
}));

export const readReturnRefundDetail = async (page, options = {}) => {
  const step = createVisiblePddStep(page, options);
  const expectedDetailUrl = String(options.expectedDetailUrl || options.detailUrl || '').trim() || null;
  const initialFallbackFacts = options.fallbackFacts || null;
  let lastRenderObservation = null;
  const checkedDetailUrl = (targetPage) => {
    const url = targetPage.url();
    if (isPddLoginUrl(url)) {
      const error = new Error('拼多多退款详情已跳转登录页，请先完成店铺登录');
      error.code = 'PDD_LOGIN_REQUIRED';
      throw error;
    }
    return url;
  };
  const readRenderedSnapshot = async (targetPage, logistics = {}) => {
    const {
      fallbackFacts: interactionFallbackFacts = null,
      ...extractOptions
    } = logistics;
    const fallbackFacts = interactionFallbackFacts || initialFallbackFacts;
    checkedDetailUrl(targetPage);
    const bodyLocator = targetPage.locator('body');
    const body = await bodyLocator.innerText({ timeout: 3_000 }).catch(async () => (
      bodyLocator.textContent({ timeout: 3_000 }).catch(() => '')
    ));
    const observedUrl = checkedDetailUrl(targetPage);
    if (expectedDetailUrl && !isReturnRefundDetailUrl(observedUrl)) {
      lastRenderObservation = {
        reason: 'unexpected-detail-url',
        expectedDetailUrl,
        url: observedUrl,
        observedAt: new Date().toISOString(),
      };
      return null;
    }
    if (!String(body || '').trim()) {
      lastRenderObservation = {
        reason: 'empty-body',
        url: observedUrl,
        observedAt: new Date().toISOString(),
      };
      return null;
    }
    const detectedTransientState = detectReturnRefundTransientPageState(body);
    if (detectedTransientState?.kind === 'not-found') {
      const facts = extractReturnRefundFacts(body, {
        detailUrl: targetPage.url(),
        actionButtonVisible: false,
        ...extractOptions,
      });
      throw new ReturnRefundTerminalNotFoundError(
        detectedTransientState.message,
        { facts, signals: detectedTransientState.signals },
      );
    }
    // A platform rate limit takes precedence over any still-visible detail
    // controls. Back off before the render-recovery path can reload or click.
    if (detectedTransientState?.kind === 'rate-limited') {
      const configuredRetryMs = Number(options.rateLimitRetryMs
        ?? process.env.PDD_RATE_LIMIT_WAIT_MS ?? 180_000);
      throw new ReturnRefundTransientPageError('rate-limited', detectedTransientState.message, {
        retryAfterMs: Number.isFinite(configuredRetryMs)
          ? Math.max(30_000, configuredRetryMs) : 180_000,
      });
    }
    if (await hasVisiblePddLoadingState(targetPage)) {
      lastRenderObservation = {
        reason: 'visible-loading-state',
        url: targetPage.url(),
        bodyLength: String(body).length,
        observedAt: new Date().toISOString(),
      };
      return null;
    }
    const approveButton = await findApproveRefundAction(targetPage);
    const facts = extractReturnRefundFacts(body, {
      detailUrl: targetPage.url(),
      actionButtonVisible: Boolean(approveButton),
      ...extractOptions,
    });
    const extractedIdentity = {
      orderNumber: facts.orderNumber,
      aftersaleNumber: facts.aftersaleNumber,
    };
    for (const field of ['orderNumber', 'aftersaleNumber', 'aftersaleType', 'refundAmount']) {
      if (facts[field] == null && fallbackFacts?.[field] != null) facts[field] = fallbackFacts[field];
    }
    const hasIdentity = Boolean(facts.orderNumber && facts.aftersaleNumber);
    const hasCoreDetail = facts.aftersaleType === RETURN_REFUND_WORK_ORDER_TYPE
      && Number.isFinite(facts.refundAmount)
      && Boolean(facts.aftersaleStatus || facts.pageIndicatesCompleted || approveButton);
    // PDD terminal pages may omit the aftersale type after the refund closes.
    // A scoped terminal status is safe to accept for read-only reconciliation;
    // executable refunds still require the complete core detail above.
    const hasConfirmedTerminalDetail = confirmsReturnRefundCompletion(facts);
    if (hasIdentity && (hasCoreDetail || hasConfirmedTerminalDetail)) {
      lastRenderObservation = {
        reason: 'ready',
        url: targetPage.url(),
        observedAt: new Date().toISOString(),
      };
      return { body, facts };
    }
    const missingFields = [];
    if (!facts.orderNumber) missingFields.push('orderNumber');
    if (!facts.aftersaleNumber) missingFields.push('aftersaleNumber');
    if (facts.aftersaleType !== RETURN_REFUND_WORK_ORDER_TYPE
      && !hasConfirmedTerminalDetail) missingFields.push('aftersaleType');
    if (!Number.isFinite(facts.refundAmount) && !hasConfirmedTerminalDetail) {
      missingFields.push('refundAmount');
    }
    if (!facts.aftersaleStatus && !facts.pageIndicatesCompleted && !approveButton) {
      missingFields.push('aftersaleStatusOrAction');
    }
    lastRenderObservation = {
      reason: 'incomplete-detail-fields',
      url: targetPage.url(),
      bodyLength: String(body).length,
      missingFields,
      fallbackIdentityUsed: Boolean(
        fallbackFacts
        && ((!extractedIdentity.orderNumber && fallbackFacts.orderNumber)
          || (!extractedIdentity.aftersaleNumber && fallbackFacts.aftersaleNumber)),
      ),
      observed: {
        orderNumber: Boolean(facts.orderNumber),
        aftersaleNumber: Boolean(facts.aftersaleNumber),
        aftersaleType: facts.aftersaleType || null,
        refundAmount: Number.isFinite(facts.refundAmount),
        aftersaleStatus: Boolean(facts.aftersaleStatus),
        approveAction: Boolean(approveButton),
        terminal: hasConfirmedTerminalDetail,
      },
      observedAt: new Date().toISOString(),
    };
    return null;
  };
  const onRefresh = async (targetPage, stage, budget = {}) => {
    const loadTimeoutMs = Math.max(1, Math.min(
      30_000,
      Number(budget.remainingMs) || 30_000,
    ));
    await targetPage.waitForLoadState('domcontentloaded', { timeout: loadTimeoutMs }).catch(() => {});
    checkedDetailUrl(targetPage);
    if (expectedDetailUrl && !isReturnRefundDetailUrl(targetPage.url())) {
      await navigateReturnRefundPage(targetPage, expectedDetailUrl, {
        timeout: Math.min(45_000, Math.max(5_000, loadTimeoutMs)),
        expectedPath: '/aftersales-ssr/detail',
      });
    }
    if (budget.excludeFromBudget) {
      await budget.excludeFromBudget(() => options.onVerification?.(targetPage, stage));
    } else {
      await options.onVerification?.(targetPage, stage);
    }
    await dismissReturnRefundBlockingPromotion(targetPage, step);
  };
  const beforeReload = async (targetPage) => clickVisiblePddStalePageRefresh(targetPage, {
    cooldownMs: 0,
    settleMs: 700,
  });
  await step('return-refund-detail-ready');
  await dismissReturnRefundBlockingPromotion(page, step);
  const renderWaitMs = options.renderWaitMs ?? DEFAULT_PDD_RENDER_WAIT_MS;
  const initialRenderWaitMs = Math.min(
    20_000,
    Math.max(1, Math.floor(renderWaitMs * (2 / 3))),
  );
  let rendered;
  try {
    rendered = await waitForPddRenderedResult(page, {
      stage: 'return-refund-detail-load',
      timeoutMs: renderWaitMs,
      totalTimeoutMs: renderWaitMs,
      initialWaitMs: initialRenderWaitMs,
      reloadOptions: { waitUntil: 'commit', timeout: 45_000 },
      onVerification: (targetPage, stage) => options.onVerification?.(targetPage, stage),
      beforeReload,
      inspect: readRenderedSnapshot,
      onRefresh: (targetPage, budget) => onRefresh(
        targetPage,
        'return-refund-detail-after-refresh',
        budget,
      ),
    });
  } catch (error) {
    if (error instanceof PddRenderWaitTimeoutError) {
      error.renderObservation = lastRenderObservation;
    }
    throw error;
  }
  await step('return-refund-detail-rendered', null, { refreshed: rendered.refreshed });
  // After approval, only the rendered status, exact identity and remaining
  // approve action determine the result. Reopening the logistics drawer adds
  // clicks without strengthening that proof. Pre-submit reads still collect
  // logistics below; this flag is used only by the bounded submission check.
  if (options.postSubmissionResultOnly === true) {
    await step('return-refund-submission-result-read', null, {
      terminal: confirmsReturnRefundCompletion(rendered.facts),
    });
    return rendered.facts;
  }
  let returnLogistics = await visibleLocator(page.getByText('退货物流', { exact: true }));
  if (returnLogistics) {
    await step('return-refund-select-return-logistics', async () => {
      try {
        await returnLogistics.click({ timeout: 5_000 });
      } catch (error) {
        if (!/intercepts pointer events|Timeout/u.test(String(error?.message || error))) throw error;
        await dismissReturnRefundBlockingPromotion(page, step);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(400);
        returnLogistics = await visibleLocator(page.getByText('退货物流', { exact: true }));
        if (!returnLogistics) return;
        await returnLogistics.click({ force: true, timeout: 10_000 });
      }
    });
  }
  await dismissReturnRefundBlockingPromotion(page, step);
  const viewAll = await visibleLocator(page.getByText(/查看全部/u));
  if (viewAll) {
    await step('return-refund-expand-logistics', async () => {
      try {
        await viewAll.click({ timeout: 5_000 });
      } catch (error) {
        if (!/intercepts pointer events|Timeout/u.test(String(error?.message || error))) throw error;
        await dismissReturnRefundBlockingPromotion(page, step);
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(400);
        const liveViewAll = await visibleLocator(page.getByText(/查看全部/u));
        if (!liveViewAll) return;
        await liveViewAll.click({ force: true, timeout: 10_000 });
      }
    });
  }
  else await step('return-refund-logistics-already-expanded');
  const logisticsRegion = await readReturnLogisticsRegion(page);
  await step('return-refund-logistics-region-read', null, {
    status: logisticsRegion.status,
    strategy: logisticsRegion.strategy,
    lineCount: logisticsRegion.lineCount,
  });
  const postInteractionOptions = {
    fallbackFacts: rendered.facts,
    returnLogisticsText: logisticsRegion.text,
    returnLogisticsSource: {
      status: logisticsRegion.status,
      strategy: logisticsRegion.strategy,
      lineCount: logisticsRegion.lineCount,
      textSha256: logisticsRegion.text
        ? crypto.createHash('sha256').update(logisticsRegion.text).digest('hex')
        : null,
    },
  };
  let postInteraction;
  try {
    postInteraction = await waitForPddRenderedResult(page, {
      stage: 'return-refund-detail-after-logistics',
      timeoutMs: renderWaitMs,
      totalTimeoutMs: renderWaitMs,
      initialWaitMs: initialRenderWaitMs,
      reloadOptions: { waitUntil: 'commit', timeout: 45_000 },
      onVerification: (targetPage, stage) => options.onVerification?.(targetPage, stage),
      beforeReload,
      inspect: (targetPage) => readRenderedSnapshot(targetPage, postInteractionOptions),
      onRefresh: (targetPage, budget) => onRefresh(
        targetPage,
        'return-refund-detail-after-logistics-refresh',
        budget,
      ),
    });
  } catch (error) {
    // The logistics drawer is an optional read-only enrichment. PDD can leave
    // the detail shell in a loading state after the drawer refresh even though
    // the initial detail was complete. When that initial snapshot proves there
    // is still no substantive return logistics, retain it and let the existing
    // no-logistics policy decide; never turn a safe wait into a page-error.
    const initialFacts = rendered.facts || {};
    const logisticsEvents = extractLogisticsTimeline(logisticsRegion.text || '')
      .filter(isSubstantiveLogisticsEvent);
    const canUseInitialDetail = error instanceof PddRenderWaitTimeoutError
      && initialFacts.orderNumber
      && initialFacts.aftersaleNumber
      && initialFacts.aftersaleType === RETURN_REFUND_WORK_ORDER_TYPE
      && Number.isFinite(initialFacts.refundAmount)
      && initialFacts.actionButtonVisible === true
      && initialFacts.pageIndicatesCompleted !== true
      && initialFacts.hasReturnLogistics !== true
      && logisticsEvents.length === 0;
    if (!canUseInitialDetail) throw error;
    await step('return-refund-detail-after-logistics-fallback', null, {
      reason: 'initial-detail-complete-without-substantive-logistics',
      initialOrderNumber: initialFacts.orderNumber,
      initialAftersaleNumber: initialFacts.aftersaleNumber,
      renderObservation: error.renderObservation || null,
    });
    return initialFacts;
  }
  const facts = postInteraction.facts;
  for (const field of [
    'orderNumber',
    'aftersaleNumber',
    'aftersaleType',
    'aftersaleStatus',
    'refundAmount',
  ]) {
    if (facts[field] != null || rendered.facts[field] == null) continue;
    facts[field] = rendered.facts[field];
    const renderedSource = rendered.facts.evidence?.fieldSources?.[field];
    if (renderedSource && facts.evidence?.fieldSources) {
      facts.evidence.fieldSources[field] = renderedSource;
    }
  }
  return facts;
};

export const isRecoverableReturnRefundDetailFailure = (error) => {
  if (error instanceof PddRenderWaitTimeoutError) return true;
  // A renderer/browser restart can close the resident detail tab after the
  // facts have been read but before the optional logistics refresh finishes.
  // This is a transient page loss; reopen the exact order from the workbench
  // instead of recording a permanent page error.
  return /Target page, context or browser has been closed|Target page has been closed|page\.waitForTimeout: Target page/iu
    .test(String(error?.message || error || ''));
};

export const classifyReturnRefundSubmission = (submission, {
  expectedOrderNumber,
  expectedAftersaleNumber,
} = {}) => {
  const facts = submission?.facts || {};
  const exactIdentity = Boolean(
    expectedOrderNumber
    && expectedAftersaleNumber
    && facts.orderNumber === expectedOrderNumber
    && facts.aftersaleNumber === expectedAftersaleNumber,
  );
  if (submission?.confirmed === true) {
    let exactDetailUrl = false;
    try {
      const detailUrl = new URL(String(facts.detailUrl || ''));
      exactDetailUrl = isReturnRefundDetailUrl(detailUrl.href)
        && detailUrl.searchParams.get('orderSn') === expectedOrderNumber
        && detailUrl.searchParams.get('id') === expectedAftersaleNumber;
    } catch { /* A missing or malformed detail URL cannot confirm a refund. */ }
    return exactIdentity && exactDetailUrl && confirmsReturnRefundCompletion(facts)
      ? { effectStatus: 'succeeded', retryable: false, reason: 'pdd-result-confirmed' }
      : { effectStatus: 'unknown', retryable: false, reason: 'pdd-result-not-confirmed' };
  }
  const statusSource = facts.evidence?.fieldSources?.aftersaleStatus?.source;
  const explicitlyPending = labeledAftersaleStatusSources.has(statusSource)
    && returnRefundPendingStatusPattern.test(normalizeText(facts.aftersaleStatus))
    && !returnRefundTerminalStatusPattern.test(normalizeText(facts.aftersaleStatus));
  const confirmationNotDispatched = submission?.approveClicked === true
    && submission?.confirmationFound === false
    && submission?.confirmationClicked === false
    && submission?.confirmationDispatchStarted !== true;
  const repeatedlyRefreshed = Number(submission?.postconditionRefreshCount || 0) >= 3;
  if (confirmationNotDispatched
    && repeatedlyRefreshed
    && exactIdentity
    && explicitlyPending
    && facts.actionButtonVisible === true) {
    return {
      effectStatus: 'failed',
      retryable: true,
      reason: 'pdd-confirmation-not-dispatched',
    };
  }
  return { effectStatus: 'unknown', retryable: false, reason: 'pdd-result-not-confirmed' };
};

export const classifyExistingReturnRefundEffect = (facts, {
  existingEffectStatus = null,
  existingEffectReceipt = null,
  existingEffectError = null,
  existingEffectReservedAt = null,
  expectedOrderNumber = null,
  expectedAftersaleNumber = null,
  now = Date.now(),
} = {}) => {
  if (confirmsReturnRefundCompletion(facts)) {
    return { effectStatus: 'succeeded', retryable: false, reason: 'pdd-result-confirmed' };
  }
  const reservedAtMs = Date.parse(String(existingEffectReservedAt || ''));
  const observedAtMs = Date.parse(String(facts?.evidence?.capturedAt || ''));
  const currentObservationMs = Number.isFinite(observedAtMs) ? observedAtMs : Number(now);
  const uncertainEffectIsMature = Number.isFinite(reservedAtMs)
    && Number.isFinite(currentObservationMs)
    && currentObservationMs - reservedAtMs >= RETURN_REFUND_UNKNOWN_EFFECT_MIN_AGE_MS;
  const staleReservedEffect = existingEffectStatus === 'reserved' && uncertainEffectIsMature;
  if (existingEffectStatus !== 'unknown' && !staleReservedEffect) {
    return { effectStatus: 'unknown', retryable: false, reason: 'existing-effect-not-releasable' };
  }

  const statusSource = facts?.evidence?.fieldSources?.aftersaleStatus?.source;
  const observedStatus = normalizeText(facts?.aftersaleStatus);
  const exactIdentity = Boolean(
    expectedOrderNumber
    && expectedAftersaleNumber
    && facts?.orderNumber === expectedOrderNumber
    && facts?.aftersaleNumber === expectedAftersaleNumber,
  );
  const exactScopedPending = exactIdentity
    && labeledAftersaleStatusSources.has(statusSource)
    && returnRefundPendingStatusPattern.test(observedStatus)
    && !returnRefundTerminalStatusPattern.test(observedStatus);
  const exactActionablePending = exactScopedPending
    && facts?.actionButtonVisible === true;
  const exactCounterpartyPendingWithoutMerchantAction = exactScopedPending
    && facts?.actionButtonVisible === false
    && returnRefundCounterpartyPendingStatusPattern.test(observedStatus);
  const exactMerchantPending = exactActionablePending
    && returnRefundMerchantPendingStatusPattern.test(observedStatus);
  if (!exactActionablePending && !exactCounterpartyPendingWithoutMerchantAction) {
    return { effectStatus: 'unknown', retryable: false, reason: 'pdd-result-not-confirmed' };
  }

  const submission = existingEffectReceipt?.submission;
  if (exactActionablePending && submission && typeof submission === 'object') {
    const confirmationDispatched = submission.confirmationDispatchStarted === true
      || submission.confirmationClicked === true;
    if (!confirmationDispatched) {
      return {
        effectStatus: 'failed',
        retryable: true,
        reason: 'existing-pdd-confirmation-not-dispatched',
      };
    }
    const classification = classifyReturnRefundSubmission({ ...submission, facts }, {
      expectedOrderNumber,
      expectedAftersaleNumber,
    });
    if (classification.effectStatus === 'failed' && classification.retryable) {
      return { ...classification, reason: 'existing-pdd-confirmation-not-dispatched' };
    }
  }

  const legacyErrorReason = String(existingEffectError?.reason || '');
  const legacyErrorMessage = String(existingEffectError?.message || '');
  const legacyConfirmationLocatorTimeout = legacyErrorReason === 'pdd-return-refund-exception'
    && /locator[.]click:\s*Timeout/u.test(legacyErrorMessage)
    && /getByRole\('button'/u.test(legacyErrorMessage)
    && /(?:确认退款|同意退款)/u.test(legacyErrorMessage);
  if (legacyConfirmationLocatorTimeout && !submission && exactMerchantPending) {
    return {
      effectStatus: 'failed',
      retryable: true,
      reason: 'legacy-pdd-confirmation-not-dispatched',
    };
  }

  const receiptAftersaleNumber = normalizeText(existingEffectReceipt?.aftersaleNumber);
  const legacyUnknownHasNoDispatchEvidence = !submission
    && existingEffectStatus === 'unknown'
    && String(existingEffectError?.reason || '') === 'pdd-result-not-confirmed'
    && (!receiptAftersaleNumber || receiptAftersaleNumber === expectedAftersaleNumber);
  const dispatchedConfirmationNeedsProof = submission?.confirmationDispatchStarted === true
    || submission?.confirmationClicked === true;
  if ((legacyUnknownHasNoDispatchEvidence || dispatchedConfirmationNeedsProof || staleReservedEffect)
    && uncertainEffectIsMature) {
    const previousProof = existingEffectReceipt?.reconciliationProof;
    const proofStrategy = exactCounterpartyPendingWithoutMerchantAction
      ? 'exact-counterparty-pending-no-action-after-unknown'
      : 'exact-merchant-pending-after-unknown';
    const proofWaitingReason = exactCounterpartyPendingWithoutMerchantAction
      ? 'pdd-exact-counterparty-pending-no-action-proof-waiting'
      : 'pdd-exact-pending-proof-waiting';
    const proofConfirmedReason = exactCounterpartyPendingWithoutMerchantAction
      ? 'pdd-exact-counterparty-pending-no-action-after-unknown-confirmed'
      : 'pdd-exact-pending-after-unknown-confirmed';
    const sameProofIdentity = previousProof?.strategy === proofStrategy
      && previousProof?.orderNumber === expectedOrderNumber
      && previousProof?.aftersaleNumber === expectedAftersaleNumber
      && normalizeText(previousProof?.observedStatus) === observedStatus;
    const firstObservedAtMs = sameProofIdentity
      ? Date.parse(String(previousProof.firstObservedAt || previousProof.observedAt || ''))
      : Number.NaN;
    const firstObservedAt = Number.isFinite(firstObservedAtMs)
      ? new Date(firstObservedAtMs).toISOString()
      : new Date(currentObservationMs).toISOString();
    const proofAgeMs = Number.isFinite(firstObservedAtMs)
      ? currentObservationMs - firstObservedAtMs
      : 0;
    const pendingProof = {
      strategy: proofStrategy,
      orderNumber: expectedOrderNumber,
      aftersaleNumber: expectedAftersaleNumber,
      observedStatus,
      actionButtonVisible: facts.actionButtonVisible,
      firstObservedAt,
      observedAt: new Date(currentObservationMs).toISOString(),
      recheckAfterAt: new Date(
        Math.max(currentObservationMs, Date.parse(firstObservedAt))
          + Math.max(0, RETURN_REFUND_UNKNOWN_PROOF_GAP_MS - Math.max(0, proofAgeMs)),
      ).toISOString(),
    };
    if (sameProofIdentity && proofAgeMs >= RETURN_REFUND_UNKNOWN_PROOF_GAP_MS) {
      if (dispatchedConfirmationNeedsProof && exactMerchantPending) {
        return {
          effectStatus: 'unknown',
          retryable: false,
          disposition: 'manual-review',
          reason: 'pdd-dispatched-confirmation-still-pending-manual-review',
          pendingProof,
        };
      }
      return {
        effectStatus: 'failed',
        retryable: !exactCounterpartyPendingWithoutMerchantAction,
        reason: proofConfirmedReason,
        ...(exactCounterpartyPendingWithoutMerchantAction
          ? { disposition: 'wait-logistics' }
          : {}),
        pendingProof,
      };
    }
    return {
      effectStatus: 'unknown',
      retryable: false,
      reason: proofWaitingReason,
      pendingProof,
    };
  }

  if (dispatchedConfirmationNeedsProof) {
    return {
      effectStatus: 'unknown',
      retryable: false,
      reason: 'pdd-confirmation-dispatched-awaiting-proof-window',
    };
  }

  return { effectStatus: 'unknown', retryable: false, reason: 'pdd-result-not-confirmed' };
};

const summarizeReturnRefundSubmission = (submission = {}) => ({
  approveClicked: submission.approveClicked === true,
  confirmationFound: submission.confirmationFound === true,
  acknowledgementFound: submission.acknowledgementFound === true,
  acknowledgementClicked: submission.acknowledgementClicked === true,
  acknowledgementChecked: submission.acknowledgementChecked === true,
  confirmationClicked: submission.confirmationClicked === true,
  confirmationText: submission.confirmationText || null,
  confirmationDispatchStarted: submission.confirmationDispatchStarted === true,
  postconditionRefreshCount: Number(submission.postconditionRefreshCount || 0),
  postconditionRecoveredUnderVerification:
    submission.postconditionRecoveredUnderVerification === true,
});

export const readReturnRefundCompletionUnderVerification = async (
  page,
  { expectedFacts = null } = {},
) => {
  const bodyLocator = page.locator('body');
  const body = await bodyLocator.innerText({ timeout: 3_000 }).catch(async () => (
    bodyLocator.textContent({ timeout: 3_000 }).catch(() => '')
  ));
  if (!String(body || '').trim()) return null;
  const approveButton = await findApproveRefundAction(page);
  const facts = extractReturnRefundFacts(body, {
    detailUrl: page.url(),
    actionButtonVisible: Boolean(approveButton),
  });
  const expectedOrderNumber = String(expectedFacts?.orderNumber || '').trim();
  const expectedAftersaleNumber = String(expectedFacts?.aftersaleNumber || '').trim();
  if ((expectedOrderNumber && facts.orderNumber !== expectedOrderNumber)
    || (expectedAftersaleNumber && facts.aftersaleNumber !== expectedAftersaleNumber)) {
    return null;
  }
  return confirmsReturnRefundCompletion(facts) ? facts : null;
};

export const submitReturnRefund = async (page, options = {}) => {
  const step = createVisiblePddStep(page, options);
  // Allow PDD's accepted refund to settle before the first result reload.
  // Exact completion already visible on this page still returns immediately.
  const firstRefreshWaitMs = Math.max(0, Number(options.postconditionFirstRefreshWaitMs ?? 25_000));
  const laterRefreshWaitMs = Math.max(0, Number(options.postconditionLaterRefreshWaitMs ?? 8_000));
  // The PDD slider can mount a few milliseconds after the detail page has
  // rendered.  In that window the approve button is still discoverable, but
  // its click is intercepted by the challenge modal.  Treat that surface as
  // a verification gate instead of recording a generic page error.  The
  // callback owns the existing pause/focus/timeout policy; this guard only
  // observes the page and hands control to it.
  const waitForApproveVerification = async (stage) => {
    const detection = await detectHumanVerification(page).catch(() => null);
    if (!detection) return false;
    if (typeof options.onVerification === 'function') {
      await options.onVerification(page, stage);
      return true;
    }
    const error = new Error(`同意退款前检测到人工验证（阶段: ${stage}）`);
    error.name = 'HumanVerificationRequiredError';
    error.code = 'PDD_HUMAN_VERIFICATION_REQUIRED';
    throw error;
  };
  const isVerificationIntercept = (error) => {
    const message = String(error?.message || error || '');
    return /intercepts pointer events|beast-core-modal|slider-img-bg|验证码|滑块|安全验证/iu.test(message);
  };
  const submission = {
    confirmed: false,
    approveClicked: false,
    confirmationFound: false,
    acknowledgementFound: false,
    acknowledgementClicked: false,
    acknowledgementChecked: false,
    confirmationClicked: false,
    confirmationDispatchStarted: false,
    confirmationText: null,
    postconditionRefreshCount: 0,
    facts: null,
  };
  let submitActionAt = 0;
  const observeExactCompletion = async () => {
    if (!options.expectedFacts?.orderNumber || !options.expectedFacts?.aftersaleNumber) return false;
    const facts = await readReturnRefundCompletionUnderVerification(page, {
      expectedFacts: options.expectedFacts,
    });
    if (!facts) return false;
    const classification = classifyReturnRefundSubmission({ confirmed: true, facts }, {
      expectedOrderNumber: options.expectedFacts.orderNumber,
      expectedAftersaleNumber: options.expectedFacts.aftersaleNumber,
    });
    if (classification.effectStatus !== 'succeeded') return false;
    submission.facts = facts;
    submission.confirmed = true;
    return true;
  };
  try {
    await step('return-refund-submit-ready');
    await dismissReturnRefundBlockingPromotion(page, step);
    await waitForApproveVerification('return-refund-click-approve-verification');
    let approveButton = await findApproveRefundAction(page);
    if (!approveButton) throw new Error('执行前未找到“同意退款”按钮');
    try {
      await step('return-refund-click-approve', () => approveButton.click(), {}, {
        retryAfterVerification: false,
      });
    } catch (error) {
      // A challenge may appear between the guard and the actual pointer
      // dispatch. Re-check only for the known interception signatures. If it
      // is a challenge, wait on the same page and retry the still-unsubmitted
      // primary action once; all other errors retain their old behavior.
      if (!isVerificationIntercept(error)) throw error;
      const detected = await detectHumanVerification(page).catch(() => null);
      if (!detected) throw error;
      await options.onVerification?.(page, 'return-refund-click-approve-action-error');
      approveButton = await findApproveRefundAction(page);
      if (!approveButton) throw error;
      await step('return-refund-click-approve-retry-after-verification', () => approveButton.click(), {}, {
        retryAfterVerification: false,
      });
    }
    submission.approveClicked = true;
    submitActionAt = Date.now();
    let confirmation = await findReturnRefundConfirmationAction(page);
    submission.confirmationFound = Boolean(confirmation);
    submission.confirmationText = confirmation?.text?.slice(0, 200) || null;
    if (confirmation) {
      submission.acknowledgementFound = Boolean(confirmation.acknowledgement);
      if (confirmation.acknowledgement) {
        await step('return-refund-confirm-acknowledgement', async () => {
          submission.acknowledgementClicked = await clickReturnRefundAcknowledgementOnce(
            confirmation.acknowledgement,
            {
              resolveAcknowledgement: async () => (
                await findReturnRefundConfirmationAction(page, { timeoutMs: 0 })
              )?.acknowledgement || null,
            },
          );
        }, {
          confirmationText: submission.confirmationText,
        });
        await page.waitForTimeout(300);
        confirmation = await findReturnRefundConfirmationAction(page, { timeoutMs: 2_000 });
        if (!confirmation) throw new Error('勾选退款确认项后确认框消失，无法安全提交');
        submission.acknowledgementChecked = await isReturnRefundAcknowledgementChecked(
          confirmation.acknowledgement,
        );
        if (!submission.acknowledgementChecked) {
          throw new Error('“我确认同意退款”选择后未保持勾选，禁止提交');
        }
      }
      await step('return-refund-confirm-approve', async () => {
        await clickReturnRefundConfirmationActionOnce(confirmation, {
          timeoutMs: options.renderWaitMs ?? RETURN_REFUND_CONFIRM_ENABLE_WAIT_MS,
          onWait: () => options.onVerification?.(page, 'return-refund-confirm-enable-wait'),
          resolveConfirmation: () => findReturnRefundConfirmationAction(page, { timeoutMs: 0 }),
          maintainAcknowledgement: submission.acknowledgementFound,
          onDispatch: () => {
            submission.confirmationDispatchStarted = true;
            submitActionAt = Date.now();
          },
        });
        submission.confirmationClicked = true;
      }, {
        confirmationText: submission.confirmationText,
      }, {
        retryAfterVerification: false,
      });
    }
    await step('return-refund-wait-result', async () => {
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        await options.onVerification?.(page, 'return-refund-wait-result');
        const action = await findApproveRefundAction(page);
        const body = compactText(await page.locator('body').innerText().catch(() => ''));
        if (!action || /(?:退款成功|本单退款成功|已同意退款|退款完成|售后完成|售后关闭|已退款)/u.test(body)) return;
        await page.waitForTimeout(500);
      }
    });

    // The same aftersale can already render its terminal result after the
    // confirmation click. Read that exact result before navigating again.
    if (await observeExactCompletion()) return submission;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const waitMs = attempt === 1
        ? Math.max(0, firstRefreshWaitMs - (Date.now() - submitActionAt))
        : laterRefreshWaitMs;
      if (waitMs > 0) await page.waitForTimeout(waitMs);
      if (await observeExactCompletion()) return submission;
      await step('return-refund-refresh-after-approve', () => page.reload({
        waitUntil: 'commit', timeout: 45_000,
      }), { attempt });
      submission.facts = await readReturnRefundDetail(page, {
        ...options, postSubmissionResultOnly: true,
      });
      submission.postconditionRefreshCount += 1;
      // PDD can remain in the transitional "退款中" state after accepting the
      // refund. The durable completion signal is the explicit terminal state
      // on the exact aftersale detail with no approve action.
      submission.confirmed = confirmsReturnRefundCompletion(submission.facts);
      if (submission.confirmed) return submission;
    }
    return submission;
  } catch (error) {
    if (submission.confirmationDispatchStarted || submission.confirmationClicked) {
      const terminalFacts = await readReturnRefundCompletionUnderVerification(page, {
        expectedFacts: options.expectedFacts,
      }).catch(() => null);
      if (terminalFacts) {
        submission.facts = terminalFacts;
        submission.confirmed = true;
        submission.postconditionRecoveredUnderVerification = true;
        return submission;
      }
    }
    error.returnRefundSubmission = { ...submission };
    throw error;
  }
};

const waitForReturnRefundListState = async (
  page,
  options,
  timeoutMs = options.renderWaitMs ?? DEFAULT_PDD_RENDER_WAIT_MS,
) => waitForPddRenderedResult(page, {
  stage: '退货退款列表加载',
  timeoutMs,
  onVerification: (targetPage, stage) => options.onVerification?.(targetPage, stage),
  beforeReload: (targetPage) => clickVisiblePddStalePageRefresh(targetPage, {
    cooldownMs: 0,
    settleMs: 700,
  }),
  inspect: async (targetPage) => {
    if (isPddLoginUrl(targetPage.url())) {
      const error = new Error(`拼多多退款列表已跳转登录页（URL: ${targetPage.url()}）`);
      error.code = 'PDD_LOGIN_REQUIRED';
      throw error;
    }
    if (await hasVisiblePddLoadingState(targetPage)) return null;
    const detailActions = returnRefundListDetailActions(targetPage);
    const count = await detailActions.count().catch(() => 0);
    if (await visibleLocator(detailActions)) return { detailActions, count, empty: false };

    const emptyState = await visibleLocator(targetPage.getByText(
      /(?:暂无数据|暂无待处理|暂无相关|暂时没有|没有相关的?退货退款|当前没有待处理)/u,
    ));
    return emptyState ? { detailActions, count: 0, empty: true } : null;
  },
  onRefresh: async (targetPage) => {
    await options.onVerification?.(targetPage, 'return-refund-list-after-refresh');
    await openReturnRefundWorkbench(targetPage, options);
  },
});

export const findMatchingReturnRefundDetailAction = async (page, {
  orderNumber = null,
  aftersaleNumber = null,
} = {}) => {
  const identifiers = [orderNumber, aftersaleNumber]
    .map((value) => compactText(value))
    .filter(Boolean);
  if (!identifiers.length) return null;

  const detailActions = returnRefundListDetailActions(page);
  const count = await detailActions.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const action = detailActions.nth(index);
    if (!await action.isVisible().catch(() => false)) continue;
    const belongsToMatchingRow = await action.evaluate((element, expectedIdentifiers) => {
      const normalized = (value) => String(value || '')
        .normalize('NFKC')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      const isDetailAction = (candidate) => normalized(
        candidate.innerText || candidate.textContent,
      ) === '查看详情';
      let current = element;
      for (let depth = 0; current && depth < 12; depth += 1, current = current.parentElement) {
        const text = normalized(current.innerText || current.textContent);
        if (!expectedIdentifiers.some((identifier) => text.includes(identifier))) continue;
        const detailActionCount = [current, ...current.querySelectorAll(
          'button, a, [role="button"], [role="link"]',
        )].filter(isDetailAction).length;
        // Reject table-wide ancestors. Otherwise every action would appear to
        // match merely because another row contains the requested identifier.
        if (detailActionCount === 1) return true;
      }
      return false;
    }, identifiers).catch(() => false);
    if (belongsToMatchingRow) return action;
  }
  return null;
};

export const reopenReturnRefundDetailFromWorkbench = async (page, context, {
  orderNumber,
  aftersaleNumber,
  maxPages = 10,
  maxDurationMs = 60_000,
  ...options
} = {}) => {
  if (!orderNumber && !aftersaleNumber) return null;
  let verificationWaitMs = 0;
  const originalOnVerification = options.onVerification;
  const recoveryOptions = {
    ...options,
    onVerification: originalOnVerification ? async (targetPage, stage) => {
      const verificationStartedAt = Date.now();
      try {
        return await originalOnVerification(targetPage, stage);
      } finally {
        verificationWaitMs += Date.now() - verificationStartedAt;
      }
    } : null,
  };
  const step = createVisiblePddStep(page, recoveryOptions);
  const startedAt = Date.now();
  const activeElapsedMs = () => Date.now() - startedAt - verificationWaitMs;
  await openReturnRefundWorkbench(page, recoveryOptions);
  const seenPages = new Set();

  for (let pageNumber = 1; pageNumber <= maxPages
    && activeElapsedMs() < maxDurationMs; pageNumber += 1) {
    const { empty } = await waitForReturnRefundListState(
      page,
      recoveryOptions,
      Math.min(recoveryOptions.renderWaitMs ?? DEFAULT_PDD_RENDER_WAIT_MS, 15_000),
    );
    if (empty) return null;
    const signature = await returnRefundPageSignature(page);
    if (signature && seenPages.has(signature)) return null;
    if (signature) seenPages.add(signature);

    const action = await findMatchingReturnRefundDetailAction(page, {
      orderNumber,
      aftersaleNumber,
    });
    if (action) {
      const listUrl = page.url();
      const pagesBefore = new Set(context.pages());
      await step('return-refund-reopen-matching-detail', () => (
        clickPddActionWithoutForegroundPopup(page, action)
      ), { orderNumber, aftersaleNumber, pageNumber });
      const popup = await waitForReturnRefundDetailTarget(page, context, pagesBefore, { listUrl });
      const detailPage = popup || page;
      await detailPage.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
      return { page: detailPage, popup: Boolean(popup), pageNumber };
    }

    const nextPage = await findNextReturnRefundPageAction(page);
    if (!nextPage) return null;
    await step('return-refund-recovery-next-page', () => nextPage.click(), { pageNumber });
    const previousSignature = signature;
    const pageChangeDeadline = Math.min(
      Date.now() + 15_000,
      Date.now() + Math.max(0, maxDurationMs - activeElapsedMs()),
    );
    let nextSignature = previousSignature;
    while (Date.now() < pageChangeDeadline && nextSignature === previousSignature) {
      await recoveryOptions.onVerification?.(page, 'return-refund-recovery-page-change');
      await page.waitForTimeout(300);
      nextSignature = await returnRefundPageSignature(page);
    }
    if (!nextSignature || nextSignature === previousSignature) return null;
  }
  return null;
};

const returnRefundListMemory = new WeakMap();
const listResponseMemoryForPage = (page) => {
  if (typeof page?.on !== 'function' || typeof page?.mainFrame !== 'function') return null;
  let memory = returnRefundListMemory.get(page);
  if (!memory) {
    memory = { generation: 0, cache: null };
    returnRefundListMemory.set(page, memory);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) { memory.generation += 1; memory.cache = null; }
    });
    page.on('close', () => { memory.cache = null; });
  }
  return memory;
};

export const collectReturnRefundCandidates = async (page, context, {
  maxItems = 10,
  maxKnownSkippedItems = 0,
  maxDurationMs = 120_000,
  scanCursor = null,
  resumeProof = null,
  ...options
} = {}) => {
  const startedAt = Date.now();
  let verificationWaitMs = 0;
  const originalOnVerification = options.onVerification;
  const scanOptions = {
    ...options,
    onVerification: originalOnVerification ? async (targetPage, stage) => {
      const verificationStartedAt = Date.now();
      try {
        return await originalOnVerification(targetPage, stage);
      } finally {
        verificationWaitMs += Date.now() - verificationStartedAt;
      }
    } : null,
  };
  const listResponseObserver = createReturnRefundListResponseObserver(page);
  const listMemory = listResponseMemoryForPage(page);
  let lastMatchedListResponse = null;
  try {
  const activeElapsedMs = () => Date.now() - startedAt - verificationWaitMs;
  const results = [];
  const seen = new Set();
  const seenPages = new Set();
  const deferredRefundLookup = new Map();
  for (const item of Array.isArray(scanOptions.deferredRefunds)
    ? scanOptions.deferredRefunds : []) {
    if (!/^\d{6}-\d{12,}$/u.test(String(item?.orderNumber || ''))
      || !/^\d{8,18}$/u.test(String(item?.aftersaleNumber || ''))) continue;
    const nextCheckAt = Date.parse(String(item?.nextCheckAt || ''));
    if (!Number.isFinite(nextCheckAt)) continue;
    const key = `${item.orderNumber}\u0000${item.aftersaleNumber}`;
    deferredRefundLookup.set(key, Math.min(
      deferredRefundLookup.get(key) || Infinity, nextCheckAt,
    ));
  }
  const completedRefundLookup = new Set();
  for (const item of Array.isArray(scanOptions.completedRefunds)
    ? scanOptions.completedRefunds : []) {
    if (!/^\d{6}-\d{12,}$/u.test(String(item?.orderNumber || ''))
      || !/^\d{8,18}$/u.test(String(item?.aftersaleNumber || ''))) continue;
    completedRefundLookup.add(`${item.orderNumber}\u0000${item.aftersaleNumber}`);
  }
  const listIdentityDiagnostics = {
    rowsWithoutAftersaleNumber: 0,
    rowsWithAttributeCandidates: 0,
    candidatesMatchedDetail: 0,
    sources: {},
    rowsWithOrderNumber: 0,
    rowsWhoseOrderExistsInResponse: 0,
  };
  const listResponseDiagnostics = {
    pagesWithResponse: 0,
    pagesWithCountMatch: 0,
    pagesWithCountMismatch: 0,
    pagesWithUniqueExtraActionMatch: 0,
    lastResponseItemCount: null,
    lastRenderedActionCount: null,
    rowsWithMatchingOrder: 0,
    rowsSkippedKnownCompleted: 0,
    rowsSkippedKnownWait: 0,
    pagesWithReusedListResponse: 0,
    rowsSkippedKnownWaitByCapturedTarget: 0,
    rowsSkippedKnownCompletedByCapturedTarget: 0,
    detailsWithMatchingAftersaleId: 0,
    detailsWithMismatchedAftersaleId: 0,
  };
  let pageEnteredAt = startedAt;
  const requestedCursor = normalizeReturnRefundScanCursor(scanCursor);
  let currentPage = 1;
  // A cursor saved by the old global selector may include a message action
  // before a real row. Recheck the current page from its first row once when
  // no persisted cursor scope or live proof survives. Losing a browser page
  // must not repeatedly upgrade an already migrated durable cursor.
  const cursorScopeReset = requestedCursor.itemOffset > 0
    && scanCursor?.actionScope !== RETURN_REFUND_LIST_ACTION_SCOPE
    && resumeProof?.actionScope !== RETURN_REFUND_LIST_ACTION_SCOPE;
  let firstPageItemOffset = cursorScopeReset ? 0 : requestedCursor.itemOffset;
  let cursorWrapped = false;
  let nextCursor = { page: requestedCursor.page, itemOffset: requestedCursor.itemOffset };
  let examined = 0;
  let budgetedItems = 0;
  let knownSkippedAllowanceUsed = 0;
  const knownSkippedAllowance = Math.max(0, Math.min(20,
    Math.floor(Number(maxKnownSkippedItems) || 0)));
  const discountKnownListSkip = () => {
    // Only a proved, exact list-row skip can use this allowance. Unknown
    // identities and any attempted detail opening retain the normal budget.
    if (knownSkippedAllowanceUsed >= knownSkippedAllowance) return;
    knownSkippedAllowanceUsed += 1;
    budgetedItems -= 1;
  };
  await closeStaleReturnRefundDetailPages(context, {
    anchorPage: page,
    protectedPages: scanOptions.protectedPages,
  });
  let resumed = false;
  const resumeCheck = {
    attempted: false,
    resumed: false,
    reason: resumeProof ? 'not-list-page' : 'no-saved-proof',
    requestedCursor,
    previousPage: resumeProof?.page || null,
    cursorScopeReset,
  };
  if (resumeProof && page.url().includes('/aftersales/aftersale_list')) {
    resumeCheck.attempted = true;
    await scanOptions.onVerification?.(page, 'return-refund-resume-check');
    await waitForReturnRefundListState(page, scanOptions);
    const observedProof = await readReturnRefundScanResumeProof(page, requestedCursor);
    resumed = matchesReturnRefundScanResumeProof(resumeProof, observedProof, requestedCursor);
    Object.assign(resumeCheck, {
      resumed,
      reason: resumed ? 'verified' : observedProof ? 'proof-mismatch' : 'list-proof-unavailable',
      previousAgeMs: Number.isFinite(Date.parse(resumeProof.capturedAt))
        ? Date.now() - Date.parse(resumeProof.capturedAt) : null,
      observedPage: observedProof?.page || null,
      previousRowCount: resumeProof.rowCount,
      observedRowCount: observedProof?.rowCount || null,
      excludedMessageActionCount: observedProof?.excludedMessageActionCount ?? null,
      sameUrl: observedProof ? resumeProof.urlSha256 === observedProof.urlSha256 : null,
      sameRows: observedProof ? resumeProof.rowsSha256 === observedProof.rowsSha256 : null,
      sameRowsExceptCountdown: observedProof
        ? sameReturnRefundRowsExceptCountdown(resumeProof, observedProof) : null,
      rowTextComparison: resumeProof.rowTextDiagnostics?.version === 1
        && observedProof?.rowTextDiagnostics?.version === 1 ? {
          sameOrderSequence: resumeProof.rowTextDiagnostics.orderSequenceSha256
            === observedProof.rowTextDiagnostics.orderSequenceSha256,
          sameRowsWithoutTimeTokens: resumeProof.rowTextDiagnostics.rowsWithoutTimeTokensSha256
            === observedProof.rowTextDiagnostics.rowsWithoutTimeTokensSha256,
          previousRowOrderCounts: resumeProof.rowTextDiagnostics.rowOrderCounts,
          observedRowOrderCounts: observedProof.rowTextDiagnostics.rowOrderCounts,
          previousTimeTokenCounts: resumeProof.rowTextDiagnostics.timeTokenCounts,
          observedTimeTokenCounts: observedProof.rowTextDiagnostics.timeTokenCounts,
        } : null,
      sameCursor: resumeProof.nextCursor?.page === requestedCursor.page
        && resumeProof.nextCursor?.itemOffset === requestedCursor.itemOffset,
    });
  }
  if (resumed) {
    currentPage = resumeProof.page;
    await scanOptions.onStep?.('return-refund-resume-verified', {
      page: currentPage,
      requestedCursor,
    });
  } else {
    if (requestedCursor.page > 1 || requestedCursor.itemOffset > 0) {
      await scanOptions.onStep?.('return-refund-resume-rejected', resumeCheck);
    }
    await openReturnRefundWorkbench(page, scanOptions);
  }

  const refreshAfterPageTransitionFailure = async ({ stage, fromPage, targetPage }) => {
    const pageStep = createVisiblePddStep(page, scanOptions);
    await pageStep(`${stage}-refresh`, () => page.reload({
      waitUntil: 'commit',
      timeout: 45_000,
    }).catch(() => null), { fromPage, targetPage });
    await openReturnRefundWorkbench(page, scanOptions);
    throw new ReturnRefundTransientPageError(
      'page-navigation',
      `退货退款扫描翻页失败，刷新后保留游标等待重试：未到达第${targetPage}页`,
      { retryAfterMs: 30_000 },
    );
  };

  const restoreReturnRefundListPage = async (targetPage) => {
    await openReturnRefundWorkbench(page, scanOptions);
    let restoredPage = 1;
    while (restoredPage < targetPage) {
      const pageStep = createVisiblePddStep(page, scanOptions);
      await waitForReturnRefundListState(page, scanOptions);
      const previousSignature = await returnRefundPageSignature(page);
      const nextPage = await findNextReturnRefundPageAction(page);
      if (!nextPage) {
        await refreshAfterPageTransitionFailure({
          stage: 'return-refund-restore-page-missing-next',
          fromPage: restoredPage,
          targetPage,
        });
      }
      await pageStep('return-refund-restore-page', () => nextPage.click(), {
        fromPage: restoredPage,
        targetPage,
      });
      const transition = await waitForReturnRefundPageTransition(page, {
        previousSignature,
        expectedPage: restoredPage + 1,
        onVerification: scanOptions.onVerification,
        stage: 'return-refund-restore-page-change',
        timeoutMs: 30_000,
      });
      if (!transition) {
        await refreshAfterPageTransitionFailure({
          stage: 'return-refund-restore-page-timeout',
          fromPage: restoredPage,
          targetPage,
        });
      }
      restoredPage += 1;
    }
  };

  while (currentPage < requestedCursor.page && activeElapsedMs() < maxDurationMs) {
    const pageStep = createVisiblePddStep(page, scanOptions);
    await pageStep('return-refund-cursor-page-ready');
    const pageSignature = await returnRefundPageSignature(page);
    const nextPage = await findNextReturnRefundPageAction(page);
    if (!nextPage) {
      const lastAvailablePage = currentPage;
      cursorWrapped = true;
      currentPage = 1;
      firstPageItemOffset = 0;
      nextCursor = { page: 1, itemOffset: 0 };
      await pageStep('return-refund-cursor-wrap', null, {
        requestedPage: requestedCursor.page,
        lastAvailablePage,
      });
      await openReturnRefundWorkbench(page, scanOptions);
      break;
    }
    pageEnteredAt = Date.now();
    await pageStep('return-refund-cursor-next-page', () => nextPage.click(), {
      fromPage: currentPage,
      targetPage: requestedCursor.page,
    });
    const transition = await waitForReturnRefundPageTransition(page, {
      previousSignature: pageSignature,
      expectedPage: currentPage + 1,
      onVerification: scanOptions.onVerification,
      stage: 'return-refund-cursor-page-change',
      timeoutMs: 30_000,
    });
    if (!transition) {
      await refreshAfterPageTransitionFailure({
        stage: 'return-refund-cursor-page-timeout',
        fromPage: currentPage,
        targetPage: currentPage + 1,
      });
    }
    currentPage += 1;
  }

  const startCursor = { page: currentPage, itemOffset: firstPageItemOffset };
  if (currentPage < requestedCursor.page && !cursorWrapped) {
    return {
      items: [],
      scan: {
        requestedCursor,
        actionScope: RETURN_REFUND_LIST_ACTION_SCOPE,
        startCursor,
        endPage: currentPage,
        nextCursor: requestedCursor,
        cursorWrapped,
        examined,
        seekTimedOut: true,
      },
    };
  }

  // A missing saved page ends this cycle at its existing 1:0 boundary.
  // Reading the new first page here would mix two cycles and collide with
  // cursors already visited by the supervisor. The next cycle scans row zero.
  while (!cursorWrapped && budgetedItems < maxItems && activeElapsedMs() < maxDurationMs) {
    const pageStep = createVisiblePddStep(page, scanOptions);
    await pageStep('return-refund-list-page-ready', null, { page: currentPage });
    await dismissReturnRefundBlockingPromotion(page, pageStep);
    const { detailActions, count, empty } = await waitForReturnRefundListState(page, scanOptions);
    if (empty) {
      nextCursor = { page: 1, itemOffset: 0 };
      break;
    }
    const pageSignature = await returnRefundPageSignature(page);
    if (pageSignature && seenPages.has(pageSignature)) break;
    if (pageSignature) seenPages.add(pageSignature);

    const observedListResponse = await listResponseObserver.snapshot();
    const freshListResponse = observedListResponse?.receivedAt >= pageEnteredAt
      ? observedListResponse : null;
    const cachedListResponse = listMemory?.cache;
    const cachedResponseAge = Date.now() - Number(cachedListResponse?.response?.receivedAt);
    // A cache is only an ID mapping for an unchanged, verified live page.
    // Main-frame navigation, another page object, a new response or a changed
    // proof prevents reuse. It never supplies a business completion result.
    const reusedListResponse = !observedListResponse && resumed
      && !listResponseObserver.diagnostics().pathResponses
      && cachedListResponse?.proof === resumeProof
      && currentPage === resumeProof.page
      && cachedResponseAge >= 0 && cachedResponseAge <= RETURN_REFUND_SCAN_RESUME_MAX_AGE_MS
        ? cachedListResponse.response : null;
    const listResponse = freshListResponse || reusedListResponse;
    if (reusedListResponse) listResponseDiagnostics.pagesWithReusedListResponse += 1;
    if (listResponse) {
      listResponseDiagnostics.pagesWithResponse += 1;
      listResponseDiagnostics[listResponse.items.length === count
        ? 'pagesWithCountMatch' : 'pagesWithCountMismatch'] += 1;
      listResponseDiagnostics.lastResponseItemCount = listResponse.items.length;
      listResponseDiagnostics.lastRenderedActionCount = count;
    }
    const listRowIdentities = (deferredRefundLookup.size > 0 || completedRefundLookup.size > 0)
      && listResponse?.items.length >= count - 1
      && listResponse?.items.length <= count
      ? await Promise.all(Array.from({ length: count }, async (_, index) => {
        const action = detailActions.nth(index);
        return await action.isVisible().catch(() => false)
          ? readReturnRefundListRowIdentity(action)
          : { orderNumber: null, aftersaleNumber: null, source: 'hidden-action' };
      })) : null;
    const listResponseMatch = matchReturnRefundListResponseToActions(
      listRowIdentities, listResponse?.items,
    );
    listResponseDiagnostics.lastMatch = {
      ...describeReturnRefundListResponseMatch(listRowIdentities, listResponse?.items),
      matched: Boolean(listResponseMatch),
      deferredLookupCount: deferredRefundLookup.size,
      completedLookupCount: completedRefundLookup.size,
    };
    const listResponseMatchesPage = Boolean(listResponseMatch);
    if (listMemory && listResponseMatchesPage) {
      lastMatchedListResponse = { response: listResponse, page: currentPage,
        generation: listMemory.generation };
    }
    if (listResponseMatch?.extraActionIndex >= 0) {
      listResponseDiagnostics.pagesWithUniqueExtraActionMatch += 1;
    }
    const responseOrderCounts = new Map();
    if (listResponseMatchesPage) {
      for (const row of listResponse.items) {
        responseOrderCounts.set(row.orderSn, (responseOrderCounts.get(row.orderSn) || 0) + 1);
      }
    }

    const pageStartIndex = Math.min(firstPageItemOffset, count);
    firstPageItemOffset = 0;
    for (let index = pageStartIndex; index < count
      && budgetedItems < maxItems
      && activeElapsedMs() < maxDurationMs; index += 1) {
      const action = detailActions.nth(index);
      nextCursor = index + 1 < count
        ? { page: currentPage, itemOffset: index + 1 }
        : { page: currentPage + 1, itemOffset: 0 };
      if (!await action.isVisible().catch(() => false)) continue;
      examined += 1;
      budgetedItems += 1;
      const listUrl = page.url();
      const step = createVisiblePddStep(page, scanOptions);
      const pagesBefore = new Set(context.pages());
      const targetIdentity = listRowIdentities?.[index]
        || await readReturnRefundListRowIdentity(action);
      const identitySource = targetIdentity.source || 'unavailable';
      listIdentityDiagnostics.sources[identitySource] = (listIdentityDiagnostics.sources[identitySource] || 0) + 1;
      if (targetIdentity.orderNumber) {
        listIdentityDiagnostics.rowsWithOrderNumber += 1;
        if (listResponse?.items.some((row) => row.orderSn === targetIdentity.orderNumber)) {
          listIdentityDiagnostics.rowsWhoseOrderExistsInResponse += 1;
        }
      }
      const responseRow = listResponseMatch?.responseByActionIndex[index] || null;
      const responseOrderMatched = Boolean(responseRow?.id
        && targetIdentity.orderNumber
        && responseRow.orderSn === targetIdentity.orderNumber);
      if (responseOrderMatched) listResponseDiagnostics.rowsWithMatchingOrder += 1;
      if (!targetIdentity.aftersaleNumber) listIdentityDiagnostics.rowsWithoutAftersaleNumber += 1;
      if (targetIdentity.attributeCandidateIds?.length) {
        listIdentityDiagnostics.rowsWithAttributeCandidates += 1;
      }
      const completedRefund = identifyKnownCompletedRefund({
        targetIdentity,
        responseRow,
        listResponseMatchesPage,
        responseOrderCount: responseOrderCounts.get(targetIdentity.orderNumber) || 0,
        completedRefundLookup,
      });
      if (completedRefund) {
        listResponseDiagnostics.rowsSkippedKnownCompleted += 1;
        discountKnownListSkip();
        await step('return-refund-scan-known-completed-deferred', null, {
          index: examined,
          pageIndex: index + 1,
          pageTotal: count,
          orderNumber: completedRefund.orderNumber,
          aftersaleNumber: completedRefund.aftersaleNumber,
          returnRefundScanSkip: {
            disposition: 'confirmed-completed',
            identitySource: completedRefund.identitySource,
          },
        });
        continue;
      }
      const deferredRecheck = identifyKnownFutureRefundRecheck({
        targetIdentity,
        responseRow,
        listResponseMatchesPage,
        responseOrderCount: responseOrderCounts.get(targetIdentity.orderNumber) || 0,
        deferredRefundLookup,
      });
      if (deferredRecheck) {
        listResponseDiagnostics.rowsSkippedKnownWait += 1;
        discountKnownListSkip();
        await step('return-refund-scan-known-wait-deferred', null, {
          index: examined,
          pageIndex: index + 1,
          pageTotal: count,
          orderNumber: targetIdentity.orderNumber,
          aftersaleNumber: deferredRecheck.aftersaleNumber,
          returnRefundScanSkip: {
            disposition: 'known-wait-next-check-future',
            nextCheckAt: deferredRecheck.nextCheckAt,
            identitySource: deferredRecheck.identitySource,
          },
        });
        continue;
      }
      let backgroundDetailResult = null;
      try {
        await step('return-refund-open-detail', async () => {
          backgroundDetailResult = await clickPddDetailInBackground(page, action, {
            createBackgroundPage: scanOptions.createBackgroundDetailPage,
            isAllowedUrl: (url) => {
              if (isReturnRefundExcludedDetailUrl(url)) return true;
              if (!isReturnRefundDetailUrl(url)) return false;
              const detailUrl = new URL(url);
              const orderNumber = detailUrl.searchParams.get('orderSn');
              const aftersaleNumber = detailUrl.searchParams.get('id');
              return /^\d{6}-\d{12,}$/u.test(orderNumber || '')
                && /^\d{8,}$/u.test(aftersaleNumber || '')
                && (!targetIdentity.orderNumber
                  || targetIdentity.orderNumber === orderNumber)
                && (!targetIdentity.aftersaleNumber
                  || targetIdentity.aftersaleNumber === aftersaleNumber);
            },
            onCapturedTarget: (url) => {
              if (!isReturnRefundDetailUrl(url)
                || !/^\d{6}-\d{12,}$/u.test(String(targetIdentity.orderNumber || ''))) return null;
              const targetUrl = new URL(url);
              const orderNumber = targetUrl.searchParams.get('orderSn');
              const aftersaleNumber = targetUrl.searchParams.get('id');
              if (orderNumber !== targetIdentity.orderNumber
                || !/^\d{8,18}$/u.test(String(aftersaleNumber || ''))) return null;
              const capturedIdentity = { orderNumber, aftersaleNumber };
              const completedRefund = identifyKnownCompletedRefund({
                targetIdentity: capturedIdentity,
                responseRow,
                listResponseMatchesPage,
                responseOrderCount: responseOrderCounts.get(orderNumber) || 0,
                completedRefundLookup,
              });
              if (completedRefund) return {
                skip: true,
                disposition: 'confirmed-completed',
                identitySource: 'captured-detail-target',
                orderNumber,
                aftersaleNumber,
              };
              const deferredRecheck = identifyKnownFutureRefundRecheck({
                targetIdentity: capturedIdentity,
                responseRow,
                listResponseMatchesPage,
                responseOrderCount: responseOrderCounts.get(orderNumber) || 0,
                deferredRefundLookup,
              });
              return deferredRecheck ? {
                skip: true,
                disposition: 'known-wait-next-check-future',
                identitySource: 'captured-detail-target',
                orderNumber,
                aftersaleNumber,
                nextCheckAt: deferredRecheck.nextCheckAt,
              } : null;
            },
          });
        }, {
          index: examined,
          pageIndex: index + 1,
          pageTotal: count,
          orderNumber: targetIdentity.orderNumber,
          aftersaleNumber: targetIdentity.aftersaleNumber,
          targetIdentitySource: targetIdentity.source,
        });
      } catch (error) {
        if (error?.code === 'PDD_RETURN_REFUND_BACKGROUND_DETAIL_UNRECOGNIZED') {
          error.message += `；列表行: 第${currentPage}页第${index + 1}项，订单${targetIdentity.orderNumber || '未知'}，售后${targetIdentity.aftersaleNumber || '未知'}`;
        }
        throw error;
      }
      if (backgroundDetailResult?.skipped) {
        const skip = backgroundDetailResult.disposition;
        if (skip.disposition === 'confirmed-completed') {
          listResponseDiagnostics.rowsSkippedKnownCompleted += 1;
          listResponseDiagnostics.rowsSkippedKnownCompletedByCapturedTarget += 1;
        } else {
          listResponseDiagnostics.rowsSkippedKnownWaitByCapturedTarget += 1;
        }
        await step(skip.disposition === 'confirmed-completed'
          ? 'return-refund-scan-known-completed-deferred'
          : 'return-refund-scan-known-wait-deferred', null, {
          index: examined,
          pageIndex: index + 1,
          pageTotal: count,
          orderNumber: skip.orderNumber,
          aftersaleNumber: skip.aftersaleNumber,
          returnRefundScanSkip: {
            disposition: skip.disposition,
            identitySource: skip.identitySource,
            ...(skip.nextCheckAt ? { nextCheckAt: skip.nextCheckAt } : {}),
          },
        });
        continue;
      }
      const popup = backgroundDetailResult
        || await waitForReturnRefundDetailTarget(page, context, pagesBefore, { listUrl });
      const detailPage = popup || page;
      await detailPage.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
      await maybeBringReturnRefundPageToFront(detailPage);
      const detailOptions = {
        ...scanOptions,
        fallbackFacts: targetIdentity,
      };
      let facts = null;
      try {
        if (isReturnRefundExcludedDetailUrl(detailPage.url())) {
          let excludedOrderNumber = targetIdentity.orderNumber;
          try {
            excludedOrderNumber ||= new URL(detailPage.url()).searchParams.get('orderSn');
          } catch { /* keep the list-row identity when the URL is malformed */ }
          await step('return-refund-scan-non-refund-detail-skipped', null, {
            index: examined,
            pageIndex: index + 1,
            pageTotal: count,
            orderNumber: excludedOrderNumber || null,
            aftersaleNumber: targetIdentity.aftersaleNumber,
            targetIdentitySource: targetIdentity.source,
            returnRefundScanSkip: {
              disposition: 'excluded-non-refund-route',
              route: 'negative-experience-detail',
            },
          });
          continue;
        }
        facts = await readReturnRefundDetail(detailPage, detailOptions);
        if (responseOrderMatched && facts.aftersaleNumber) {
          listResponseDiagnostics[responseRow.id === facts.aftersaleNumber
            ? 'detailsWithMatchingAftersaleId'
            : 'detailsWithMismatchedAftersaleId'] += 1;
        }
        if (facts.aftersaleNumber
          && targetIdentity.attributeCandidateIds?.includes(facts.aftersaleNumber)) {
          listIdentityDiagnostics.candidatesMatchedDetail += 1;
        }
        if (facts.aftersaleNumber && !seen.has(facts.aftersaleNumber)) {
          seen.add(facts.aftersaleNumber);
          results.push(facts);
        }
      } catch (error) {
        if (isRecoverableReturnRefundDetailFailure(error)) {
          await step('return-refund-scan-detail-deferred', null, {
            index: examined,
            pageIndex: index + 1,
            pageTotal: count,
            orderNumber: targetIdentity.orderNumber,
            aftersaleNumber: targetIdentity.aftersaleNumber,
            targetIdentitySource: targetIdentity.source,
            returnRefundScanDefer: {
              disposition: 'retry-later-scan-cycle',
              reason: String(error?.message || error).slice(0, 500),
              orderNumber: targetIdentity.orderNumber,
              aftersaleNumber: targetIdentity.aftersaleNumber,
              renderObservation: error.renderObservation || null,
              waitDiagnostics: error.diagnostics || null,
            },
          });
          continue;
        }
        if (error?.code !== 'PDD_RETURN_REFUND_NOT_FOUND') throw error;
        const terminalResult = classifyReturnRefundUnexpectedFailure(error);
        const terminalFacts = {
          ...(error.facts || {}),
          decision: terminalResult,
          outcome: terminalResult.outcome,
        };
        if (!terminalFacts.orderNumber || !terminalFacts.aftersaleNumber) throw error;
        if (!seen.has(terminalFacts.aftersaleNumber)) {
          seen.add(terminalFacts.aftersaleNumber);
          results.push(terminalFacts);
        }
      } finally {
        try {
          if (popup) {
            await createVisiblePddStep(detailPage, scanOptions)(
              'return-refund-close-detail',
              () => detailPage.close({ runBeforeUnload: false }),
            );
            await maybeBringReturnRefundPageToFront(page);
          } else {
            const detailOverlayClosed = await closeReturnRefundDetailOverlay(page, scanOptions);
            if (!detailOverlayClosed && page.url() !== listUrl) {
              await step('return-refund-return-list', async () => {
                await page.goBack({ waitUntil: 'commit', timeout: 30_000 })
                  .catch(() => navigateReturnRefundPage(
                    page,
                    listUrl,
                    { expectedPath: '/aftersales/aftersale_list' },
                  ));
              });
            }
            const activePage = await readReturnRefundActivePageNumber(page);
            const restoredSignature = await returnRefundPageSignature(page);
            const listPagePreserved = page.url().includes('/aftersales/aftersale_list')
              && (activePage === currentPage
                || (activePage == null && restoredSignature === pageSignature));
            if (!listPagePreserved) {
              await restoreReturnRefundListPage(currentPage);
            } else {
              await waitForReturnRefundListState(page, scanOptions);
            }
          }
        } finally {
          await closeStaleReturnRefundDetailPages(context, {
            anchorPage: page,
            preserveVerification: true,
            protectedPages: scanOptions.protectedPages,
          });
        }
      }
    }

    if (budgetedItems >= maxItems || activeElapsedMs() >= maxDurationMs) {
      if (nextCursor.page > currentPage) {
        const hasNextPage = Boolean(await findNextReturnRefundPageAction(page));
        if (!hasNextPage) nextCursor = { page: 1, itemOffset: 0 };
      }
      break;
    }
    await dismissReturnRefundBlockingPromotion(page, pageStep);
    const nextPage = await findNextReturnRefundPageAction(page);
    if (!nextPage) {
      nextCursor = { page: 1, itemOffset: 0 };
      break;
    }
    pageEnteredAt = Date.now();
    await pageStep('return-refund-next-page', () => nextPage.click(), {
      examined,
      collected: results.length,
      fromPage: currentPage,
    });
    const transition = await waitForReturnRefundPageTransition(page, {
      previousSignature: pageSignature,
      expectedPage: currentPage + 1,
      onVerification: scanOptions.onVerification,
      stage: 'return-refund-page-change',
      timeoutMs: 30_000,
    });
    if (!transition) {
      await refreshAfterPageTransitionFailure({
        stage: 'return-refund-page-timeout',
        fromPage: currentPage,
        targetPage: currentPage + 1,
      });
    }
    currentPage += 1;
    nextCursor = { page: currentPage, itemOffset: 0 };
  }
  const observedResumeProof = cursorWrapped
    ? null
    : await readReturnRefundScanResumeProof(page, nextCursor);
  if (listMemory) {
    listMemory.cache = null;
    if (observedResumeProof && (nextCursor.page > 1 || nextCursor.itemOffset > 0)
      && lastMatchedListResponse?.page === observedResumeProof.page
      && lastMatchedListResponse.generation === listMemory.generation) {
      const actions = returnRefundListDetailActions(page);
      const count = await actions.count();
      const identities = await Promise.all(Array.from({ length: Math.min(count, 101) }, (_, index) => (
        readReturnRefundListRowIdentity(actions.nth(index))
      )));
      if (lastMatchedListResponse.generation === listMemory.generation
        && matchReturnRefundListResponseToActions(identities, lastMatchedListResponse.response.items)) {
        listMemory.cache = { proof: observedResumeProof, response: lastMatchedListResponse.response };
      }
    }
  }
  const resumeProofDiagnostic = cursorWrapped
    || observedResumeProof?.page === currentPage
    ? null
    : {
      listPath: (() => { try { return new URL(page.url()).pathname; } catch { return null; } })(),
      activePage: await readReturnRefundActivePageNumber(page),
      detailLinkCount: await returnRefundListDetailActions(page).count().catch(() => 0),
      expectedPage: currentPage,
      paginationCandidates: typeof page.evaluate === 'function' ? await page.evaluate(() => [...document.querySelectorAll('li,a,button,span,div')]
        .filter((element) => /^\d{1,5}$/u.test(String(element.textContent || '').trim())
          && element.getClientRects().length > 0)
        .map((element) => {
          const classes = [element, element.parentElement, element.parentElement?.parentElement]
            .map((node) => String(node?.className || '').slice(0, 100));
          return {
            number: Number(String(element.textContent || '').trim()),
            tag: element.tagName.toLowerCase(),
            classes,
            ariaCurrent: element.getAttribute('aria-current'),
            ariaSelected: element.getAttribute('aria-selected'),
          };
        })
        .filter((item) => item.classes.some((value) => /pag(?:e|ination|er)|active|current|select/iu.test(value)))
        .slice(0, 20)).catch(() => []) : [],
    };
  return {
    items: results,
    scan: {
      requestedCursor,
      actionScope: RETURN_REFUND_LIST_ACTION_SCOPE,
      startCursor,
      endPage: currentPage,
      nextCursor: normalizeReturnRefundScanCursor(nextCursor),
      cursorWrapped,
      examined,
      budgetedItems,
      knownSkippedAllowanceUsed,
      listIdentityDiagnostics,
      listResponseDiagnostics: {
        ...listResponseDiagnostics,
        ...listResponseObserver.diagnostics(),
      },
      listResourcePaths: await readReturnRefundListResourcePaths(page),
      resumeProof: observedResumeProof?.page === currentPage ? observedResumeProof : null,
      resumeProofDiagnostic,
      resumeCheck,
    },
  };
  } finally {
    listResponseObserver.stop();
  }
};

export const processReturnRefund = async (page, context, {
  detailUrl,
  orderNumber = null,
  aftersaleNumber,
  firstDiscoveredAt = null,
  autoApproveEnabled = false,
  readOnlyReview = false,
  existingEffectStatus = null,
  existingEffectReceipt = null,
  existingEffectError = null,
  existingEffectReservedAt = null,
  reserveEffect = null,
  completeEffect = null,
  ...options
} = {}) => {
  let step = createVisiblePddStep(page, options);
  if (detailUrl && page.url() !== detailUrl) {
    await step('return-refund-open-saved-detail', () => navigateReturnRefundPage(page, detailUrl, {
      expectedPath: '/aftersales-ssr/detail',
    }), { aftersaleNumber });
  }
  const detailReadOptions = {
    ...options,
    ...(detailUrl ? { expectedDetailUrl: detailUrl } : {}),
  };
  let facts;
  try {
    facts = await readReturnRefundDetail(page, detailReadOptions);
  } catch (error) {
    if (error?.code === 'PDD_RETURN_REFUND_NOT_FOUND') {
      const terminalResult = classifyReturnRefundUnexpectedFailure(error);
      return {
        ...terminalResult,
        facts: {
          ...(error.facts || {}),
          orderNumber: error.facts?.orderNumber || orderNumber || null,
          aftersaleNumber: error.facts?.aftersaleNumber || aftersaleNumber || null,
          detailUrl: error.facts?.detailUrl || detailUrl || page.url(),
        },
      };
    }
    if (!isRecoverableReturnRefundDetailFailure(error)
      || !detailUrl
      || (!orderNumber && !aftersaleNumber)) throw error;
    if (page.isClosed()) {
      // Keep the claim recoverable when Chromium recycled the resident PDD
      // tab. A fresh context page can navigate back to the workbench and the
      // existing identity checks still fence the exact order before action.
      try {
        page = await context.newPage();
        step = createVisiblePddStep(page, options);
        await step('return-refund-detail-page-recreated', null, {
          orderNumber,
          aftersaleNumber,
        });
      } catch {
        throw error;
      }
    }
    await step('return-refund-detail-workbench-recovery-started', null, {
      orderNumber,
      aftersaleNumber,
      failedUrl: page.url(),
    });
    const recovered = await reopenReturnRefundDetailFromWorkbench(page, context, {
      orderNumber,
      aftersaleNumber,
      ...options,
    });
    if (!recovered) throw error;
    page = recovered.page;
    step = createVisiblePddStep(page, options);
    facts = await readReturnRefundDetail(page, detailReadOptions);
    await step('return-refund-detail-workbench-recovery-succeeded', null, {
      orderNumber,
      aftersaleNumber,
      pageNumber: recovered.pageNumber,
      popup: recovered.popup,
    });
  }
  if (orderNumber && facts.orderNumber && facts.orderNumber !== orderNumber) {
    return {
      outcome: 'page-error',
      riskLevel: 'high',
      reasons: [`订单编号不一致：期望${orderNumber}，页面读取到${facts.orderNumber}`],
      facts,
      rules: {},
    };
  }
  if (aftersaleNumber && facts.aftersaleNumber && facts.aftersaleNumber !== aftersaleNumber) {
    return {
      outcome: 'page-error',
      riskLevel: 'high',
      reasons: [`售后编号不一致：期望${aftersaleNumber}，页面读取到${facts.aftersaleNumber}`],
      facts,
      rules: {},
    };
  }
  facts.firstDiscoveredAt = firstDiscoveredAt || facts.firstDiscoveredAt || null;
  const decision = evaluateReturnRefundRules(facts, { firstDiscoveredAt });
  await step('return-refund-rule-decision', null, {
    aftersaleNumber: facts.aftersaleNumber || aftersaleNumber,
    outcome: decision.outcome,
    rules: decision.rules,
  });

  // An explicit terminal page is authoritative even when a previous refund
  // effect is still reserved or unknown. Reconcile it read-only before the
  // effect guard so this observation is never reported as a new refund click.
  if (decision.outcome === 'manual-completed') {
    return resolveReturnRefundReadOnlyReview(facts, decision);
  }
  if (existingEffectStatus === 'failed'
    && (existingEffectReceipt?.submission?.confirmationDispatchStarted === true
      || existingEffectReceipt?.submission?.confirmationClicked === true)) {
    return {
      outcome: 'manual-review',
      riskLevel: 'high',
      reasons: ['此前退款确认已发送但未取得终态回执，禁止自动重复提交'],
      facts,
      rules: decision.rules,
    };
  }
  if (['unknown', 'reserved'].includes(existingEffectStatus)) {
    const existingEffectResolution = classifyExistingReturnRefundEffect(facts, {
      existingEffectStatus,
      existingEffectReceipt,
      existingEffectError,
      existingEffectReservedAt,
      expectedOrderNumber: orderNumber || facts.orderNumber,
      expectedAftersaleNumber: aftersaleNumber || facts.aftersaleNumber,
    });
    if (existingEffectResolution.effectStatus === 'succeeded') {
      return { outcome: 'auto-refunded', riskLevel: null, reasons: [], facts, rules: decision.rules, reconciled: true };
    }
    if (existingEffectResolution.effectStatus === 'failed'
      && existingEffectResolution.retryable === false
      && existingEffectResolution.disposition === 'wait-logistics'
      && decision.outcome === 'wait-logistics') {
      return { ...decision, facts, existingEffectResolution };
    }
    if (existingEffectResolution.effectStatus === 'failed'
      && existingEffectResolution.retryable === true) {
      return {
        outcome: 'ready',
        riskLevel: null,
        reasons: ['已确认旧退款确认按钮未实际提交，安全释放执行锁并重新排队'],
        nextCheckAt: new Date(Date.now() + RETURN_REFUND_UNKNOWN_RECHECK_MS).toISOString(),
        facts,
        rules: decision.rules,
        existingEffectResolution,
      };
    }
    if (existingEffectResolution.disposition === 'manual-review') {
      return {
        outcome: 'manual-review',
        riskLevel: 'high',
        reasons: ['此前退款确认已发送但未取得终态回执，禁止自动重复提交'],
        facts,
        rules: decision.rules,
        existingEffectResolution,
      };
    }
    const pendingProof = [
      'pdd-exact-pending-proof-waiting',
      'pdd-exact-counterparty-pending-no-action-proof-waiting',
    ].includes(existingEffectResolution.reason);
    return {
      outcome: 'page-error',
      riskLevel: null,
      reasons: [pendingProof
        ? '已取得第一次“旧退款未生效”只读证据，等待再次复核后再决定是否释放执行锁'
        : '此前退款提交结果不明确，正在自动只读复核，不会重复点击'],
      nextCheckAt: existingEffectResolution.pendingProof?.recheckAfterAt
        || new Date(Date.now() + RETURN_REFUND_UNKNOWN_RECHECK_MS).toISOString(),
      facts,
      rules: decision.rules,
      existingEffectResolution,
    };
  }
  if (readOnlyReview) return resolveReturnRefundReadOnlyReview(facts, decision);
  if (decision.outcome !== 'auto-refund') return { ...decision, facts };
  if (!autoApproveEnabled) {
    return { outcome: 'ready', riskLevel: null, reasons: ['自动退款执行开关尚未开启'], facts, rules: decision.rules };
  }

  // A short-lived shop cookie can expire while the correct merchant business
  // page remains usable. In the resident worker, confirm the live page and
  // exact mall immediately before reserving this one-time refund effect.
  let sessionRunway;
  try {
    sessionRunway = inspectReturnRefundPddSessionRunway(
      await context.cookies('https://mms.pinduoduo.com'),
    );
  } catch {
    sessionRunway = { status: 'unavailable', remainingMs: null };
  }
  const liveBusinessSession = typeof options.confirmLivePddSession === 'function'
    ? await options.confirmLivePddSession(page).catch(() => false)
    : sessionRunway.status === 'sufficient';
  if (!liveBusinessSession) {
    return {
      outcome: 'page-error',
      riskLevel: null,
      reasons: ['拼多多业务页面或店铺身份未确认，退款确认未开始；等待页面恢复后复查'],
      nextCheckAt: new Date(Date.now() + RETURN_REFUND_UNKNOWN_RECHECK_MS).toISOString(),
      facts,
      rules: decision.rules,
      retryKind: 'pdd-session-runway',
    };
  }

  const requestHash = crypto.createHash('sha256').update(JSON.stringify({
    aftersaleNumber: facts.aftersaleNumber,
    orderNumber: facts.orderNumber,
    refundAmount: facts.refundAmount,
  })).digest('hex');
  const reservation = await reserveEffect?.({
    effectType: 'pdd-return-refund',
    idempotencyKey: `pdd-return-refund:${facts.aftersaleNumber}`,
    requestHash,
  });
  if (!reservation?.reserved) {
    if (reservation?.alreadySucceeded && confirmsReturnRefundCompletion(facts)) {
      return { outcome: 'auto-refunded', riskLevel: null, reasons: [], facts, rules: decision.rules, reconciled: true };
    }
    return {
      outcome: 'page-error',
      riskLevel: null,
      reasons: ['退款操作未取得一次性执行权，等待自动只读复核'],
      nextCheckAt: new Date(Date.now() + RETURN_REFUND_UNKNOWN_RECHECK_MS).toISOString(),
      facts,
      rules: decision.rules,
    };
  }

  try {
    const submission = await submitReturnRefund(page, { ...options, expectedFacts: facts });
    const submissionEvidence = summarizeReturnRefundSubmission(submission);
    const submissionClassification = classifyReturnRefundSubmission(submission, {
      expectedOrderNumber: facts.orderNumber,
      expectedAftersaleNumber: facts.aftersaleNumber,
    });
    if (submissionClassification.effectStatus === 'failed') {
      await completeEffect?.({
        status: 'failed',
        receipt: {
          aftersaleNumber: facts.aftersaleNumber,
          orderNumber: facts.orderNumber,
          submission: submissionEvidence,
        },
        error: { reason: submissionClassification.reason },
      });
      return {
        outcome: 'ready',
        riskLevel: null,
        reasons: ['退款二次确认未出现，三次刷新仍为原待处理售后，已安全释放等待重试'],
        facts: submission.facts,
        rules: decision.rules,
        submission: submissionEvidence,
      };
    }
    if (submissionClassification.effectStatus === 'unknown') {
      await completeEffect?.({
        status: 'unknown',
        receipt: {
          aftersaleNumber: facts.aftersaleNumber,
          orderNumber: facts.orderNumber,
          submission: submissionEvidence,
        },
        error: { reason: submissionClassification.reason },
      });
      return {
        outcome: 'page-error',
        riskLevel: null,
        reasons: ['点击确认退款后页面未显示明确完结状态，正在自动只读复核'],
        nextCheckAt: new Date(Date.now() + RETURN_REFUND_UNKNOWN_RECHECK_MS).toISOString(),
        facts: submission.facts,
        rules: decision.rules,
        submission: submissionEvidence,
      };
    }
    await completeEffect?.({
      status: 'succeeded',
      receipt: {
        aftersaleNumber: facts.aftersaleNumber,
        orderNumber: facts.orderNumber,
        refundAmount: facts.refundAmount,
        confirmedAt: new Date().toISOString(),
        confirmationMethod: submissionEvidence.postconditionRecoveredUnderVerification
          ? 'return-refund-terminal-page-under-verification'
          : 'return-refund-button-disappeared',
        submission: submissionEvidence,
      },
    });
    return {
      outcome: 'auto-refunded',
      riskLevel: null,
      reasons: [],
      facts: submission.facts,
      rules: decision.rules,
      submission: submissionEvidence,
    };
  } catch (error) {
    const submissionEvidence = summarizeReturnRefundSubmission(error.returnRefundSubmission);
    const confirmationDispatched = submissionEvidence.confirmationDispatchStarted === true
      || submissionEvidence.confirmationClicked === true;
    const verificationRequired = error?.name === 'HumanVerificationRequiredError'
      || ['PDD_HUMAN_VERIFICATION_REQUIRED', 'PDD_LOGIN_REQUIRED'].includes(error?.code)
      || /检测到人工验证|人工验证|验证码|滑块|安全验证|pdd-manual-login/iu.test(
        String(error?.message || error || ''),
      );
    await completeEffect?.({
      status: confirmationDispatched ? 'unknown' : 'failed',
      receipt: {
        aftersaleNumber: facts.aftersaleNumber,
        orderNumber: facts.orderNumber,
        submission: submissionEvidence,
      },
      error: {
        reason: confirmationDispatched
          ? 'pdd-return-refund-exception'
          : 'pdd-confirmation-not-dispatched',
        message: error.message,
      },
    }).catch(() => {});
    return {
      // Once the confirmation has been dispatched, a CAPTCHA may appear
      // during the read-only postcondition refresh. Keep the effect unknown
      // to prevent duplicate refunds, but classify the claim as verification
      // required so the queue and owner UI keep the exact human gate instead
      // of presenting it as a generic page error.
      outcome: verificationRequired ? 'verification-required' : 'page-error',
      riskLevel: null,
      reasons: [verificationRequired
        ? `${confirmationDispatched ? '退款确认已点击，' : ''}等待人工验证后自动只读复核：${error.message}`
        : confirmationDispatched
          ? `退款确认已点击，正在自动只读复核：${error.message}`
          : `退款确认未点击，将自动重试：${error.message}`],
      nextCheckAt: new Date(Date.now() + (
        verificationRequired
          ? RETURN_REFUND_VERIFICATION_RECHECK_MS
          : confirmationDispatched ? RETURN_REFUND_UNKNOWN_RECHECK_MS : RETURN_REFUND_PAGE_ERROR_RECHECK_MS
      )).toISOString(),
      facts,
      rules: decision.rules,
      submission: submissionEvidence,
    };
  }
};
