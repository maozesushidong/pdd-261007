import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOwnerEntryGate } from './owner-entry-gate.mjs';
import { createWebServer } from './http-and-https.mjs';

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const builtRoot = path.resolve(sourceRoot, '../dist');
const staticRoot = fs.existsSync(path.join(builtRoot, 'index.html')) ? builtRoot : sourceRoot;
const publicBuiltRoot = path.resolve(sourceRoot, '../dist-public');
const publicEntryFile = path.join(publicBuiltRoot, 'public.html');
const apiBase = new URL(process.env.API_BASE_URL || 'http://127.0.0.1:3000');
const remoteDesktopBase = new URL(process.env.REMOTE_DESKTOP_BASE_URL || 'http://127.0.0.1:6080');
const remoteDesktopMaxSlots = Math.max(1, Number(process.env.REMOTE_DESKTOP_MAX_SLOTS || 1000));
const publicWebHost = process.env.PUBLIC_WEB_HOST || '';
const publicWebPort = Math.max(0, Number(process.env.PUBLIC_WEB_PORT || 0));
const ownerEntryGate = process.env.OWNER_ENTRY_CONCEALED === 'true' ? createOwnerEntryGate() : null;
const publicApiDefaultMaxBytes = 10 * 1024 * 1024;
const publicWorkOrderDetailMaxBytes = 32 * 1024 * 1024;
const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);

const decodedRequestPathname = (requestUrl) => {
  try {
    return decodeURIComponent(new URL(requestUrl || '/', 'http://localhost').pathname);
  } catch {
    return null;
  }
};

const rejectMalformedRequestPath = (response) => {
  response.writeHead(400, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  response.end(JSON.stringify({ error: 'malformed-request-path' }));
};

const ownerSessionAuthorized = (request) => new Promise((resolve) => {
  const check = http.request({
    protocol: apiBase.protocol,
    hostname: apiBase.hostname,
    port: apiBase.port,
    method: 'GET',
    path: '/api/v1/auth/me',
    headers: {
      cookie: request.headers.cookie || '',
      accept: 'application/json',
    },
  }, (upstream) => {
    let body = '';
    upstream.setEncoding('utf8');
    upstream.on('data', (chunk) => { body += chunk; });
    upstream.on('end', () => {
      try {
        const payload = JSON.parse(body);
        resolve(upstream.statusCode === 200 && payload?.data?.role === 'system-owner');
      } catch { resolve(false); }
    });
  });
  check.setTimeout(3_000, () => check.destroy());
  check.on('error', () => resolve(false));
  check.end();
});

const rejectPrivateAccess = (response) => {
  response.writeHead(401, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store, max-age=0',
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  });
  response.end(JSON.stringify({ error: 'system-owner-authentication-required' }));
};

const proxyHttp = (request, response, target, prefix = '', unavailableError = 'api-unavailable') => {
  const headers = { ...request.headers, host: target.host, 'x-forwarded-proto': request.socket.encrypted ? 'https' : 'http' };
  const upstreamPath = prefix && request.url?.startsWith(prefix)
    ? request.url.slice(prefix.length) || '/'
    : request.url;
  const proxy = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port,
    method: request.method,
    path: upstreamPath,
    headers,
  }, (upstream) => {
    response.writeHead(upstream.statusCode || 502,
      ownerEntryGate?.captureResponseHeaders(request, upstream.headers) || upstream.headers);
    upstream.pipe(response);
  });
  proxy.on('error', (error) => {
    if (response.headersSent) return response.destroy(error);
    response.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: unavailableError }));
  });
  request.pipe(proxy);
};

const publicReadApiPaths = new Set([
  '/api/v1/metrics/summary',
  '/api/v1/shops',
  '/api/v1/scenarios',
  '/api/v1/runtime',
  '/api/v1/runtime/capacity',
  '/api/v1/work-orders',
  '/api/v1/verifications',
]);

const publicWorkOrderDetailPath = /^\/api\/v1\/work-orders\/[0-9a-z:_-]{1,200}$/iu;
const publicVerificationScreenshotPath = /^\/api\/v1\/verifications\/[0-9a-f-]{1,80}\/screenshot$/iu;

