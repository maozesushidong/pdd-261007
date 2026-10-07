export const shopNames = {
  'panapopo-healthcare': 'PANAPOPO医疗保健官方旗舰店林动',
  'panapopo-medical-device': 'PANAPOPO医疗器械官方旗舰店梦蝶',
  'songteng-yazc-overseas': '松藤Yazc海外好物馆林动',
};

export const scenarioNames = {
  'in-transit-refund': '在途无理由退款',
  'in-transit-no-reason-refund': '在途无理由退款',
  'shipped-no-tracking-refund': '已发货无轨迹退款',
  'abnormal-network-warning': '异常网点预警',
  'delivery-risk-concern': '消费者担忧货物无法送达',
  'proactive-logistics-service': '物流异常主动服务',
  'reverse-logistics-signed-refund': '逆向物流已签收退款',
  'intercept-recall': '消费者申请退款后提示拦截',
  'good-deed-expedited-shipping': '好人好事服务单-加急发货',
  'delivered-not-received': '消费者反馈未收到货',
  'consumer-refusal': '消费者拒收问题处理',
  'return-refund': '退货退款',
  unknown: '未识别场景',
};

export const statusNames = {
  completed: '已完成', archived: '已归档', processing: '处理中', queued: '待处理', idle: '空闲',
  'retry-ready': '等待重试', 'operator-paused': '店铺已暂停',
  waiting: '等待中', verification: '等待验证', 'manual-review': '人工复核', failed: '已中断', paused: '已暂停',
  open: '待处理', acknowledged: '已确认', resolved: '已解决', cancelled: '已取消',
  expired: '已过期', pending: '待发送', sending: '发送中', sent: '已发送',
  'waiting-login': '等待登录', initializing: '正在启动', ready: '已就绪',
  'identity-mismatch': '身份不匹配', disabled: '已停用', error: '启动异常',
  'proxy-unavailable': '代理不可用',
  unreachable: '连接异常',
  'worker-online': 'Worker 在线', 'worker-offline': 'Worker 离线', unknown: '待检测',
};

export const stageNames = {
  'manual-review-blocked': '等待人工复核', 'flow-paused': '流程已中断',
  'browser-proxy-unavailable': '代理不可用，处理已暂停',
  'human-verification-required': '等待人工验证', 'full-business-flow-complete': '全流程完成',
  'requested-order-complete': '指定工单完成', 'next-order-ready': '准备下一单',
  'pdd-list-waiting': 'PDD 列表轮询', 'queue-empty': '队列暂无工单',
  'queue-waiting': '等待下次复查', 'queue-recovery-held': '队列恢复保护中',
  'return-refund-queue-waiting': '退货退款等待下次复查',
  'return-refund-queue-recovery-held': '退货退款恢复保护中',
  'return-refund-queue-empty': '退货退款队列暂无工单',
  'rate-limited-waiting': '平台限流冷却中', 'rate-limit-recovered': '平台限流已恢复',
  'logistics-waiting-released': '等待物流更新',
  'consumer-response-waiting-released': '等待消费者回复',
  'operator-page-refreshed': '业务页面已刷新',
  'operator-refreshed-next-order': '已挂起并切换下一单',
  'public-normal-runtime': '队列正常运行中',
  'system-shutdown-drained': '系统停止前已安全排空',
  'pdd-resolution-submit': 'PDD 处理方案提交', 'pdd-order-remark': 'PDD 订单红色备注',
  'pdd-order-remark-starting': '正在写入 PDD 订单备注', 'pdd-order-remark-saved': 'PDD 订单备注已保存',
  'pdd-order-remark-reconciled': 'PDD 订单备注已核对', 'pdd-order-remark-not-applied': 'PDD 订单备注待重试',
  'external-state-reconciling': '正在核对平台状态',
  'external-state-reconciliation-retry': '等待重新核对平台状态',
  'external-state-confirmed': '平台状态已确认', 'external-state-unresolved': '平台状态仍不确定',
  'external-state-reconciliation-failed': '平台状态核对失败',
  'tms-autofill-verification': 'TMS 仓库自动填充校验',
  'oms-order-search': 'OMS 订单查询', 'oms-tab-open': 'OMS 标签页打开',
  'page-navigation': '页面导航', 'manual-login-required': '等待重新登录',
  'return-refund-scan-starting': '正在扫描退货退款',
  'return-refund-scan-complete': '退货退款扫描完成',
  'return-refund-decision': '退款规则判断',
  'return-refund-ready': '等待自动退款',
  'return-refund-read-only-ready': '只读核对完成',
  'return-refund-waiting-logistics': '等待买家退货物流',
  'return-refund-manual-review': '退货退款转人工',
  'return-refund-page-error': '退货退款页面异常',
  'return-refund-verification-required': '等待退款结果复核',
  'return-refund-auto-complete': '自动退款完成',
  'return-refund-manual-completed': '人工退款已完成',
  'return-refund-approve': '提交同意退款',
};