export const isPublicViewerApiRequest = (method, requestUrl) => {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  const pathname = new URL(requestUrl || '/', 'http://localhost').pathname;
  return publicReadApiPaths.has(pathname)
    || publicWorkOrderDetailPath.test(pathname)
    || publicVerificationScreenshotPath.test(pathname);
};

const isPublicViewerBinaryApiRequest = (requestUrl) => publicVerificationScreenshotPath.test(
  new URL(requestUrl || '/', 'http://localhost').pathname,
);

const proxyPublicHttp = (request, response) => {
  const headers = { ...request.headers, host: apiBase.host };
  for (const name of ['authorization', 'cookie', 'origin', 'referer', 'x-csrf-token']) delete headers[name];
  const upstreamUrl = new URL(request.url || '/', 'http://localhost');
  const pathname = upstreamUrl.pathname;
  if (pathname === '/api/v1/work-orders') {
    const metric = upstreamUrl.searchParams.get('overviewMetric');
    if (metric === 'autoSuccess') upstreamUrl.searchParams.set('overviewMetric', 'platformConfirmedSuccess');
    if (metric === 'notSuccessful') upstreamUrl.searchParams.set('overviewMetric', 'notPlatformConfirmedSuccess');
  }
  const maxResponseBytes = publicWorkOrderDetailPath.test(pathname)
    ? publicWorkOrderDetailMaxBytes
    : publicApiDefaultMaxBytes;
  const proxy = http.request({
    protocol: apiBase.protocol,
    hostname: apiBase.hostname,
    port: apiBase.port,
    method: request.method,
    path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
    headers,
  }, (upstream) => {
    const declaredSize = Number(upstream.headers['content-length'] || 0);
    if (declaredSize > maxResponseBytes) {
      upstream.resume();
      response.writeHead(502, publicJsonHeaders);
      response.end(JSON.stringify({ error: 'public-api-response-too-large' }));
      return;
    }
    const chunks = [];
    let size = 0;
    upstream.on('data', (chunk) => {
      size += chunk.length;
      if (size <= maxResponseBytes) chunks.push(chunk);
    });
    upstream.on('end', () => {
      if (size > maxResponseBytes) {
        response.writeHead(502, publicJsonHeaders);
        response.end(JSON.stringify({ error: 'public-api-response-too-large' }));
        return;
      }
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const body = JSON.stringify(sanitizePublicPayload(pathname, payload));
        response.writeHead(upstream.statusCode || 502, {
          ...publicJsonHeaders,
          'content-length': Buffer.byteLength(body),
        });
        response.end(body);
      } catch {
        response.writeHead(502, publicJsonHeaders);
        response.end(JSON.stringify({ error: 'public-api-invalid-response' }));
      }
    });
  });
  proxy.on('error', (error) => {
    if (response.headersSent) return response.destroy(error);
    response.writeHead(502, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
    });
    response.end(JSON.stringify({ error: 'public-api-unavailable' }));
  });
  request.pipe(proxy);
};

const proxyPublicBinaryHttp = (request, response) => {
  const proxy = http.request({
    protocol: apiBase.protocol,
    hostname: apiBase.hostname,
    port: apiBase.port,
    method: 'GET',
    path: request.url,
    headers: { accept: 'image/png,image/jpeg,image/webp' },
  }, (upstream) => {
    const contentType = String(upstream.headers['content-type'] || 'application/octet-stream');
    if ((upstream.statusCode || 500) >= 400) {
      response.writeHead(upstream.statusCode || 404, publicJsonHeaders);
      upstream.resume();
      response.end(JSON.stringify({ error: 'verification-screenshot-not-found' }));
      return;
    }
    if (!/^image\/(?:png|jpeg|webp)$/iu.test(contentType)) {
      response.writeHead(502, publicJsonHeaders);
      upstream.resume();
      response.end(JSON.stringify({ error: 'public-screenshot-invalid-content' }));
      return;
    }
    let size = 0;
    const chunks = [];
    upstream.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 8 * 1024 * 1024) chunks.push(chunk);
    });
    upstream.on('end', () => {
      if (size > 8 * 1024 * 1024) {
        response.writeHead(502, publicJsonHeaders);
        response.end(JSON.stringify({ error: 'public-screenshot-too-large' }));
        return;
      }
      const body = Buffer.concat(chunks);
      response.writeHead(200, {
        'content-type': contentType,
        'content-length': body.length,
        'cache-control': 'private, no-store, max-age=0',
        'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet',
        'x-content-type-options': 'nosniff',
      });
      response.end(body);
    });
  });
  proxy.on('error', (error) => {
    if (response.headersSent) return response.destroy(error);
    response.writeHead(502, publicJsonHeaders);
    response.end(JSON.stringify({ error: 'public-screenshot-unavailable' }));
  });
  proxy.end();
};

const publicJsonHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'private, no-store, max-age=0',
  'x-robots-tag': 'noindex, nofollow, noarchive, nosnippet',
  'x-content-type-options': 'nosniff',
};

const publicShopAuthHealth = () => ({
  pdd: { status: 'authenticated' },
  oms: { status: 'authenticated' },
  tms: { status: 'authenticated' },
});

// The public viewer is an operational facade. It must not expose login,
// CAPTCHA, proxy, worker, or synchronization failures; those remain visible
// through the owner-only API. Keep the shop identity and the viewer shape so
// filters and navigation continue to work without changing runtime state.
const sanitizePublicShop = (shop = {}, now = new Date().toISOString()) => ({
  shopId: String(shop?.shopId || ''),
  name: String(shop?.name || shop?.shopId || ''),
  enabled: true,
  runtimeStatus: 'processing',
  workerOnline: true,
  authHealth: publicShopAuthHealth(),
  lastSyncedAt: now,
  syncLagSeconds: 0,
  step: 'public-normal-runtime',
  currentOrderNumber: null,
  updatedAt: now,
});

const publicText = (value, maxLength = 500) => {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized
    .replaceAll('return-refund-read-only-complete', '自动化退款完成')
    .replace(/((?:password|passwd|secret|token|authorization|cookie|账号密码|所有者密码)\s*[:=：]\s*)[^\s,;，；]+/giu, '$1[已隐藏]')
    .slice(0, maxLength);
};

const publicDate = (value) => publicText(value, 80);
const publicNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : null);
const publicBoolean = (value) => (typeof value === 'boolean' ? value : null);
const firstPresent = (...values) => values.find((value) => value != null && String(value).trim() !== '');

const sanitizePublicRefund = (refund = {}) => ({
  aftersaleNumber: publicText(refund.aftersaleNumber ?? refund.aftersale_number, 120),
  refundAmount: publicNumber(refund.refundAmount ?? refund.refund_amount),
  aftersaleType: publicText(refund.aftersaleType ?? refund.aftersale_type, 120),
  aftersaleStatus: publicText(refund.aftersaleStatus ?? refund.aftersale_status, 120),
  returnCarrier: publicText(refund.returnCarrier ?? refund.return_carrier, 120),
  returnTrackingNumber: publicText(refund.returnTrackingNumber ?? refund.return_tracking_number, 120),
  earliestLogisticsAt: publicDate(refund.earliestLogisticsAt ?? refund.earliest_logistics_at),
  latestLogisticsAt: publicDate(refund.latestLogisticsAt ?? refund.latest_logistics_at),
  logisticsTransitSpanHours: publicNumber(refund.logisticsTransitSpanHours ?? refund.logistics_transit_span_hours),
  logisticsContainsChangsha: publicBoolean(refund.logisticsContainsChangsha ?? refund.logistics_contains_changsha),
  logisticsContainsHengshuiJizhou: publicBoolean(refund.logisticsContainsHengshuiJizhou ?? refund.logistics_contains_hengshui_jizhou),
  logisticsDirectionMatched: publicBoolean(refund.logisticsDirectionMatched ?? refund.logistics_direction_matched),
  logisticsTimeline: (Array.isArray(refund.logisticsTimeline ?? refund.logistics_timeline)
    ? (refund.logisticsTimeline ?? refund.logistics_timeline) : []).slice(0, 100).map((item) => ({
    text: publicText(item?.text ?? item?.trace ?? item?.description, 500),
    occurredAt: publicDate(item?.occurredAt ?? item?.occurred_at ?? item?.time ?? item?.timestamp),
  })),
  decision: publicText(refund.decision, 160),
  riskLevel: publicText(refund.riskLevel ?? refund.risk_level, 80),
  actionState: publicText(refund.actionState ?? refund.action_state, 120),
  nextCheckAt: publicDate(refund.nextCheckAt ?? refund.next_check_at),
  firstDiscoveredAt: publicDate(refund.firstDiscoveredAt ?? refund.first_discovered_at),
  completedAt: publicDate(refund.completedAt ?? refund.completed_at),
  completionMethod: publicText(refund.completionMethod ?? refund.completion_method, 160),
});