export const formatDateTime = (value) => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
};

export const formatDuration = (seconds) => {
  const value = Number(seconds);
  if (!Number.isFinite(value)) return '-';
  if (value < 60) return `${value} 秒`;
  if (value < 3600) return `${Math.floor(value / 60)} 分钟`;
  return `${Math.floor(value / 3600)} 小时 ${Math.floor((value % 3600) / 60)} 分钟`;
};

export const labelScenario = (code) => scenarioNames[code] || code || '未识别场景';
export const labelStatus = (status) => statusNames[status] || status || '未知';
export const labelStage = (stage) => stageNames[stage] || stage || '-';
export const labelShop = (shop) => {
  if (shop && typeof shop === 'object') {
    const shopId = shop.shopId || shop.shop_id;
    return shop.shopName || shop.actualShopName || shop.name
      || shopNames[shopId] || shopId || '-';
  }
  return shopNames[shop] || shop || '-';
};
export const pddLoginState = (shop = {}, { now = Date.now() } = {}) => {
  const onboardingStatus = String(shop.onboardingStatus || '');
  const pddStatus = String(shop.authHealth?.pdd?.status || 'unknown');
  const actualShopName = String(
    shop.workerMetadata?.actualShopName || shop.boundShopName || shop.confirmedShopName || '',
  ).trim();
  const expectedShopName = String(shop.expectedShopName || shop.name || shop.shopId || '').trim();
  const mallId = String(
    shop.workerMetadata?.mallId || shop.mallId || shop.boundMallId || shop.confirmedMallId || '',
  ).trim();
  const identitySuffix = mallId ? ` · mall:${mallId}` : '';
  const onboardingError = String(shop.onboardingError || '').trim();
  const identityMismatch = onboardingStatus === 'identity-mismatch'
    || /重复登录|店铺.*不一致|identity.{0,20}mismatch/iu.test(onboardingError);
  const proxyHealth = shop.workerMetadata?.browserProxyHealth;
  // Keep the recovery action available when a wrong PDD account is detected,
  // even if a separate proxy health signal is also present.
  if (identityMismatch) {
    return {
      status: 'identity-mismatch',
      label: '登录错店',
      detail: actualShopName
        ? `检测账号：${actualShopName}${identitySuffix}，系统已阻止串店处理`
        : `配置：${expectedShopName}（${shop.shopId || '未编号'}），系统已阻止处理`,
      actualShopName,
      expectedShopName,
      mallId,
      error: onboardingError,
    };
  }
  if (shop.workerMetadata?.state === 'browser-proxy-unavailable' || proxyHealth?.ok === false) {
    return {
      status: 'proxy-unavailable',
      label: '代理不可用',
      detail: proxyHealth?.retryAt
        ? `自动处理已暂停，下次检测 ${formatDateTime(proxyHealth.retryAt)}`
        : '自动处理已暂停，等待代理恢复',
      actualShopName,
      expectedShopName,
      mallId,
      error: proxyHealth?.error || proxyHealth?.errorCode || null,
    };
  }
  const authCheckedAt = Date.parse(shop.authHealth?.pdd?.checkedAt || '');
  const authAgeMs = now - authCheckedAt;
  const recentAuthObservation = Number.isFinite(authAgeMs)
    && authAgeMs >= 0 && authAgeMs <= 60_000;
  const runtimeAge = shop.runtimeObservationAgeSeconds == null
    ? null : Number(shop.runtimeObservationAgeSeconds);
  const hasPreviousObservation = Number.isFinite(authCheckedAt)
    || (runtimeAge != null && Number.isFinite(runtimeAge));
  // A live parent heartbeat can outlast its browser observer. Keep cached
  // auth evidence for diagnostics without presenting it as today's login.
  if (hasPreviousObservation && !recentAuthObservation
    && (shop.runtimeObservationStale === true
      || (runtimeAge != null && Number.isFinite(runtimeAge) && runtimeAge > 60))) {
    return {
      status: 'observation-stale',
      label: '状态待更新',
      detail: '最近页面状态尚未更新，暂不能确认当前登录和自动处理状态',
      actualShopName,
      expectedShopName,
      mallId,
    };
  }
  if (pddStatus === 'expired') {
    return {
      status: 'waiting-login',
      label: '需要登录',
      detail: `登录窗口：${expectedShopName}（${shop.shopId || '未编号'}）${identitySuffix}`,
      actualShopName,
      expectedShopName,
      mallId,
    };
  }
  if (pddStatus === 'unreachable') {
    return {
      status: 'unreachable',
      label: '连接异常',
      detail: '拼多多页面当前不可访问，自动处理等待网络恢复',
      actualShopName,
      expectedShopName,
      mallId,
    };
  }
  if (pddStatus === 'verification-required') {
    return {
      status: 'verification',
      label: '等待验证',
      detail: actualShopName ? `当前账号：${actualShopName}${identitySuffix}` : `应登录：${expectedShopName}`,
      actualShopName,
      expectedShopName,
      mallId,
    };
  }
  const confirmedLiveIdentity = Boolean(shop.workerOnline)
    && Boolean(actualShopName)
    && Boolean(mallId);
  if (pddStatus === 'authenticated'
    && (onboardingStatus === 'ready' || confirmedLiveIdentity)) {
    return {
      status: 'authenticated',
      label: '已登录',
      detail: actualShopName ? `当前账号：${actualShopName}${identitySuffix}` : `${expectedShopName}${identitySuffix}`,
      actualShopName,
      expectedShopName,
      mallId,
    };
  }
  if (onboardingStatus === 'waiting-login') {
    return {
      status: 'waiting-login',
      label: '需要登录',
      detail: `登录窗口：${expectedShopName}（${shop.shopId || '未编号'}）${identitySuffix}`,
      actualShopName,
      expectedShopName,
      mallId,
    };
  }
  return {
    status: pddStatus,
    label: '待检测',
    detail: `应登录：${expectedShopName}（${shop.shopId || '未编号'}）${identitySuffix}`,
    actualShopName,
    expectedShopName,
    mallId,
  };
};