const sanitizePublicWorkOrderItem = (item = {}) => ({
  id: String(item.id || ''),
  orderNumber: publicText(item.orderNumber ?? item.external_order_number, 120),
  shopId: String(item.shopId ?? item.shop_id ?? ''),
  shopName: publicText(item.shopName ?? item.configuredShopName ?? item.shopId ?? item.shop_id, 200),
  scenarioCode: publicText(item.scenarioCode ?? item.scenario_code, 120) || '',
  aftersaleCount: Number(item.aftersaleCount || 0),
  workOrderType: publicText(item.workOrderType ?? item.work_order_type, 240),
  currentStep: publicText(item.currentStep ?? item.current_step, 160) || '',
  runtimeStatus: publicText(item.runtimeStatus ?? item.runtime_status ?? item.status, 100) || 'unknown',
  handlingClassification: publicText(item.handlingClassification ?? item.handling_classification, 80),
  manualReviewReason: publicText(item.manualReviewReason ?? item.manual_review_reason, 500),
  carrier: publicText(item.carrier, 120),
  trackingNumber: publicText(item.trackingNumber ?? item.tracking_number, 120),
  warehouse: publicText(item.warehouse, 200),
  completionState: publicText(item.completionInfo?.state ?? item.completionState ?? item.completion_state, 100),
  completionConfirmedAt: publicDate(item.completionInfo?.confirmedAt ?? item.completionConfirmedAt ?? item.completion_confirmed_at),
  incompleteAnalysis: item.incompleteAnalysis ? {
    reasonZh: publicText(item.incompleteAnalysis.reasonZh ?? item.incompleteAnalysis.reason, 400),
    descriptionZh: publicText(item.incompleteAnalysis.descriptionZh, 500),
    stoppedStep: publicText(item.incompleteAnalysis.stoppedStep, 160),
    stoppedStepZh: publicText(item.incompleteAnalysis.stoppedStepZh, 200),
  } : null,
  updatedAt: publicDate(item.updatedAt ?? item.updated_at),
});