export const publicSystemLoginState = (health = {}) => {
  const status = String(health?.status || 'unknown');
  if (status === 'authenticated') return { status, label: '已登录' };
  if (status === 'expired') return { status, label: '需要登录' };
  if (status === 'unreachable') return { status, label: '连接异常' };
  if (status === 'verification-required') return { status: 'verification', label: '等待验证' };
  return { status, label: '待检测' };
};

export const remoteDesktopUrl = (shop) => shop?.remoteDesktopPath
  || '/remote-desktop/vnc.html?autoconnect=true&reconnect=true&reconnect_delay=1000&resize=scale&path=remote-desktop%2Fwebsockify%3Ftoken%3Dshop-0';
export const vncUrlForShop = (shop) => remoteDesktopUrl(shop);

export const runtimeTone = (status) => {
  if (['completed', 'archived', 'sent', 'resolved', 'authenticated', 'ready', 'worker-online'].includes(status)) return 'success';
  if (['failed', 'manual-review', 'paused', 'identity-mismatch', 'error', 'worker-offline'].includes(status)) return 'danger';
  if (['waiting', 'verification', 'acknowledged', 'pending', 'waiting-login', 'expired', 'proxy-unavailable', 'unreachable', 'observation-stale'].includes(status)) return 'warning';
  if (['processing', 'sending', 'initializing'].includes(status)) return 'info';
  return 'neutral';
};