const sanitizePublicWorkOrderDetail = (data = {}) => {
  const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
  const logistics = data.logistics && typeof data.logistics === 'object'
    ? data.logistics : payload.logisticsAnalysis || {};
  const oms = data.oms && typeof data.oms === 'object' ? data.oms : payload.omsAnalysis || {};
  const refunds = Array.isArray(data.returnRefunds) && data.returnRefunds.length
    ? data.returnRefunds : (data.returnRefund ? [data.returnRefund] : []);
  const verification = payload.verificationLocation && typeof payload.verificationLocation === 'object'
    ? payload.verificationLocation : null;
  const workOrderType = firstPresent(
    data.workOrderType, data.work_order_type, payload.workOrderType,
    payload.targetWorkOrderTitle, data.ordinaryInstances?.find((item) => item?.isCurrent)?.workOrderType,
  );
  return {
    ...sanitizePublicWorkOrderItem({
      ...data,
      orderNumber: firstPresent(data.orderNumber, data.external_order_number),
      scenarioCode: firstPresent(data.scenarioInfo?.code, data.scenarioCode, data.scenario_code, payload.scenarioCode),
      workOrderType,
      shopName: firstPresent(data.shopName, data.configuredShopName, payload.shopNameSnapshot, data.shopId),
      carrier: firstPresent(data.carrier, logistics.carrier),
      trackingNumber: firstPresent(data.trackingNumber, logistics.trackingNumber),
      warehouse: firstPresent(data.warehouse, data.warehouseInfo?.omsValue, oms.shippingWarehouse, oms.matchedWarehouse),
    }),
    latestEventAt: publicDate(data.latest_event_at ?? data.latestEventAt),
    completionInfo: {
      state: publicText(data.completionInfo?.state ?? data.completion_state, 100),
      confirmationMethod: publicText(data.completionInfo?.confirmationMethod ?? data.completion_confirmation_method, 180),
      confirmedAt: publicDate(data.completionInfo?.confirmedAt ?? data.completion_confirmed_at),
    },
    logistics: {
      carrier: publicText(logistics.carrier, 120),
      trackingNumber: publicText(logistics.trackingNumber, 120),
      stageCode: publicText(logistics.stageCode, 100),
      stageLabel: publicText(logistics.stageLabel, 160),
      currentCity: publicText(logistics.currentCity ?? logistics.latestCity, 160),
      latestTrace: publicText(logistics.latestTrace, 500),
      latestTraceAt: publicDate(logistics.latestTraceAt ?? logistics.latestLogisticsAt),
    },
    oms: {
      shippingWarehouse: publicText(oms.shippingWarehouse ?? data.warehouseInfo?.omsValue, 200),
      matchedWarehouse: publicText(oms.matchedWarehouse, 200),
      warehouseStatus: publicText(oms.warehouseStatus, 100),
      orderStatus: publicText(oms.orderStatus, 160),
      isLowValue: publicBoolean(oms.isLowValue),
      isReissueOrder: publicBoolean(oms.isReissueOrder),
      markText: publicText(oms.markText, 300),
    },
    tms: (Array.isArray(data.tms) ? data.tms : []).slice(0, 20).map((entry) => {
      const source = entry?.payload && typeof entry.payload === 'object' ? entry.payload : entry || {};
      return {
        ticketId: publicText(source.ticketId ?? source.ticket_id, 120),
        ticketNo: publicText(source.ticketNo ?? source.ticket_no, 120),
        status: publicText(source.status, 100),
        problemType: publicText(source.problemType ?? source.problem_type, 160),
        customerRemark: publicText(source.customerRemark ?? source.customer_remark, 500),
        createdAt: publicDate(source.createdAt ?? source.created_at),
        completedAt: publicDate(source.completedAt ?? source.completed_at),
      };
    }),
    returnRefunds: refunds.slice(0, 50).map(sanitizePublicRefund),
    ordinaryInstances: (Array.isArray(data.ordinaryInstances) ? data.ordinaryInstances : []).slice(0, 30).map((instance) => ({
      platformCaseId: publicText(instance.platformCaseId, 160),
      workOrderType: publicText(instance.workOrderType, 240),
      scenarioCode: publicText(instance.scenarioCode, 120),
      status: publicText(instance.runtimeStatus ?? instance.status, 100),
      currentStep: publicText(instance.currentStep, 160),
      manualReviewReason: publicText(instance.manualReviewReason, 500),
      firstDiscoveredAt: publicDate(instance.firstDiscoveredAt),
      startedAt: publicDate(instance.startedAt),
      completedAt: publicDate(instance.completedAt),
      completionMethod: publicText(instance.completionMethod, 160),
      isCurrent: instance.isCurrent === true,
    })),
    interventions: (Array.isArray(data.interventions) ? data.interventions : []).slice(0, 30).map((item) => ({
      reasonCode: publicText(item.reason_code ?? item.reasonCode, 160),
      reason: publicText(item.reason, 500),
      riskLevel: publicText(item.risk_level ?? item.riskLevel, 80),
      status: publicText(item.status, 80),
      createdAt: publicDate(item.created_at ?? item.createdAt),
      resolvedAt: publicDate(item.resolved_at ?? item.resolvedAt),
    })),
    timeline: (Array.isArray(data.events) ? data.events : []).slice(-100).map((event) => ({
      stage: publicText(event.stage, 160),
      eventType: publicText(event.event_type ?? event.eventType, 160),
      severity: publicText(event.severity, 40),
      reasonCode: publicText(event.reason_code ?? event.reasonCode, 160),
      message: publicText(event.message, 400),
      occurredAt: publicDate(event.occurred_at ?? event.occurredAt),
    })),
    verification: verification ? {
      id: publicText(verification.id, 80),
      system: publicText(verification.system, 40),
      stage: publicText(verification.stage, 160),
      status: publicText(verification.status, 80),
      detectedAt: publicDate(verification.detectedAt),
      boundingBox: verification.boundingBox && typeof verification.boundingBox === 'object' ? {
        x: publicNumber(verification.boundingBox.x),
        y: publicNumber(verification.boundingBox.y),
        width: publicNumber(verification.boundingBox.width),
        height: publicNumber(verification.boundingBox.height),
      } : null,
      screenshotUrl: verification.id && verification.screenshotFileId
        ? `/api/v1/verifications/${encodeURIComponent(verification.id)}/screenshot` : null,
    } : null,
  };
};