export const humanizeKey = (key) => ({
  carrier: '快递公司', trackingNumber: '物流单号', warehouse: '发货仓库', warehouseName: '发货仓库',
  shippingWarehouse: '发货仓库', matchedWarehouse: '匹配仓库', normalizedWarehouse: '标准化仓库',
  currentCity: '当前城市', latestCity: '最新城市', shippingCity: '发货城市', originCity: '始发城市', destination: '目的地',
  stageCode: '物流阶段', stageAnalysis: '物流阶段分析', outsideOriginCity: '已离开始发地', merchantHandover: '商家已交接',
  stageLabel: '阶段说明', latestTrace: '最新轨迹', isLowValue: '低值品', isReissueOrder: '补发单',
  isTargetWarehouse: '目标仓库', markText: '订单标记', warningText: '预警信息', actual: '实际数据', conflicts: '冲突项',
  ticketId: 'TMS 工单 ID', ticketNo: 'TMS 工单号', problemType: '问题类型', customerRemark: '客服备注',
  status: '状态', reason: '判断原因', outcome: '处理结果', orderNumber: '订单号', scenarioCode: '场景',
  workOrderType: '工单类型', currentStep: '当前阶段', runtimeStatus: '运行状态',
  aftersaleNumber: '售后编号', aftersaleCount: '售后次数', aftersaleType: '售后类型', aftersaleStatus: '售后状态',
  refundAmount: '退款金额', returnCarrier: '退货快递', returnTrackingNumber: '退货物流单号',
  earliestLogisticsAt: '首条物流时间', latestLogisticsAt: '物流更新时间',
  logisticsTransitSpanHours: '物流首尾跨度（小时）', logisticsContainsChangsha: '物流包含长沙',
  logisticsContainsHengshuiJizhou: '物流包含衡水冀州', logisticsDirectionMatched: '物流方向命中',
  firstDiscoveredAt: '首次发现时间',
  actionState: '退款处理状态', nextCheckAt: '下次检查时间', completedAt: '关闭时间',
  ruleResults: '规则命中结果', evidence: '证据', workOrderId: '工单记录 ID',
  platformCaseId: '平台工单编号', platformCaseKey: '平台工单身份', ordinaryInstanceId: '工单实例 ID',
  ordinaryInstanceCount: '平台工单次数', identityStatus: '身份状态', detailUrl: '平台详情地址',
  firstDiscoveredAt: '首次发现时间', lastDiscoveredAt: '最近发现时间', startedAt: '开始处理时间',
  completionMethod: '完成确认方式', nextAttemptAt: '下次尝试时间', isCurrent: '当前实例',
  handlingClassification: '处理分类', handlingClassificationSource: '分类来源',
  latestEventAt: '最后事件', manualReviewReason: '人工原因', classificationSource: '分类来源',
}[key] || key);

export const formatReturnRefundDirection = (refund = {}) => {
  const matched = [
    refund.logisticsContainsChangsha === true ? '长沙' : null,
    refund.logisticsContainsHengshuiJizhou === true ? '衡水冀州' : null,
  ].filter(Boolean);
  if (matched.length) return matched.join(' / ');
  if (refund.actionState === 'waiting-logistics' || refund.decision === 'wait-logistics') return '等待方向';
  return '未命中';
};