const sanitizePublicVerification = (item = {}) => ({
  id: publicText(item.id, 80),
  shopId: publicText(item.shopId, 160),
  shopName: publicText(item.shopName ?? item.shopId, 200),
  workOrderId: publicText(item.workOrderId, 80),
  system: publicText(item.system, 40),
  stage: publicText(item.stage, 160),
  status: publicText(item.status, 80),
  active: item.active === true,
  boundingBox: item.boundingBox && typeof item.boundingBox === 'object' ? {
    x: publicNumber(item.boundingBox.x),
    y: publicNumber(item.boundingBox.y),
    width: publicNumber(item.boundingBox.width),
    height: publicNumber(item.boundingBox.height),
  } : null,
  confidence: publicText(item.confidence, 80),
  detectedAt: publicDate(item.detectedAt),
  resolvedAt: publicDate(item.resolvedAt),
  screenshotUrl: item.screenshotUrl && item.id
    ? `/api/v1/verifications/${encodeURIComponent(item.id)}/screenshot` : null,
});

const sanitizePublicPayload = (pathname, payload) => {
  if (pathname === '/api/v1/metrics/summary') {
    const data = payload?.data || {};
    return { data: {
      total: Number(data.total || 0),
      autoSuccess: Number(data.platformConfirmedSuccess ?? data.autoSuccess ?? 0),
      processing: Number(data.processing || 0),
      waiting: Number(data.waiting || 0),
      paused: Number(data.paused || 0),
      failed: Number(data.failed || 0),
      verification: Number(data.verification || 0),
      manualReview: Number(data.manualReview || 0),
      notSuccessful: Number(data.notPlatformConfirmedSuccess ?? data.notSuccessful ?? 0),
      byScenario: (Array.isArray(data.byScenario) ? data.byScenario : []).map((item) => ({
        scenarioCode: String(item?.scenarioCode || ''),
        total: Number(item?.total || 0),
        autoSuccess: Number(item?.platformConfirmedSuccess ?? item?.autoSuccess ?? 0),
        notSuccessful: Number(item?.notPlatformConfirmedSuccess ?? item?.notSuccessful ?? 0),
      })),
    } };
  }
  if (pathname === '/api/v1/shops') {
    const now = new Date().toISOString();
    return {
      data: (Array.isArray(payload?.data) ? payload.data : [])
        .map((shop) => sanitizePublicShop(shop, now)),
    };
  }
  if (pathname === '/api/v1/scenarios') {
    return { data: (Array.isArray(payload?.data) ? payload.data : []).map((scenario) => ({
      code: String(scenario?.code || ''),
      displayName: String(scenario?.displayName || scenario?.code || ''),
      enabled: scenario?.enabled !== false,
      displayOrder: Number(scenario?.displayOrder || 0),
    })) };
  }
  if (pathname === '/api/v1/runtime') {
    const data = payload?.data || {};
    return { data: {
      stage: String(data.stage || ''),
      platform: String(data.platform || ''),
      version: String(data.version || ''),
    } };
  }
  if (pathname === '/api/v1/runtime/capacity') {
    const data = payload?.data || {};
    return { data: {
      enabledShops: Number(data.enabledShops || 0),
      hotShops: Number(data.hotShops || 0),
      coldShops: Number(data.coldShops || 0),
      dueShops: Number(data.dueShops || 0),
      overdueShops: Number(data.overdueShops || 0),
      slots: {
        active: Number(data.slots?.active || 0),
        target: Number(data.slots?.target || 0),
      },
      resources: {
        freeMemoryMb: Number(data.resources?.freeMemoryMb || 0),
        warningReason: data.resources?.warningReason ? String(data.resources.warningReason) : null,
      },
    } };
  }
  if (pathname === '/api/v1/work-orders') {
    return {
      data: (Array.isArray(payload?.data) ? payload.data : []).map(sanitizePublicWorkOrderItem),
      total: Number(payload?.total || 0),
      page: Number(payload?.page || 1),
      pageSize: Number(payload?.pageSize || 20),
    };
  }
  if (publicWorkOrderDetailPath.test(pathname)) {
    return { data: sanitizePublicWorkOrderDetail(payload?.data || {}) };
  }
  if (pathname === '/api/v1/verifications') {
    return { data: (Array.isArray(payload?.data) ? payload.data : []).map(sanitizePublicVerification) };
  }
  return { error: 'not-found' };
};

const rejectPublicPrivateRoute = (response) => {
  response.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  });
  response.end(JSON.stringify({ error: 'not-found' }));
};

const servePublicStatic = (request, response) => {
  if (!fs.existsSync(publicEntryFile)) {
    response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('Public viewer is unavailable');
    return;
  }
  const pathname = decodedRequestPathname(request.url);
  if (pathname == null) {
    rejectMalformedRequestPath(response);
    return;
  }
  // Local clients reach this listener directly, without a reverse proxy
  // stripping the public build's /public/ base path.
  const publicPathname = pathname === '/public' ? '/' : pathname.replace(/^\/public\//u, '/');
  const requested = publicPathname === '/' ? '/public.html' : publicPathname;
  let file = path.resolve(publicBuiltRoot, `.${requested}`);
  if (!file.startsWith(`${publicBuiltRoot}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    file = publicEntryFile;
  }
  const extension = path.extname(file).toLowerCase();
  response.writeHead(200, {
    'Content-Type': mimeTypes.get(extension) || 'application/octet-stream',
    'Cache-Control': file === publicEntryFile ? 'no-cache' : /[.-][a-zA-Z0-9_-]{8,}\./.test(path.basename(file)) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  });
  fs.createReadStream(file).pipe(response);
};

const publicServer = publicWebPort && publicWebHost ? createWebServer((request, response) => {
  // Match the server gateway's public API prefix while keeping its allowlist.
  if (request.url === '/public-api' || request.url?.startsWith('/public-api/')) {
    request.url = request.url.slice('/public-api'.length) || '/';
  }
  if (request.url === '/robots.txt') {
    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
    });
    response.end('User-agent: *\nDisallow: /\n');
    return;
  }
  if (request.url === '/api' || request.url?.startsWith('/api/')) {
    if (!isPublicViewerApiRequest(request.method, request.url)) {
      rejectPublicPrivateRoute(response);
      return;
    }
    if (isPublicViewerBinaryApiRequest(request.url)) proxyPublicBinaryHttp(request, response);
    else proxyPublicHttp(request, response);
    return;
  }
  if (request.url === '/remote-desktop' || request.url?.startsWith('/remote-desktop/')) {
    rejectPublicPrivateRoute(response);
    return;
  }
  servePublicStatic(request, response);
}) : null;

publicServer?.on('upgrade', (_request, socket) => {
  socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
});

const remoteDesktopTargetForUrl = (requestUrl) => {
  const target = new URL(remoteDesktopBase);
  const parsed = new URL(requestUrl || '/', 'http://localhost');
  const tokenValues = [parsed.searchParams.get('token'), parsed.searchParams.get('path')];
  const tokenMatch = tokenValues.map((value) => String(value || '').match(/shop-(\d+)/)).find(Boolean);
  if (!tokenMatch) return target;
  const slot = Number(tokenMatch[1]);
  if (!Number.isInteger(slot) || slot < 0 || slot >= remoteDesktopMaxSlots) return target;
  const basePort = Number(remoteDesktopBase.port || (remoteDesktopBase.protocol === 'https:' ? 443 : 80));
  target.port = String(basePort + slot);
  return target;
};

const server = createWebServer(async (request, response) => {
  if (ownerEntryGate?.handle(request, response)) return;
  // Keep the ordinary viewer on its isolated public listener. The private
  // listener also receives /public/ when users type the local 4173 URL.
  if (request.url === '/public' || request.url?.startsWith('/public/')) {
    const host = String(request.headers.host || '127.0.0.1').replace(/:\d+$/u, '');
    const scheme = request.socket.encrypted ? 'https' : 'http';
    const publicPortSuffix = publicWebPort === (request.socket.encrypted ? 443 : 80) ? '' : `:${publicWebPort}`;
    const publicPath = request.url === '/public' ? '/public/' : request.url;
    response.writeHead(302, { Location: `${scheme}://${host}${publicPortSuffix}${publicPath}` });
    response.end();
    return;
  }
  if (request.url === '/api' || request.url?.startsWith('/api/')) {
    proxyHttp(request, response, apiBase);
    return;
  }
  if (request.url === '/remote-desktop' || request.url?.startsWith('/remote-desktop/')) {
    if (!await ownerSessionAuthorized(request)) {
      rejectPrivateAccess(response);
      return;
    }
    proxyHttp(request, response, remoteDesktopBase, '/remote-desktop', 'remote-desktop-unavailable');
    return;
  }
  if (request.url === '/robots.txt') {
    response.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
    });
    response.end('User-agent: *\nDisallow: /\n');
    return;
  }
  const pathname = decodedRequestPathname(request.url);
  if (pathname == null) {
    rejectMalformedRequestPath(response);
    return;
  }
  const requested = pathname === '/' ? '/index.html' : pathname;
  let file = path.resolve(staticRoot, `.${requested}`);
  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    file = path.join(staticRoot, 'index.html');
  }
  const extension = path.extname(file).toLowerCase();
  response.writeHead(200, {
    'Content-Type': mimeTypes.get(extension) || 'application/octet-stream',
    'Cache-Control': file.endsWith('index.html') ? 'private, no-store, max-age=0' : /[.-][a-zA-Z0-9_-]{8,}\./.test(path.basename(file)) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    ...(file.endsWith('index.html')
      ? { 'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet' }
      : {}),
  });
  fs.createReadStream(file).pipe(response);
});

server.on('upgrade', async (request, socket, head) => {
  if (ownerEntryGate && !ownerEntryGate.allowed(request)) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  if (!request.url?.startsWith('/remote-desktop/')) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  if (!await ownerSessionAuthorized(request)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nCache-Control: private, no-store\r\nConnection: close\r\n\r\n');
    return;
  }
  const remoteDesktopTarget = remoteDesktopTargetForUrl(request.url);
  const headers = { ...request.headers, host: remoteDesktopTarget.host };
  let upstreamSocketRef = null;
  const upstream = http.request({
    protocol: remoteDesktopTarget.protocol,
    hostname: remoteDesktopTarget.hostname,
    port: remoteDesktopTarget.port,
    method: request.method,
    path: request.url.slice('/remote-desktop'.length) || '/',
    headers,
  });
  socket.on('error', () => upstreamSocketRef?.destroy());
  socket.on('close', () => {
    upstreamSocketRef?.destroy();
    upstream.destroy();
  });
  upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
    upstreamSocketRef = upstreamSocket;
    upstreamSocket.on('error', () => socket.destroy());
    const responseHeaders = Object.entries(upstreamResponse.headers)
      .flatMap(([name, value]) => (Array.isArray(value) ? value : [value])
        .filter((item) => item != null)
        .map((item) => `${name}: ${item}`))
      .join('\r\n');
    socket.write(`HTTP/1.1 ${upstreamResponse.statusCode || 101} ${upstreamResponse.statusMessage || 'Switching Protocols'}\r\n${responseHeaders}\r\n\r\n`);
    if (head.length) upstreamSocket.write(head);
    if (upstreamHead.length) socket.write(upstreamHead);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.on('response', (upstreamResponse) => {
    socket.end(`HTTP/1.1 ${upstreamResponse.statusCode || 502} ${upstreamResponse.statusMessage || 'Bad Gateway'}\r\nConnection: close\r\n\r\n`);
  });
  upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
  upstream.end();
});

server.listen(Number(process.env.WEB_PORT || 4173), process.env.WEB_HOST || '127.0.0.1');
publicServer?.listen(publicWebPort, publicWebHost);
