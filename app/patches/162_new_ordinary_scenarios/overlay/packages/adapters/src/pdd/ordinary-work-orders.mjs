const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const REISSUE_TRACKING_WAIT_MS = 3 * HOUR_MS;
const REISSUE_TRACKING_RECHECK_MS = 30 * 60_000;

export const ORDINARY_SCENARIO_CODES = Object.freeze({
  DELIVERY_RISK_CONCERN: 'delivery-risk-concern',
  PROACTIVE_LOGISTICS_SERVICE: 'proactive-logistics-service',
  REVERSE_LOGISTICS_SIGNED_REFUND: 'reverse-logistics-signed-refund',
  INTERCEPT_RECALL: 'intercept-recall',
  GOOD_DEED_EXPEDITED_SHIPPING: 'good-deed-expedited-shipping',
  DELIVERED_NOT_RECEIVED: 'delivered-not-received',
  CONSUMER_REFUSAL: 'consumer-refusal',
  PRODUCT_SHORTAGE: 'product-shortage',
});

export const ORDINARY_SCENARIO_DEPENDENCIES = Object.freeze({
  [ORDINARY_SCENARIO_CODES.DELIVERY_RISK_CONCERN]: Object.freeze({
    pdd: true,
    oms: 'conditional',
    tms: 'conditional',
  }),
  [ORDINARY_SCENARIO_CODES.PROACTIVE_LOGISTICS_SERVICE]: Object.freeze({
    pdd: true,
    oms: false,
    tms: false,
  }),
  [ORDINARY_SCENARIO_CODES.REVERSE_LOGISTICS_SIGNED_REFUND]: Object.freeze({
    pdd: true,
    oms: false,
    tms: false,
  }),
  [ORDINARY_SCENARIO_CODES.INTERCEPT_RECALL]: Object.freeze({
    pdd: true,
    oms: true,
    tms: true,
  }),
  [ORDINARY_SCENARIO_CODES.GOOD_DEED_EXPEDITED_SHIPPING]: Object.freeze({
    pdd: true,
    oms: true,
    tms: false,
  }),
  [ORDINARY_SCENARIO_CODES.DELIVERED_NOT_RECEIVED]: Object.freeze({
    pdd: true,
    oms: true,
    tms: true,
  }),
  [ORDINARY_SCENARIO_CODES.CONSUMER_REFUSAL]: Object.freeze({
    pdd: true,
    oms: true,
    tms: true,
  }),
  [ORDINARY_SCENARIO_CODES.PRODUCT_SHORTAGE]: Object.freeze({
    pdd: true,
    oms: true,
    tms: true,
  }),
});

const ORDINARY_PDD_OPTION_GROUPS = Object.freeze([
  Object.freeze(['已进行召回', '已召回', '已完成召回', '已拦截成功']),
  Object.freeze(['消费者已收到货', '消费者已收货', '消费者已签收', '已签收']),
  Object.freeze([
    '未收到退货商品',
    '未收到退回的商品',
    '未收到退回商品',
    '未收到退货',
    '未查到退货商品',
  ]),
  Object.freeze([
    '有退货物流轨迹',
    '有查到物流轨迹',
    '查到退货物流轨迹',
    '已查到退货物流轨迹',
  ]),
  Object.freeze(['物流已更新', '物流已恢复更新', '物流已正常更新', '物流恢复', '轨迹已更新']),
  Object.freeze(['物流可以更新，能送达', '物流可以更新,能送达', '物流可更新，能送达', '物流预计可以更新，能送达']),
  Object.freeze(['需联系物流核实', '需要联系物流核实', '需要核实联系物流核实']),
  Object.freeze(['告知送达地址并承诺核实', '告知送达地址，承诺核实', '告知送达地址、承诺核实']),
  Object.freeze(['发送凭证', '发送联系凭证', '向消费者发送凭证']),
  Object.freeze(['需要消费者自取', '消费者需要自取', '需消费者自取']),
  Object.freeze(['快递会联系消费者', '快递联系消费者', '快递将联系消费者']),
  Object.freeze(['发送拦截', '发起拦截', '联系快递拦截']),
  Object.freeze(['拦截成功同意退款', '拦截成功并同意退款', '已拦截成功同意退款']),
  Object.freeze(['待拦截快递退款', '等待拦截快递退款', '待快递拦截后退款']),
  Object.freeze(['同意退款', '同意消费者退款申请', '已同意退货退款']),
  Object.freeze(['快递已拦截成功', '快递召回成功', '包裹已成功拦截', '召回任务已完成']),
  Object.freeze(['快递还在拦截中', '快递仍在召回中', '召回任务处理中', '等待拦截结果']),
  Object.freeze(['快递拦截失败', '快递召回失败', '无法拦截快递', '召回未成功']),
  Object.freeze([
    '消费者接受拦截成功后再退款',
    '消费者同意拦截成功后退款',
    '买家接受拦截后退款',
  ]),
  Object.freeze(['消费者不接受', '消费者拒绝拦截后退款', '买家不同意拦截后退款']),
  Object.freeze([
    '消费者超12小时未回复',
    '消费者超过12小时未回复',
    '买家12小时未回应',
    '消费者长时间未回复',
  ]),
  Object.freeze(['其他原因', '其它原因']),
  Object.freeze(['去核实，填写核实时间', '去核实填写核实时间', '去核实']),
  Object.freeze(['已核实，填写核实结果', '已核实填写核实结果', '已核实']),
]);

export const expandOrdinaryPddOptionAliases = (labels = []) => [...new Set(labels.flatMap((value) => {
  const label = String(value || '').trim();
  if (!label) return [];
  return ORDINARY_PDD_OPTION_GROUPS.find((group) => group.includes(label)) || [label];
}))];

const normalizeOrdinarySemanticOption = (value) => String(value || '')
  .normalize('NFKC')
  .replace(/[\s，,。；;：:、（）()【】\[\]]/gu, '')
  .trim();

const ORDINARY_PDD_SEMANTIC_INTENTS = Object.freeze([
  Object.freeze({
    id: 'intercept-completed',
    request: /^(?:快递已拦截成功|快递召回成功|包裹已成功拦截|召回任务已完成)$/u,
    visible: (text) => /(?:召回|拦截|退回|返仓)/u.test(text)
      && /(?:成功|完成|已退回|已返仓)/u.test(text)
      && !/(?:失败|无法|不能|待|等待|处理中|进行中)/u.test(text),
  }),
  Object.freeze({
    id: 'intercept-in-progress',
    request: /^(?:快递还在拦截中|快递仍在召回中|召回任务处理中|等待拦截结果)$/u,
    visible: (text) => /(?:召回|拦截)/u.test(text)
      && /(?:待|等待|处理中|进行中|尚未完成|还在|仍在)/u.test(text)
      && !/(?:失败|无法|不能|成功|已完成)/u.test(text),
  }),
  Object.freeze({
    id: 'intercept-failed',
    request: /^(?:快递拦截失败|快递召回失败|无法拦截快递|召回未成功)$/u,
    visible: (text) => /(?:召回|拦截)/u.test(text)
      && /(?:失败|无法|不能|未成功)/u.test(text)
      && !/(?:等待|处理中|进行中)/u.test(text),
  }),
  Object.freeze({
    id: 'consumer-accepts-intercept-refund',
    request: /^(?:消费者接受拦截成功后再退款|消费者同意拦截成功后退款|买家接受拦截后退款)$/u,
    visible: (text) => /(?:消费者|买家).*(?:接受|同意).*(?:召回|拦截).*(?:后|完成).*(?:退款)/u.test(text)
      && !/(?:不接受|不同意|拒绝)/u.test(text),
  }),
  Object.freeze({
    id: 'consumer-rejects-intercept-refund',
    request: /^(?:消费者不接受|消费者拒绝拦截后退款|买家不同意拦截后退款)$/u,
    visible: (text) => /(?:消费者|买家).*(?:不接受|不同意|拒绝).*(?:(?:召回|拦截).*(?:后|完成).*(?:退款))?/u.test(text),
  }),
  Object.freeze({
    id: 'consumer-no-response-timeout',
    request: /^(?:消费者超12小时未回复|消费者超过12小时未回复|买家12小时未回应|消费者长时间未回复)$/u,
    visible: (text) => /(?:消费者|买家).*(?:超过?|满|已过)?\s*12\s*(?:小时|h).*(?:未回复|未回应|无回复|无回应|没有回复|没有回应)|(?:消费者|买家).*(?:长时间|超时).*(?:未回复|未回应|无回复|无回应|没有回复|没有回应)/u.test(text),
  }),
  Object.freeze({
    id: 'recall-completed',
    request: /^(?:已进行召回|已召回|已完成召回|已拦截成功)$/u,
    visible: (text) => /(?:召回|拦截|退回)/u.test(text)
      && /(?:已|成功|完成|退回)/u.test(text)
      && !/(?:失败|无法|不能|待|等待|处理中|进行中)/u.test(text),
  }),
  Object.freeze({
    id: 'consumer-received',
    request: /^(?:消费者已收到货|消费者已收货|消费者已签收|已签收)$/u,
    visible: (text) => /(?:消费者|买家|收件人)?(?:已)?(?:收到|收货|签收)/u.test(text)
      && !/(?:未收到|没收到|未签收|拒收)/u.test(text),
  }),
  Object.freeze({
    id: 'returned-goods-not-received',
    request: /^(?:未收到退货商品|未收到退回的商品|未收到退回商品|未收到退货|未查到退货商品)$/u,
    visible: (text) => /(?:未|没|无|查无).*(?:退货|退回).*(?:商品|货物|包裹)?|(?:退货|退回).*(?:商品|货物|包裹)?.*(?:未收到|没收到|未查到)/u.test(text)
      && !/(?:已收到|已签收)/u.test(text),
  }),
  Object.freeze({
    id: 'return-tracking-found',
    request: /^(?:有退货物流轨迹|有查到物流轨迹|查到退货物流轨迹|已查到退货物流轨迹)$/u,
    visible: (text) => /(?:有|已|查到|存在).*(?:退货|退回)?(?:物流|轨迹)|(?:退货|退回).*(?:物流|轨迹).*(?:有|已|查到|存在)/u.test(text)
      && !/(?:无|未|没|查无).*(?:物流|轨迹)/u.test(text),
  }),
  Object.freeze({
    id: 'logistics-updated',
    request: /^(?:物流已更新|物流已恢复更新|物流已正常更新|物流恢复|轨迹已更新)$/u,
    visible: (text) => /(?:物流|轨迹).*(?:已更新|恢复|正常)|(?:已更新|恢复).*(?:物流|轨迹)/u.test(text)
      && !/(?:未更新|没更新|无法更新|异常)/u.test(text),
  }),
  Object.freeze({
    id: 'logistics-deliverable',
    request: /^(?:物流可以更新能送达|物流可更新能送达|物流预计可以更新能送达)$/u,
    visible: (text) => /(?:物流|轨迹).*(?:恢复|正常|可|能).*(?:送达|派送)|(?:送达|派送).*(?:正常|可以|能够)/u.test(text)
      && !/(?:无法|不能|不可|失败)/u.test(text),
  }),
  Object.freeze({
    id: 'contact-logistics',
    request: /^(?:需联系物流核实|需要联系物流核实|需要核实联系物流核实)$/u,
    visible: (text) => /(?:联系|核实).*(?:物流|快递)|(?:物流|快递).*(?:联系|核实)/u.test(text)
      && !/(?:无需|不需要|不用)/u.test(text),
  }),
  Object.freeze({
    id: 'delivery-address-and-verify',
    request: /^(?:告知送达地址并承诺核实|告知送达地址承诺核实)$/u,
    visible: (text) => /(?:送达|签收).*(?:地址|地点).*(?:核实|联系)|(?:告知|提供).*(?:地址|地点).*(?:核实|联系)/u.test(text)
      && !/(?:无需|不需要|不用)/u.test(text),
  }),
  Object.freeze({
    id: 'send-evidence',
    request: /^(?:发送凭证|发送联系凭证|向消费者发送凭证)$/u,
    visible: (text) => /(?:发送|提交|上传).*(?:凭证|证明)|(?:凭证|证明).*(?:发送|提交|上传)/u.test(text)
      && !/(?:已经发送|已发送过|发送过)/u.test(text),
  }),
  Object.freeze({
    id: 'consumer-pickup',
    request: /^(?:需要消费者自取|消费者需要自取|需消费者自取)$/u,
    visible: (text) => /(?:消费者|买家)?(?:需要|需|前往|到店|到网点)?(?:自取|自提|取件)/u.test(text)
      && !/(?:无需|不需要|不用)/u.test(text),
  }),
  Object.freeze({
    id: 'courier-contacts-consumer',
    request: /^(?:快递会联系消费者|快递联系消费者|快递将联系消费者)$/u,
    visible: (text) => /(?:快递|快递员|派件员).*(?:联系|电话).*(?:消费者|买家|收件人)?|(?:等待|保持电话).*(?:快递|派件员)/u.test(text)
      && !/(?:不会联系|无法联系|联系不上)/u.test(text),
  }),
  Object.freeze({
    id: 'send-intercept',
    request: /^(?:发送拦截|发起拦截|联系快递拦截)$/u,
    visible: (text) => /(?:发送|发起|通知|联系|申请).*(?:召回|拦截)|(?:召回|拦截).*(?:发送|发起|通知|联系|申请)/u.test(text)
      && !/(?:成功|完成|失败|无法|退款|待|等待)/u.test(text),
  }),
  Object.freeze({
    id: 'intercept-success-refund',
    request: /^(?:拦截成功同意退款|拦截成功并同意退款|已拦截成功同意退款)$/u,
    visible: (text) => /(?:召回|拦截|退回).*(?:成功|完成).*(?:同意)?退款|(?:同意)?退款.*(?:召回|拦截|退回).*(?:成功|完成)/u.test(text)
      && !/(?:失败|无法|待|等待)/u.test(text),
  }),
  Object.freeze({
    id: 'wait-intercept-refund',
    request: /^(?:待拦截快递退款|等待拦截快递退款|待快递拦截后退款)$/u,
    visible: (text) => /(?:待|等待).*(?:召回|拦截).*(?:退款)|(?:召回|拦截).*(?:后|完成后).*(?:退款)/u.test(text)
      && !/(?:已成功|已完成)/u.test(text),
  }),
  Object.freeze({
    id: 'agree-refund',
    request: /^(?:同意退款|同意消费者退款申请)$/u,
    visible: (text) => /(?:同意|直接|立即).*(?:消费者|买家)?(?:申请)?退款/u.test(text)
      && !/(?:不同意|拒绝|暂不|等待|待)/u.test(text),
  }),
  Object.freeze({
    id: 'other-reason',
    request: /^(?:其他原因|其它原因)$/u,
    visible: (text) => /^(?:其他原因|其它原因|其他情况|其它情况)$/u.test(text),
  }),
]);

const ORDINARY_PDD_JUDGMENT_FEATURES = Object.freeze([
  Object.freeze({ id: 'refund', pattern: /退款|退还款项|返还款项|款项.*(?:退回|返还)/u }),
  Object.freeze({ id: 'recall', pattern: /召回|拦截|退回包裹|包裹退回|返仓/u }),
  Object.freeze({ id: 'logistics', pattern: /物流|轨迹|快递|运单|承运商|派送/u }),
  Object.freeze({ id: 'contact', pattern: /联系|核实|电话|沟通/u }),
  Object.freeze({ id: 'evidence', pattern: /凭证|证明|截图|图片|底单|材料/u }),
  Object.freeze({ id: 'received', pattern: /收到|收货|签收|送达/u }),
  Object.freeze({ id: 'returned-goods', pattern: /(?:退货|退回).*(?:商品|货物|包裹)/u }),
  Object.freeze({ id: 'pickup', pattern: /自取|自提|取件/u }),
  Object.freeze({ id: 'deliverable', pattern: /送达|派送|可达|配送/u }),
  Object.freeze({ id: 'agree', pattern: /同意|接受|支持|准许|通过/u }),
  Object.freeze({ id: 'action', pattern: /发送|发起|通知|申请|提交|上传|反馈/u }),
  Object.freeze({ id: 'completion', pattern: /成功|完成|已经|已|恢复|正常|返仓/u }),
  Object.freeze({ id: 'waiting', pattern: /待|等待|处理中|进行中|稍后/u }),
  Object.freeze({ id: 'failure', pattern: /失败|无法|不能|不可|异常|未成功/u }),
  Object.freeze({ id: 'rejection', pattern: /拒绝|驳回|不同意|不予|暂不/u }),
  Object.freeze({ id: 'cancellation', pattern: /取消|撤销|关闭|放弃/u }),
  Object.freeze({ id: 'manual', pattern: /人工|客服处理|转交/u }),
  Object.freeze({ id: 'not-received', pattern: /未收到|没收到|未签收|拒收/u }),
]);

const ORDINARY_PDD_JUDGMENT_DOMAIN_FEATURES = new Set([
  'refund',
  'recall',
  'logistics',
  'contact',
  'evidence',
  'received',
  'returned-goods',
  'pickup',
  'deliverable',
]);

const ORDINARY_PDD_JUDGMENT_QUALIFIER_FEATURES = new Set([
  'agree',
  'action',
  'completion',
  'waiting',
  'not-received',
]);

const ordinaryPddJudgmentFeatures = (normalized) => new Set(
  ORDINARY_PDD_JUDGMENT_FEATURES
    .filter((feature) => feature.pattern.test(normalized))
    .map((feature) => feature.id),
);

const ordinaryPddJudgmentConflict = (requested, visible) => {
  for (const feature of ['failure', 'rejection', 'cancellation', 'manual']) {
    if (visible.has(feature) && !requested.has(feature)) return feature;
  }
  if (visible.has('waiting') && !requested.has('waiting')) return 'unexpected-waiting';
  if (requested.has('received') && visible.has('not-received')) return 'received-opposite';
  if (requested.has('not-received')
    && visible.has('received')
    && !visible.has('not-received')) return 'not-received-opposite';
  if (requested.has('recall')
    && requested.has('action')
    && !requested.has('completion')
    && (visible.has('completion') || visible.has('refund'))) return 'recall-stage-mismatch';
  return null;
};

export const resolveOrdinaryPddJudgmentOption = (requestedLabels = [], visibleLabels = []) => {
  const requested = expandOrdinaryPddOptionAliases(requestedLabels)
    .map((label, index) => ({
      label,
      index,
      normalized: normalizeOrdinarySemanticOption(label),
    }))
    .filter((entry) => entry.normalized)
    .map((entry) => ({
      ...entry,
      features: ordinaryPddJudgmentFeatures(entry.normalized),
      intent: ORDINARY_PDD_SEMANTIC_INTENTS.find((definition) => (
        definition.request.test(entry.normalized)
      ))?.id || 'unknown',
    }));
  const visible = [...new Set(visibleLabels.map((label) => String(label || '').trim()).filter(Boolean))]
    .map((label, index) => ({
      label,
      index,
      normalized: normalizeOrdinarySemanticOption(label),
    }))
    .filter((entry) => entry.normalized)
    .map((entry) => ({ ...entry, features: ordinaryPddJudgmentFeatures(entry.normalized) }));
  if (!requested.length || !visible.length) return null;

  const rejectedOptions = [];
  const rejectedOptionKeys = new Set();
  const scored = [];
  for (const requestedEntry of requested) {
    for (const visibleEntry of visible) {
      const conflict = ordinaryPddJudgmentConflict(
        requestedEntry.features,
        visibleEntry.features,
      );
      if (conflict) {
        const rejectionKey = `${visibleEntry.normalized}:${conflict}`;
        if (!rejectedOptionKeys.has(rejectionKey)) {
          rejectedOptionKeys.add(rejectionKey);
          rejectedOptions.push({ label: visibleEntry.label, conflict });
        }
        continue;
      }
      const domainMatches = [...requestedEntry.features].filter((feature) => (
        ORDINARY_PDD_JUDGMENT_DOMAIN_FEATURES.has(feature)
        && visibleEntry.features.has(feature)
      ));
      const qualifierMatches = [...requestedEntry.features].filter((feature) => (
        ORDINARY_PDD_JUDGMENT_QUALIFIER_FEATURES.has(feature)
        && visibleEntry.features.has(feature)
      ));
      const score = domainMatches.length * 12 + qualifierMatches.length * 4;
      if (!score) continue;
      scored.push({
        requestedEntry,
        visibleEntry,
        score,
        domainMatches,
        qualifierMatches,
      });
    }
  }

  scored.sort((left, right) => (
    right.score - left.score
    || left.requestedEntry.index - right.requestedEntry.index
    || left.visibleEntry.index - right.visibleEntry.index
  ));
  const best = scored[0];
  if (best) {
    return {
      label: best.visibleEntry.label,
      requestedLabel: best.requestedEntry.label,
      intent: best.requestedEntry.intent,
      confidence: best.domainMatches.length > 1 || best.qualifierMatches.length > 0
        ? 'medium'
        : 'low-medium',
      reason: 'deterministic-business-intent-judgment',
      score: best.score,
      matchedFeatures: [...best.domainMatches, ...best.qualifierMatches],
      representsRequestedIntent: best.domainMatches.length > 0,
      rejectedOptions,
    };
  }

  const firstNonContradictory = visible.find((visibleEntry) => (
    !ordinaryPddJudgmentConflict(requested[0].features, visibleEntry.features)
  ));
  if (!firstNonContradictory) return null;
  return {
    label: firstNonContradictory.label,
    requestedLabel: requested[0].label,
    intent: requested[0].intent,
    confidence: 'low',
    reason: 'first-visible-non-contradictory-judgment',
    score: 0,
    matchedFeatures: [],
    representsRequestedIntent: false,
    rejectedOptions,
  };
};

export const resolveOrdinaryPddSemanticOption = (requestedLabels = [], visibleLabels = []) => {
  const requested = expandOrdinaryPddOptionAliases(requestedLabels)
    .map((label) => ({ label, normalized: normalizeOrdinarySemanticOption(label) }))
    .filter((entry) => entry.normalized);
  const visible = [...new Set(visibleLabels.map((label) => String(label || '').trim()).filter(Boolean))]
    .map((label, index) => ({ label, index, normalized: normalizeOrdinarySemanticOption(label) }))
    .filter((entry) => entry.normalized);
  for (const requestedEntry of requested) {
    const exact = visible.find((entry) => entry.normalized === requestedEntry.normalized);
    if (exact) {
      return {
        label: exact.label,
        requestedLabel: requestedEntry.label,
        intent: 'normalized-exact',
        confidence: 'exact',
        reason: 'normalized-visible-option-match',
      };
    }
  }
  const requestedIntents = [];
  const seenIntentIds = new Set();
  for (const requestedEntry of requested) {
    const intent = ORDINARY_PDD_SEMANTIC_INTENTS.find((definition) => (
      definition.request.test(requestedEntry.normalized)
    ));
    if (!intent || seenIntentIds.has(intent.id)) continue;
    seenIntentIds.add(intent.id);
    requestedIntents.push({ intent, requestedEntry });
  }
  for (const { intent, requestedEntry } of requestedIntents) {
    const matches = visible.filter((entry) => intent.visible(entry.normalized));
    if (!matches.length) continue;
    const selected = matches.sort((left, right) => left.index - right.index)[0];
    return {
      label: selected.label,
      requestedLabel: requestedEntry.label,
      intent: intent.id,
      confidence: matches.length === 1 ? 'high' : 'controlled-equivalent',
      reason: matches.length === 1
        ? 'unique-visible-semantic-intent-match'
        : 'first-visible-equivalent-semantic-intent-match',
      equivalentMatches: matches.map((entry) => entry.label),
    };
  }
  return null;
};

export const ordinaryPddOptionsSemanticallyEquivalent = (requestedLabels = [], actualLabel = '') => (
  Boolean(resolveOrdinaryPddSemanticOption(requestedLabels, [actualLabel]))
);

const normalizeText = (value) => String(value ?? '')
  .normalize('NFKC')
  .replace(/\u00a0/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export const classifyOrdinaryPddMessageStage = ({
  buttonText,
  message,
  scopeText,
  hasDecisionControls = false,
} = {}) => {
  const action = normalizeText(buttonText).replace(/\s+/gu, '');
  const prefilledMessage = normalizeText(message);
  const context = normalizeText(scopeText);
  if (!prefilledMessage) return null;
  if (/^(?:发送话术|发送消息|发送回复)$/u.test(action)) return 'send-script';
  if (action !== '提交' || hasDecisionControls) return null;
  if (!/提交后[，,]?此话术将自动发送给消费者/u.test(context)) return null;
  if (!/(?:消费者咨询物流情况|催物流|催促[\s/／、]*咨询物流|担忧货物(?:无法|未能|不能)送达|确认退货快递单号(?:及快递公司)?)/u.test(context)) {
    return null;
  }
  return 'prefilled-reply-submit';
};

const uniqueSystems = (values = []) => [...new Set(values.filter(Boolean))];

const parseNowMs = (value) => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const validBeijingParts = ({ year, month, day, hour, minute, second }) => {
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23
    || minute < 0 || minute > 59 || second < 0 || second > 59) return false;
  const utcMs = Date.UTC(year, month - 1, day, hour - 8, minute, second);
  const beijing = new Date(utcMs + 8 * HOUR_MS);
  return beijing.getUTCFullYear() === year
    && beijing.getUTCMonth() === month - 1
    && beijing.getUTCDate() === day
    && beijing.getUTCHours() === hour
    && beijing.getUTCMinutes() === minute
    && beijing.getUTCSeconds() === second;
};

export const parseOrdinaryBeijingDateTime = (value) => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const text = normalizeText(value);
  if (!text) return null;

  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const explicitZoneMs = Date.parse(text);
    return Number.isFinite(explicitZoneMs) ? new Date(explicitZoneMs).toISOString() : null;
  }

  const match = text.match(
    /(20\d{2})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*(?:日)?(?:\s+|T)(\d{1,2}):(\d{2})(?::(\d{2}))?/u,
  );
  if (!match) return null;
  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
  };
  if (!validBeijingParts(parts)) return null;
  return new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour - 8,
    parts.minute,
    parts.second,
  )).toISOString();
};

const timestampMs = (value) => {
  const iso = parseOrdinaryBeijingDateTime(value);
  return iso ? Date.parse(iso) : null;
};

export const parseRemainingDurationMs = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (value && typeof value === 'object') {
    if (Number.isFinite(value.milliseconds) && value.milliseconds >= 0) return value.milliseconds;
    if (Number.isFinite(value.seconds) && value.seconds >= 0) return value.seconds * 1_000;
    if (Number.isFinite(value.minutes) && value.minutes >= 0) return value.minutes * 60_000;
    if (Number.isFinite(value.hours) && value.hours >= 0) return value.hours * HOUR_MS;
  }

  const text = normalizeText(value)
    .replace(/^(?:剩余处理时长|剩余时间|处理时限|距超时|剩余)\s*[:：]?\s*/u, '');
  if (!text || /^-/.test(text)) return null;

  const clock = text.match(/^(?:(\d+)\s*天\s*)?(\d{1,3}):(\d{2})(?::(\d{2}))?$/u);
  if (clock) {
    const days = Number(clock[1] || 0);
    const hours = Number(clock[2]);
    const minutes = Number(clock[3]);
    const seconds = Number(clock[4] || 0);
    if (minutes >= 60 || seconds >= 60) return null;
    return days * DAY_MS + hours * HOUR_MS + minutes * 60_000 + seconds * 1_000;
  }

  const units = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(天|小时|时|分钟|分|秒)/gu)];
  if (!units.length) return null;
  const residue = text.replace(/(\d+(?:\.\d+)?)\s*(天|小时|时|分钟|分|秒)/gu, '').trim();
  if (residue) return null;
  return units.reduce((total, match) => {
    const amount = Number(match[1]);
    const unit = match[2];
    if (unit === '天') return total + amount * DAY_MS;
    if (unit === '小时' || unit === '时') return total + amount * HOUR_MS;
    if (unit === '分钟' || unit === '分') return total + amount * 60_000;
    return total + amount * 1_000;
  }, 0);
};

export const extractOrdinaryListCreatedAt = (input = {}) => {
  const text = String(
    typeof input === 'string'
      ? input
      : input?.rowText ?? input?.bodyText ?? input?.text ?? '',
  );
  const match = text.match(
    /(?:工单)?创建时间\s*[:：]?\s*(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?\s+\d{1,2}:\d{2}(?::\d{2})?)/u,
  );
  return parseOrdinaryBeijingDateTime(match?.[1]);
};

const logisticsNode = (value) => {
  if (typeof value === 'string') {
    return {
      text: normalizeText(value),
      occurredAt: parseOrdinaryBeijingDateTime(value),
    };
  }
  const source = value && typeof value === 'object' ? value : {};
  return {
    text: normalizeText(
      source.text ?? source.description ?? source.content ?? source.status ?? source.nodeText,
    ),
    occurredAt: parseOrdinaryBeijingDateTime(
      source.occurredAt ?? source.time ?? source.timestamp ?? source.date ?? source.updatedAt,
    ),
    source,
  };
};

const invalidLogisticsText = /^(?:暂无|无|未查到|查无|没有)(?:有效)?(?:退货|发货)?物流(?:信息|轨迹)?$|(?:待|等待)快递公司返回物流信息|消费者已填写物流单号/u;

const normalizeTimeline = (timeline) => {
  const values = Array.isArray(timeline) ? timeline : timeline ? [timeline] : [];
  return values
    .map(logisticsNode)
    .filter((node) => node.text && !invalidLogisticsText.test(node.text));
};

const timelineTiming = (timeline) => {
  const nodes = normalizeTimeline(timeline);
  const timestamped = nodes
    .filter((node) => node.occurredAt)
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt));
  return {
    nodes,
    latestLogisticsAt: timestamped[0]?.occurredAt || null,
    earliestLogisticsAt: timestamped.at(-1)?.occurredAt || null,
  };
};

const latestTimestampedLogisticsNode = (timeline) => normalizeTimeline(timeline)
  .filter((node) => node.occurredAt)
  .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))[0] || null;

const isDeliveryBlockingLogisticsText = (value) => {
  const text = normalizeText(value);
  if (!text) return false;
  return /(?:收件|配送|派送|送达)?地址(?:不详|有误|错误|不完整|异常|无法确认)|(?:暂时|当前|仍然?|尚)?无法(?:为您)?(?:配送|派送|送达|投递)|(?:配送|派送|送达|投递)(?:失败|异常|受阻|中止|暂停)|(?:超出|不在)(?:配送|派送|服务)范围|超区|拒收|拒签|退件|退回|返件|原路返回|丢失|丢件|遗失|破损|损坏|(?:联系不上|无法联系)(?:收件人|消费者)?|(?:收件人|消费者)(?:电话)?(?:无人接听|无法接通)/u.test(text);
};

const firstLabeledDateTime = (body, labels) => {
  for (const label of labels) {
    const start = body.search(label);
    if (start < 0) continue;
    const parsed = parseOrdinaryBeijingDateTime(body.slice(start, start + 100));
    if (parsed) return parsed;
  }
  return null;
};

export const extractOrdinaryWorkOrderTiming = (input = {}) => {
  const source = typeof input === 'string' ? { bodyText: input } : (input || {});
  const body = String(source.bodyText ?? source.pageText ?? source.text ?? '');
  const timeline = source.logisticsTimeline
    ?? source.shippingLogisticsTimeline
    ?? source.returnLogisticsTimeline
    ?? [];
  const timing = timelineTiming(timeline);
  const workOrderCreatedAt = parseOrdinaryBeijingDateTime(
    source.workOrderCreatedAt ?? source.createdAt ?? source.workOrderStartedAt,
  ) || firstLabeledDateTime(body, [/(?:工单发起时间|工单创建时间|发起时间|创建时间)\s*[:：]?/u]);
  const latestLogisticsAt = parseOrdinaryBeijingDateTime(
    source.latestLogisticsAt ?? source.logisticsUpdatedAt,
  ) || timing.latestLogisticsAt;
  const earliestLogisticsAt = parseOrdinaryBeijingDateTime(
    source.earliestLogisticsAt ?? source.firstLogisticsAt,
  ) || timing.earliestLogisticsAt;
  const remainingText = source.remainingDurationMs
    ?? source.remainingDuration
    ?? source.remainingTime
    ?? source.remainingDurationText
    ?? body.match(/(?:剩余处理时长|剩余时间|距超时)\s*[:：]?\s*([^\n\r]+)/u)?.[1]
    ?? null;
  const remainingDurationMs = parseRemainingDurationMs(remainingText);
  const nowMs = parseNowMs(source.now);
  const deadlineAt = parseOrdinaryBeijingDateTime(
    source.deadlineAt ?? source.workOrderDeadlineAt,
  );
  const derivedRemaining = deadlineAt && Number.isFinite(nowMs)
    ? Math.max(0, Date.parse(deadlineAt) - nowMs)
    : null;
  return {
    workOrderCreatedAt,
    latestLogisticsAt,
    earliestLogisticsAt,
    remainingDurationMs: remainingDurationMs ?? derivedRemaining,
    deadlineAt: deadlineAt || (
      remainingDurationMs !== null && Number.isFinite(nowMs)
        ? new Date(nowMs + remainingDurationMs).toISOString()
        : null
    ),
    logisticsNodeCount: timing.nodes.length,
    timestampedLogisticsNodeCount: timing.nodes.filter((node) => node.occurredAt).length,
  };
};

export const extractDeliveryRiskServiceProgress = (input = {}) => {
  const bodyText = String(
    typeof input === 'string'
      ? input
      : input?.bodyText ?? input?.pageText ?? input?.text ?? '',
  );
  const serviceProgressIndex = bodyText.lastIndexOf('服务进度');
  const orderInformationIndex = bodyText.indexOf('订单信息', Math.max(0, serviceProgressIndex));
  const serviceProgressText = serviceProgressIndex >= 0
    ? bodyText.slice(
      serviceProgressIndex,
      orderInformationIndex > serviceProgressIndex ? orderInformationIndex : undefined,
    )
    : '';
  const completedReminderRecord = /选择核实结果\s*[:：]?\s*物流可以更新[，,]\s*能送达/u
    .test(serviceProgressText);
  const resultRequired = /已承诺联系快递核实[，,；;]?\s*请回复核实结果/u.test(bodyText);
  const finalResultRequired = /已承诺物流未更新则退款或补发[，,；;]?\s*请(?:您)?确认最终履约结果/u
    .test(bodyText)
    || /确认处理结果[\s\S]{0,120}物流已恢复更新[\s\S]{0,120}已完成退款[\s\S]{0,120}已完成补发/u
      .test(bodyText);
  if (!completedReminderRecord && !resultRequired && !finalResultRequired) {
    return {
      reminderCompleted: false,
      resultRequired: false,
      finalResultRequired: false,
      logisticsContactedAt: null,
      logisticsPromiseAt: null,
      finalResultPromptedAt: null,
    };
  }

  const dateTime = '(20\\d{2}[-/.]\\d{1,2}[-/.]\\d{1,2}\\s+\\d{1,2}:\\d{2}(?::\\d{2})?)';
  const promiseMatch = serviceProgressText.match(new RegExp(
    `轨迹更新日期\\s*[:：]?\\s*${dateTime}`,
    'u',
  ));
  const contactedMatch = serviceProgressText.match(new RegExp(
    `处理人\\s*[:：]?[\\s\\S]{0,160}?${dateTime}`,
    'u',
  ));
  return {
    reminderCompleted: completedReminderRecord,
    resultRequired,
    finalResultRequired,
    logisticsContactedAt: completedReminderRecord
      ? parseOrdinaryBeijingDateTime(contactedMatch?.[1]) : null,
    logisticsPromiseAt: completedReminderRecord
      ? parseOrdinaryBeijingDateTime(promiseMatch?.[1]) : null,
    finalResultPromptedAt: finalResultRequired
      ? parseOrdinaryBeijingDateTime(contactedMatch?.[1]) : null,
  };
};

const decision = (scenarioCode, values = {}) => {
  const nextAttemptAt = values.nextAttemptAt ?? values.retryAfterAt ?? null;
  return {
    scenarioCode,
    outcome: values.outcome ?? 'manual-review',
    actionCode: values.actionCode ?? 'manual-review',
    reasonCode: values.reasonCode ?? 'ordinary-rule-incomplete',
    reason: values.reason ?? '规则输入不完整，需要人工复核',
    requiredSystems: uniqueSystems(values.requiredSystems),
    nextAttemptAt,
    retryAfterAt: nextAttemptAt,
    pdd: values.pdd ?? null,
    external: values.external ?? null,
    evidence: values.evidence ?? {},
  };
};

const manualDecision = (scenarioCode, values = {}) => decision(scenarioCode, {
  ...values,
  outcome: 'manual-review',
  actionCode: 'manual-review',
});

const waitDecision = (scenarioCode, values = {}) => decision(scenarioCode, {
  ...values,
  outcome: 'wait',
  actionCode: 'wait',
});

const uploadFailed = (facts = {}) => facts.pddEvidenceUploadFailed === true
  || facts.evidenceUploadStatus === 'failed'
  || facts.uploadStatus === 'failed';

export const resolveWarehouseContactChannel = (input = {}) => {
  const source = typeof input === 'string' ? { warehouse: input } : (input || {});
  const warehouse = normalizeText(source.warehouse ?? source.warehouseName);
  const carrier = normalizeText(source.carrier ?? source.expressCompany);
  const combined = `${warehouse} ${carrier}`;
  if (!warehouse) {
    return {
      warehouse: null,
      carrier: carrier || null,
      channel: 'unknown',
      automationSupported: false,
      requiresOmsLookup: true,
      reasonCode: 'warehouse-not-resolved',
    };
  }
  return {
    warehouse,
    carrier: carrier || null,
    channel: 'tms-public-flow',
    primarySystem: 'TMS',
    automationSupported: true,
    requiresOmsLookup: false,
    reasonCode: 'tms-public-logistics-contact',
    sourceDescription: combined,
  };
};

const logisticsEvidence = (timing, extra = {}) => ({
  logistics: {
    latestLogisticsAt: timing.latestLogisticsAt,
    earliestLogisticsAt: timing.earliestLogisticsAt,
    workOrderCreatedAt: timing.workOrderCreatedAt,
    nodeCount: timing.logisticsNodeCount,
  },
  ...extra,
});

const deliveryReminderPddAction = () => ({
  option: '需联系物流核实',
  optionAliases: ['需要联系物流核实', '需要核实联系物流核实'],
  resultOption: '物流可以更新，能送达',
  resultRequiredAfterPrimary: true,
  trajectoryUpdateDateOffsetDays: 2,
  unupdatedPromiseOption: '未更新则补发或者退款',
  unupdatedPromiseOptionAliases: [
    '物流未更新则补发或者退款',
    '未更新则补发或退款',
    '物流未更新则补发或退款',
    '未更新则退款或者补发',
    '物流未更新则退款或者补发',
  ],
  unupdatedPromiseMatchAll: ['补发', '退款'],
});

const deliveryReminderEvidence = (timing, extra = {}) => logisticsEvidence(timing, {
  ...extra,
  required: [{
    source: 'tms-reminder-evidence',
    required: true,
    mustInclude: ['order-number', 'tracking-number', 'reminder-request'],
  }],
});

const pddComplete = (scenarioCode, values = {}) => decision(scenarioCode, {
  ...values,
  outcome: 'auto-submit',
  actionCode: 'pdd-complete',
  requiredSystems: uniqueSystems(['PDD', ...(values.requiredSystems || [])]),
});

const pddStageSubmit = (scenarioCode, values = {}) => decision(scenarioCode, {
  ...values,
  outcome: 'auto-submit',
  actionCode: 'pdd-stage-submit',
  requiredSystems: uniqueSystems(['PDD', ...(values.requiredSystems || [])]),
});

const resolveNow = (now) => {
  const nowMs = parseNowMs(now);
  if (!Number.isFinite(nowMs)) throw new TypeError('options.now must be a valid timestamp');
  return nowMs;
};

const reissueDecision = (facts, { nowMs, timing, reasonCode }) => {
  const scenarioCode = ORDINARY_SCENARIO_CODES.DELIVERY_RISK_CONCERN;
  const channel = resolveWarehouseContactChannel(facts);
  if (channel.requiresOmsLookup) {
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'oms-warehouse-query',
      reasonCode: 'reissue-requires-warehouse',
      reason: '补发前需要按订单号或运单号在 OMS 查询发货仓库',
      requiredSystems: ['OMS'],
      external: { action: 'query-shipping-warehouse', system: 'OMS' },
      evidence: logisticsEvidence(timing),
    });
  }
  const trackingNumber = normalizeText(
    facts.reissueTrackingNumber ?? facts.replacementTrackingNumber,
  );
  if (trackingNumber) {
    return pddComplete(scenarioCode, {
      reasonCode: 'reissue-tracking-ready',
      reason: '补发单号已生成，可以在拼多多完成补发反馈',
      requiredSystems: ['OMS', 'TMS'],
      pdd: {
        option: '立即补发',
        completionOption: '已补发',
        reissueTrackingNumber: trackingNumber,
        customerMessage: `亲亲，您的物流已超时未更新，为了不耽误您的更多时间，我们已记丢件，为您重新安排补发，带来不便请谅解。补发单号为${trackingNumber}`,
        customerMessageOptional: true,
      },
      evidence: logisticsEvidence(timing, { reissueTrackingNumber: trackingNumber }),
    });
  }

  const reissueCreatedAt = parseOrdinaryBeijingDateTime(
    facts.reissueCreatedAt ?? facts.replacementOrderCreatedAt,
  );
  const reissueCreated = facts.reissueOrderCreated === true
    || facts.replacementOrderCreated === true
    || Boolean(reissueCreatedAt);
  if (!reissueCreated) {
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'tms-lost-and-oms-reissue',
      reasonCode,
      reason: '物流已达到补发条件，需要快递记丢件、OMS 创建补发单并手工配货',
      requiredSystems: ['TMS', 'OMS'],
      external: {
        action: 'mark-lost-create-and-allocate-reissue',
        contactChannel: channel,
        prioritizeWarehouseTracking: true,
      },
      pdd: { pendingOption: '立即补发' },
      evidence: logisticsEvidence(timing),
    });
  }

  const createdAtMs = timestampMs(reissueCreatedAt);
  if (!Number.isFinite(createdAtMs)) {
    const firstObservedAtMs = timestampMs(
      facts.workOrderFirstDiscoveredAt ?? facts.firstDiscoveredAt ?? facts.discoveredAt,
    );
    if (Number.isFinite(firstObservedAtMs)
      && nowMs < firstObservedAtMs + REISSUE_TRACKING_WAIT_MS) {
      return waitDecision(scenarioCode, {
        reasonCode: 'reissue-created-time-missing-lower-bound-wait',
        reason: 'OMS 已创建补发单但创建时间不可读，按工单首次发现时间下界等待后再查单号',
        requiredSystems: ['OMS'],
        nextAttemptAt: new Date(firstObservedAtMs + REISSUE_TRACKING_WAIT_MS).toISOString(),
        external: { action: 'wait-reissue-tracking-number', system: 'OMS' },
        evidence: logisticsEvidence(timing, {
          workOrderFirstDiscoveredAt: new Date(firstObservedAtMs).toISOString(),
          reissueCreatedTimeStrategy: 'first-observed-lower-bound',
        }),
      });
    }
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'oms-reissue-tracking-check',
      reasonCode: 'reissue-created-time-missing-query-now',
      reason: 'OMS 已创建补发单但创建时间不可读，直接查询补发单号，避免流程停滞',
      requiredSystems: ['OMS'],
      external: { action: 'query-reissue-tracking-number', system: 'OMS' },
      evidence: logisticsEvidence(timing, {
        workOrderFirstDiscoveredAt: Number.isFinite(firstObservedAtMs)
          ? new Date(firstObservedAtMs).toISOString()
          : null,
        reissueCreatedTimeStrategy: 'missing-created-time-query-is-read-only',
      }),
    });
  }
  const trackingCheckAtMs = createdAtMs + REISSUE_TRACKING_WAIT_MS;
  if (nowMs < trackingCheckAtMs) {
    return waitDecision(scenarioCode, {
      reasonCode: 'reissue-tracking-within-three-hour-wait',
      reason: '补发单已创建，等待 OMS 生成补发单号',
      requiredSystems: ['OMS'],
      nextAttemptAt: new Date(trackingCheckAtMs).toISOString(),
      external: { action: 'wait-reissue-tracking-number', system: 'OMS' },
      evidence: logisticsEvidence(timing, { reissueCreatedAt }),
    });
  }
  if (facts.reissueTrackingLookupCompleted === true) {
    if (timing.remainingDurationMs !== null && timing.remainingDurationMs <= 2 * HOUR_MS) {
      return manualDecision(scenarioCode, {
        reasonCode: 'reissue-tracking-missing-near-deadline',
        reason: '补发单已重复复查但仍无单号，且拼多多剩余处理时间不足两小时',
        requiredSystems: ['OMS'],
        evidence: logisticsEvidence(timing, {
          reissueCreatedAt,
          reissueTrackingCheckedAt: facts.reissueTrackingCheckedAt ?? null,
        }),
      });
    }
    const checkedAtMs = timestampMs(facts.reissueTrackingCheckedAt);
    const regularRecheckAtMs = Number.isFinite(checkedAtMs)
      ? checkedAtMs + REISSUE_TRACKING_RECHECK_MS
      : nowMs;
    const deadlineRecheckAtMs = timing.remainingDurationMs === null
      ? regularRecheckAtMs
      : nowMs + Math.max(60_000, timing.remainingDurationMs - 2 * HOUR_MS);
    const recheckAtMs = Math.min(regularRecheckAtMs, deadlineRecheckAtMs);
    if (nowMs < recheckAtMs) {
      return waitDecision(scenarioCode, {
        reasonCode: 'reissue-tracking-recheck-waiting',
        reason: 'OMS 首次复查尚无补发单号，等待后再次只读查询，不立即转人工',
        requiredSystems: ['OMS'],
        nextAttemptAt: new Date(recheckAtMs).toISOString(),
        external: { action: 'wait-reissue-tracking-number', system: 'OMS' },
        evidence: logisticsEvidence(timing, {
          reissueCreatedAt,
          reissueTrackingCheckedAt: facts.reissueTrackingCheckedAt ?? null,
        }),
      });
    }
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'oms-reissue-tracking-check',
      reasonCode: 'reissue-tracking-recheck-due',
      reason: 'OMS 补发单仍无单号，已到下一次只读复查时间',
      requiredSystems: ['OMS'],
      external: { action: 'query-reissue-tracking-number', system: 'OMS' },
      evidence: logisticsEvidence(timing, {
        reissueCreatedAt,
        reissueTrackingCheckedAt: facts.reissueTrackingCheckedAt ?? null,
      }),
    });
  }
  return decision(scenarioCode, {
    outcome: 'external-action',
    actionCode: 'oms-reissue-tracking-check',
    reasonCode: 'reissue-tracking-check-due',
    reason: '补发单创建已满三小时，需要在 OMS 查询补发单号',
    requiredSystems: ['OMS'],
    external: { action: 'query-reissue-tracking-number', system: 'OMS' },
    evidence: logisticsEvidence(timing, { reissueCreatedAt }),
  });
};

const deliveryReminderFollowUpDecision = (facts, {
  nowMs,
  timing,
  contactedAt,
} = {}) => {
  const scenarioCode = ORDINARY_SCENARIO_CODES.DELIVERY_RISK_CONCERN;
  const promisedAt = parseOrdinaryBeijingDateTime(
    facts.logisticsPromiseAt ?? facts.trajectoryUpdateAt ?? facts.promisedLogisticsUpdateAt,
  );
  const promisedAtMs = timestampMs(promisedAt);
  const followUpAtMs = Number.isFinite(promisedAtMs)
    ? promisedAtMs
    : Date.parse(contactedAt) + 2 * DAY_MS;
  if (nowMs < followUpAtMs) {
    return waitDecision(scenarioCode, {
      reasonCode: 'first-logistics-reminder-follow-up-pending',
      reason: '已完成首次快递催件，等待两天后复查物流',
      nextAttemptAt: new Date(followUpAtMs).toISOString(),
      requiredSystems: ['PDD'],
      evidence: logisticsEvidence(timing, {
        logisticsContactedAt: contactedAt,
        logisticsPromiseAt: promisedAt,
      }),
    });
  }
  if (timing.remainingDurationMs === null) {
    return decision(scenarioCode, {
      outcome: 'auto-submit',
      actionCode: 'pdd-reminder-extension',
      reasonCode: 'second-logistics-reminder-with-unreadable-deadline',
      reason: '两天复查时页面倒计时不可读，保守重复催件并顺延复查，不猜测退款或补发结果',
      requiredSystems: ['PDD'],
      external: {
        action: 'reuse-existing-logistics-reminder',
        createTms: false,
      },
      pdd: deliveryReminderPddAction(),
      evidence: deliveryReminderEvidence(timing, {
        logisticsContactedAt: contactedAt,
        deadlineSelectionStrategy: 'unreadable-deadline-repeat-reminder',
      }),
    });
  }
  if (timing.remainingDurationMs < DAY_MS) {
    return reissueDecision(facts, {
      nowMs,
      timing,
      reasonCode: 'two-day-follow-up-stale-with-under-24-hours-remaining',
    });
  }

  return decision(scenarioCode, {
    outcome: 'auto-submit',
    actionCode: 'pdd-reminder-extension',
    reasonCode: 'second-logistics-reminder-required',
    reason: '两天复查后物流仍未更新且剩余时长不少于 24 小时，只重复提交拼多多并顺延两天',
    requiredSystems: ['PDD'],
    external: {
      action: 'reuse-existing-logistics-reminder',
      createTms: false,
    },
    pdd: deliveryReminderPddAction(),
    evidence: deliveryReminderEvidence(timing, {
      logisticsContactedAt: contactedAt,
      remainingDurationMs: timing.remainingDurationMs,
    }),
  });
};

export const evaluateDeliveryRiskConcern = (facts = {}, { now } = {}) => {
  const scenarioCode = ORDINARY_SCENARIO_CODES.DELIVERY_RISK_CONCERN;
  const nowMs = resolveNow(now);
  const timeline = facts.shippingLogisticsTimeline ?? facts.logisticsTimeline ?? [];
  const timing = extractOrdinaryWorkOrderTiming({ ...facts, logisticsTimeline: timeline, now: nowMs });
  const latestMs = timestampMs(timing.latestLogisticsAt);
  let createdMs = timestampMs(timing.workOrderCreatedAt);
  let workOrderAgeSource = 'platform-created-at';
  const firstObservedAtMs = timestampMs(
    facts.workOrderFirstDiscoveredAt ?? facts.firstDiscoveredAt ?? facts.discoveredAt,
  );
  if ((!Number.isFinite(createdMs) || createdMs > nowMs + 5 * 60_000)
    && Number.isFinite(firstObservedAtMs)
    && firstObservedAtMs <= nowMs + 5 * 60_000) {
    createdMs = firstObservedAtMs;
    workOrderAgeSource = 'first-observed-lower-bound';
  }
  const contactedAt = parseOrdinaryBeijingDateTime(
    facts.logisticsContactedAt ?? facts.firstReminderAt,
  );
  const contactedAtMs = timestampMs(contactedAt);
  const logisticsUpdateRejection = facts.platformLogisticsUpdateRejection || {};
  const rejectedOption = normalizeText(logisticsUpdateRejection.option);
  const rejectedMessage = normalizeText(logisticsUpdateRejection.errorMessage);
  const rejectedLogisticsUpdateOption = /^(?:物流已更新|物流已恢复更新|物流已正常更新|物流恢复|轨迹已更新)$/u
    .test(rejectedOption);
  const platformRequiresConsumerConfirmation = (
    Number(logisticsUpdateRejection.errorCode) === 190001
    && /物流状态异常[，,；;]?\s*请先(?:和|与)?消费者确认/u.test(rejectedMessage)
    && rejectedLogisticsUpdateOption
  );
  const rejectedLatestMs = timestampMs(logisticsUpdateRejection.latestLogisticsAt);
  const rejectedAtMs = timestampMs(logisticsUpdateRejection.rejectedAt);
  const rejectionBoundaryMs = Number.isFinite(rejectedLatestMs)
    ? rejectedLatestMs
    : rejectedAtMs;
  const platformRejectedCurrentLogisticsUpdate = (
    !platformRequiresConsumerConfirmation
    && (Number(logisticsUpdateRejection.errorCode) === 190001
      || /物流轨迹未更新[，,]请如实填写/u.test(normalizeText(
        logisticsUpdateRejection.errorMessage,
      )))
    && rejectedLogisticsUpdateOption
    && (!Number.isFinite(rejectionBoundaryMs)
      || !Number.isFinite(latestMs)
      || latestMs <= rejectionBoundaryMs)
  );

  const requiresNegotiatedRefund = facts.requiresUnableToDeliverNegotiation === true
    || facts.deliveryExceptionLikelyUnable === true
    || facts.logisticsCannotDeliver === true
    || facts.deliveryRiskDecision === 'negotiate-refund'
    || normalizeText(facts.recommendedOption) === '有异常可能无法送达-协商退款';
  if (requiresNegotiatedRefund) {
    return manualDecision(scenarioCode, {
      reasonCode: 'delivery-exception-refund-negotiation-required',
      reason: '物流事实要求选择“有异常可能无法送达-协商退款”，必须转人工与消费者协商',
      requiredSystems: ['PDD'],
      pdd: { pendingOption: '有异常可能无法送达-协商退款' },
      evidence: logisticsEvidence(timing),
    });
  }

  if (platformRequiresConsumerConfirmation) {
    return manualDecision(scenarioCode, {
      reasonCode: 'delivery-risk-consumer-confirmation-required',
      reason: '拼多多明确提示当前物流状态异常并要求先与消费者确认，未取得消费者同意前禁止自动提交履约结果',
      requiredSystems: ['PDD'],
      evidence: logisticsEvidence(timing, {
        platformLogisticsUpdateRejection: {
          errorCode: Number(logisticsUpdateRejection.errorCode) || null,
          errorMessage: rejectedMessage || null,
          option: rejectedOption || null,
          rejectedAt: logisticsUpdateRejection.rejectedAt || null,
          latestLogisticsAt: logisticsUpdateRejection.latestLogisticsAt || null,
        },
      }),
    });
  }

  const finalResultRequired = facts.deliveryRiskFinalResultRequired === true
    || /已承诺物流未更新则退款或补发[，,；;]?\s*请(?:您)?确认最终履约结果/u.test(normalizeText(
      facts.pageText ?? facts.bodyText,
    ));
  if (finalResultRequired) {
    const finalPromptedAt = parseOrdinaryBeijingDateTime(
      facts.deliveryRiskFinalResultPromptedAt ?? facts.finalResultPromptedAt,
    );
    const finalPromptedAtMs = timestampMs(finalPromptedAt);
    if (facts.refundCompleted === true || facts.deliveryRiskRefundCompleted === true) {
      return pddComplete(scenarioCode, {
        reasonCode: 'delivery-risk-final-refund-confirmed',
        reason: '平台进入最终履约确认阶段，退款事实已确认',
        pdd: { option: '已完成退款' },
        evidence: logisticsEvidence(timing),
      });
    }
    if (facts.reissueCompleted === true
      || facts.reissueOrderCreated === true
      || normalizeText(facts.reissueTrackingNumber ?? facts.replacementTrackingNumber)) {
      return pddComplete(scenarioCode, {
        reasonCode: 'delivery-risk-final-reissue-confirmed',
        reason: '平台进入最终履约确认阶段，补发事实已确认',
        pdd: { option: '已完成补发' },
        evidence: logisticsEvidence(timing),
      });
    }
    const latestNode = latestTimestampedLogisticsNode(timeline);
    if (Number.isFinite(latestMs)
      && Number.isFinite(finalPromptedAtMs)
      && latestMs > finalPromptedAtMs
      && isDeliveryBlockingLogisticsText(latestNode?.text)) {
      return manualDecision(scenarioCode, {
        reasonCode: 'delivery-risk-consumer-confirmation-required',
        reason: '平台最终履约提示后的最新物流轨迹仍是配送阻断状态，必须先与消费者确认，不能误报物流已恢复',
        requiredSystems: ['PDD'],
        evidence: logisticsEvidence(timing, {
          finalResultPromptedAt: finalPromptedAt,
          latestLogisticsText: latestNode?.text || null,
        }),
      });
    }
    if (Number.isFinite(latestMs)
      && Number.isFinite(finalPromptedAtMs)
      && latestMs > finalPromptedAtMs) {
      return pddComplete(scenarioCode, {
        reasonCode: 'delivery-risk-final-logistics-update-confirmed',
        reason: '平台最终履约提示后出现了新的物流轨迹',
        pdd: { option: '物流已恢复更新' },
        evidence: logisticsEvidence(timing, { finalResultPromptedAt: finalPromptedAt }),
      });
    }
    if (timing.remainingDurationMs !== null && timing.remainingDurationMs <= 2 * HOUR_MS) {
      return manualDecision(scenarioCode, {
        reasonCode: 'delivery-risk-final-result-near-deadline',
        reason: '最终履约确认距超时不足两小时，仍未发现物流更新、退款或补发事实',
        requiredSystems: ['PDD'],
        evidence: logisticsEvidence(timing, { finalResultPromptedAt: finalPromptedAt }),
      });
    }
    const retryDelayMs = 30 * 60_000;
    const retryAtMs = timing.remainingDurationMs === null
      ? nowMs + retryDelayMs
      : Math.min(
        nowMs + retryDelayMs,
        nowMs + Math.max(60_000, timing.remainingDurationMs - 2 * HOUR_MS),
      );
    return waitDecision(scenarioCode, {
      reasonCode: 'delivery-risk-final-result-awaiting-facts',
      reason: '等待最终履约阶段出现新的物流轨迹、退款或补发事实',
      requiredSystems: ['PDD'],
      nextAttemptAt: new Date(retryAtMs).toISOString(),
      evidence: logisticsEvidence(timing, { finalResultPromptedAt: finalPromptedAt }),
    });
  }

  const reminderResultRequired = facts.deliveryRiskReminderResultRequired === true
    || /已承诺联系快递核实[，,；;]?\s*请回复核实结果/u.test(normalizeText(
      facts.pageText ?? facts.bodyText,
    ));
  if (reminderResultRequired) {
    const channel = resolveWarehouseContactChannel(facts);
    if (channel.requiresOmsLookup) {
      return decision(scenarioCode, {
        outcome: 'external-action',
        actionCode: 'oms-warehouse-query',
        reasonCode: 'platform-reminder-result-requires-warehouse',
        reason: '平台已进入催件核实结果阶段，回复前需要在 OMS 确认发货仓库',
        requiredSystems: ['OMS'],
        external: { action: 'query-shipping-warehouse', system: 'OMS' },
        evidence: logisticsEvidence(timing),
      });
    }
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'tms-reminder',
      reasonCode: 'platform-reminder-result-requires-tms-confirmation',
      reason: '平台已进入催件核实结果阶段，需要先在 TMS 留存真实催件记录再回复',
      requiredSystems: ['OMS', 'TMS', 'PDD'],
      external: { action: 'contact-logistics', channel },
      pdd: deliveryReminderPddAction(),
      evidence: deliveryReminderEvidence(timing),
    });
  }

  if (platformRejectedCurrentLogisticsUpdate) {
    const channel = resolveWarehouseContactChannel(facts);
    const rejectionEvidence = {
      platformLogisticsUpdateRejection: {
        errorCode: Number(logisticsUpdateRejection.errorCode) || null,
        errorMessage: normalizeText(logisticsUpdateRejection.errorMessage) || null,
        option: rejectedOption,
        rejectedAt: logisticsUpdateRejection.rejectedAt || null,
        latestLogisticsAt: logisticsUpdateRejection.latestLogisticsAt || null,
      },
    };
    if (channel.requiresOmsLookup) {
      return decision(scenarioCode, {
        outcome: 'external-action',
        actionCode: 'oms-warehouse-query',
        reasonCode: 'platform-rejected-logistics-update-requires-warehouse',
        reason: '拼多多明确否定当前物流更新事实，催件前需要在 OMS 确认发货仓库',
        requiredSystems: ['OMS'],
        external: { action: 'query-shipping-warehouse', system: 'OMS' },
        evidence: logisticsEvidence(timing, rejectionEvidence),
      });
    }
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'tms-reminder',
      reasonCode: 'platform-rejected-logistics-update-requires-reminder',
      reason: '拼多多明确提示物流轨迹未更新，改走 TMS 催件并按页面真实选项反馈',
      requiredSystems: ['OMS', 'TMS', 'PDD'],
      external: { action: 'contact-logistics', channel },
      pdd: deliveryReminderPddAction(),
      evidence: deliveryReminderEvidence(timing, rejectionEvidence),
    });
  }

  if (!Number.isFinite(latestMs)) {
    if (timing.logisticsNodeCount) {
      const channel = resolveWarehouseContactChannel(facts);
      if (channel.requiresOmsLookup) {
        return decision(scenarioCode, {
          outcome: 'external-action',
          actionCode: 'oms-warehouse-query',
          reasonCode: 'shipping-logistics-time-missing-requires-warehouse',
          reason: '存在物流轨迹但节点时间不可读，先查询发货仓库再按保守催件流程处理',
          requiredSystems: ['OMS'],
          external: { action: 'query-shipping-warehouse', system: 'OMS' },
          evidence: logisticsEvidence(timing, {
            timeSelectionStrategy: 'missing-node-time-conservative-reminder',
          }),
        });
      }
      return decision(scenarioCode, {
        outcome: 'external-action',
        actionCode: 'tms-reminder',
        reasonCode: 'shipping-logistics-time-missing-conservative-reminder',
        reason: '存在物流轨迹但节点时间不可读，按保守催件流程核实并继续处理',
        requiredSystems: ['OMS', 'TMS', 'PDD'],
        external: { action: 'contact-logistics', channel },
        pdd: deliveryReminderPddAction(),
        evidence: deliveryReminderEvidence(timing, {
          timeSelectionStrategy: 'missing-node-time-conservative-reminder',
        }),
      });
    }
    if (!Number.isFinite(createdMs)) {
      return manualDecision(scenarioCode, {
        reasonCode: 'work-order-created-time-missing-without-logistics',
        reason: '没有发货物流轨迹且缺少工单发起时间，无法执行等待和超时规则',
        requiredSystems: ['PDD'],
        evidence: logisticsEvidence(timing, { workOrderAgeSource }),
      });
    }
    if (createdMs > nowMs + 5 * 60_000) {
      return manualDecision(scenarioCode, {
        reasonCode: 'work-order-created-time-in-future',
        reason: '工单发起时间晚于当前时间，不能据此执行物流等待规则',
        requiredSystems: ['PDD'],
        evidence: logisticsEvidence(timing, { workOrderAgeSource }),
      });
    }
    if (contactedAt) {
      return deliveryReminderFollowUpDecision(facts, { nowMs, timing, contactedAt });
    }
    const workOrderAgeMs = Math.max(0, nowMs - createdMs);
    if (workOrderAgeMs <= DAY_MS) {
      return waitDecision(scenarioCode, {
        reasonCode: 'no-shipping-logistics-within-24-hours-of-work-order',
        reason: '暂无发货物流轨迹，工单发起尚未超过 24 小时，等待后续扫描',
        requiredSystems: ['PDD'],
        nextAttemptAt: new Date(Math.max(nowMs + 60_000, createdMs + DAY_MS + 1_000)).toISOString(),
        evidence: logisticsEvidence(timing, {
          workOrderAgeHours: workOrderAgeMs / HOUR_MS,
          workOrderAgeSource,
        }),
      });
    }
    if (workOrderAgeMs > 2 * DAY_MS) {
      return reissueDecision(facts, {
        nowMs,
        timing,
        reasonCode: 'no-shipping-logistics-over-48-hours',
      });
    }

    const channel = resolveWarehouseContactChannel(facts);
    if (channel.requiresOmsLookup) {
      return decision(scenarioCode, {
        outcome: 'external-action',
        actionCode: 'oms-warehouse-query',
        reasonCode: 'no-logistics-reminder-requires-warehouse',
        reason: '暂无物流且工单已超过 24 小时，催件前需要在 OMS 查询发货仓库',
        requiredSystems: ['OMS'],
        external: { action: 'query-shipping-warehouse', system: 'OMS' },
        evidence: logisticsEvidence(timing, { workOrderAgeHours: workOrderAgeMs / HOUR_MS }),
      });
    }
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'tms-reminder',
      reasonCode: 'no-shipping-logistics-between-24-and-48-hours',
      reason: '暂无物流且工单已超过 24 小时但未超过 48 小时，需要走 TMS 公共催件链路',
      requiredSystems: ['OMS', 'TMS', 'PDD'],
      external: { action: 'contact-logistics', channel },
      pdd: deliveryReminderPddAction(),
      evidence: deliveryReminderEvidence(timing, { workOrderAgeHours: workOrderAgeMs / HOUR_MS }),
    });
  }
  if (latestMs > nowMs + 5 * 60_000) {
    const channel = resolveWarehouseContactChannel(facts);
    if (channel.requiresOmsLookup) {
      return decision(scenarioCode, {
        outcome: 'external-action',
        actionCode: 'oms-warehouse-query',
        reasonCode: 'future-shipping-time-requires-warehouse',
        reason: '最新物流时间异常晚于当前时间，先查询发货仓库再按保守催件流程处理',
        requiredSystems: ['OMS'],
        external: { action: 'query-shipping-warehouse', system: 'OMS' },
        evidence: logisticsEvidence(timing, {
          timeSelectionStrategy: 'future-node-time-conservative-reminder',
        }),
      });
    }
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'tms-reminder',
      reasonCode: 'future-shipping-time-conservative-reminder',
      reason: '最新物流时间异常晚于当前时间，按保守催件流程核实并继续处理',
      requiredSystems: ['OMS', 'TMS', 'PDD'],
      external: { action: 'contact-logistics', channel },
      pdd: deliveryReminderPddAction(),
      evidence: deliveryReminderEvidence(timing, {
        timeSelectionStrategy: 'future-node-time-conservative-reminder',
      }),
    });
  }

  const ageMs = Math.max(0, nowMs - latestMs);
  if (Number.isFinite(contactedAtMs) && latestMs > contactedAtMs) {
    return pddComplete(scenarioCode, {
      reasonCode: 'logistics-updated-after-reminder',
      reason: '首次催件后已经产生新的物流节点',
      pdd: { option: '物流已正常更新' },
      evidence: logisticsEvidence(timing, {
        logisticsAgeHours: ageMs / HOUR_MS,
        logisticsContactedAt: contactedAt,
      }),
    });
  }
  if (contactedAt) {
    return deliveryReminderFollowUpDecision(facts, { nowMs, timing, contactedAt });
  }
  const updatedWithin24Hours = ageMs <= DAY_MS;
  const updatedAfterWorkOrderCreated = Number.isFinite(createdMs) && latestMs > createdMs;
  if (updatedWithin24Hours || updatedAfterWorkOrderCreated) {
    return pddComplete(scenarioCode, {
      reasonCode: updatedAfterWorkOrderCreated
        ? 'logistics-updated-after-work-order-created'
        : 'logistics-updated-within-24-hours',
      reason: updatedAfterWorkOrderCreated
        ? '最新物流节点晚于工单发起时间'
        : '最新物流节点在 24 小时内',
      pdd: { option: '物流已更新' },
      evidence: logisticsEvidence(timing, {
        logisticsAgeHours: ageMs / HOUR_MS,
        updatedAfterWorkOrderCreated,
      }),
    });
  }

  if (ageMs > 2 * DAY_MS) {
    return reissueDecision(facts, {
      nowMs,
      timing,
      reasonCode: 'shipping-logistics-stale-over-48-hours',
    });
  }

  const channel = resolveWarehouseContactChannel(facts);
  if (channel.requiresOmsLookup) {
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'oms-warehouse-query',
      reasonCode: 'first-reminder-requires-warehouse',
      reason: '首次催件前需要在 OMS 查询发货仓库和快递公司',
      requiredSystems: ['OMS'],
      external: { action: 'query-shipping-warehouse', system: 'OMS' },
      evidence: logisticsEvidence(timing, { logisticsAgeHours: ageMs / HOUR_MS }),
    });
  }
  return decision(scenarioCode, {
    outcome: 'external-action',
    actionCode: 'tms-reminder',
    reasonCode: 'shipping-logistics-stale-between-24-and-48-hours',
    reason: '物流超过 24 小时但未超过 48 小时，需要先联系快递核实并延后两天复查',
    requiredSystems: ['OMS', 'TMS', 'PDD'],
    external: { action: 'contact-logistics', channel },
    pdd: deliveryReminderPddAction(),
    evidence: deliveryReminderEvidence(timing, { logisticsAgeHours: ageMs / HOUR_MS }),
  });
};

const nodeDetection = (timeline, { positive, negative }) => {
  const nodes = normalizeTimeline(timeline);
  const matchedNode = nodes.find((node) => positive.test(node.text) && !negative.test(node.text)) || null;
  return {
    matched: Boolean(matchedNode),
    matchedNode: matchedNode ? { text: matchedNode.text, occurredAt: matchedNode.occurredAt } : null,
    validNodeCount: nodes.length,
  };
};

export const detectSignedLogistics = (timeline) => {
  const result = nodeDetection(timeline, {
    positive: /已签收|签收成功|(?:本人|他人|门卫|驿站|快递柜).{0,8}签收|已妥投|妥投成功|代收成功/u,
    negative: /未签收|尚未签收|等待签收|待签收|签收失败/u,
  });
  return {
    status: result.matched ? 'signed' : result.validNodeCount ? 'unsigned' : 'unknown',
    ...result,
  };
};

export const detectPickedUpLogistics = (timeline) => {
  const result = nodeDetection(timeline, {
    positive: /已揽收|已揽件|揽收成功|揽件成功|快递员已取件|快递公司已收取/u,
    negative: /未揽收|尚未揽收|等待揽收|待揽收|正在揽收|揽收失败|商家已发货/u,
  });
  return {
    status: result.matched ? 'picked-up' : result.validNodeCount ? 'not-picked-up' : 'unknown',
    ...result,
  };
};

const signedDeliveryPattern = /已签收|签收成功|已妥投|妥投成功|代收成功|送货上门签收/u;
const deliveryStationPattern = /驿站|代收点|菜鸟|快递柜|丰巢|小区店|便利店|超市|服务点|代理点|寄存点|自提点|门店/u;
const doorstepDeliveryPattern = /送货上门|家门口|门口|本人签收|已签收[，,]?\s*本人|送货到家|送到家|入户/u;

const latestTimelineNode = (timeline) => normalizeTimeline(timeline)
  .map((node, index) => ({ ...node, index }))
  .sort((left, right) => {
    const leftTime = Date.parse(left.occurredAt || '');
    const rightTime = Date.parse(right.occurredAt || '');
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime;
    if (Number.isFinite(leftTime)) return -1;
    if (Number.isFinite(rightTime)) return 1;
    return right.index - left.index;
  });

const traceWithoutTimestamp = (value) => normalizeText(value)
  .replace(/(?:^|\s)20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/u, '')
  .trim();

const deliveryPhoneFromTrace = (text) => {
  // Carrier traces often include the courier, pickup point, depot and
  // complaint numbers in the same sentence. Prefer the number scoped to the
  // courier label instead of rejecting the whole trace as ambiguous.
  for (const match of text.matchAll(/(?:快递(?:小哥|员|师傅)|派件员|配送员|业务员)/gu)) {
    const tail = text.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 64);
    const competingLabel = tail.search(/(?:自提点|代收点|驿站|揽投部|网点|投诉|客服|官方|服务热线)/u);
    const courierScope = competingLabel >= 0 ? tail.slice(0, competingLabel) : tail;
    const courierPhone = courierScope.match(/(?<!\d)(1[3-9](?:[\s-]?\d){9})(?!\d)/u)?.[1];
    if (courierPhone) return courierPhone.replace(/[\s-]/gu, '');
  }

  const labeled = text.match(
    /(?:如有(?:问题|疑问)(?:可)?(?:致电|联系)|快递(?:小哥|员|师傅)(?:电话|手机号)?|派件员(?:电话|手机号)?|配送员(?:电话|手机号)?|业务员(?:电话|手机号)?|派送电话|联系电话)\s*[：:]?\s*(1[3-9](?:[\s-]?\d){9})/u,
  )?.[1];
  if (labeled) return labeled.replace(/[\s-]/gu, '');

  const candidates = [...text.matchAll(/(?<!\d)(1[3-9](?:[\s-]?\d){9})(?!\d)/gu)]
    .filter((match) => !/(?:投诉|客服|官方)(?:电话|热线)?\s*[：:]?\s*$/u.test(
      text.slice(Math.max(0, match.index - 12), match.index),
    ))
    .map((match) => match[1].replace(/[\s-]/gu, ''));
  const uniqueCandidates = [...new Set(candidates)];
  return uniqueCandidates.length === 1 ? uniqueCandidates[0] : null;
};

const pickupAddressFromTrace = (text) => {
  const pickupCodeLocation = text.match(
    /(?:凭)?(?:取件码|提货码)[^。；;\n]{0,40}?(?:在|至|到)\s*[【\[]([^】\]\n]{2,100})[】\]](?:领取|取件|自取)?/u,
  )?.[1]?.trim();
  if (pickupCodeLocation) return pickupCodeLocation;
  const deliveredLocation = text.match(
    /(?:已)?(?:派送|投递|存放|放置|送达)(?:至|到)?\s*[【\[]([^】\]\n]{2,100})[】\]]/u,
  )?.[1]?.trim();
  if (deliveredLocation) return deliveredLocation;
  const serviceProvider = text.match(/服务由\s*([^。；;\n]{2,80}?)\s*提供/u)?.[1]?.trim();
  if (serviceProvider) return serviceProvider;
  const sentences = text.split(/[。；;\n]/u).map((value) => value.trim()).filter(Boolean);
  return sentences.find((value) => deliveryStationPattern.test(value))?.slice(0, 100) || null;
};

export const extractDeliveredNotReceivedLogistics = (timeline) => {
  const nodes = latestTimelineNode(timeline);
  const signedNode = nodes.find((node) => signedDeliveryPattern.test(node.text)) || null;
  const matchedNode = signedNode || nodes[0] || null;
  if (!matchedNode) {
    return {
      status: 'logistics-not-found',
      deliveryAddress: null,
      confirmationAddress: null,
      courierPhone: null,
      pickupAddress: null,
      situationConfirm: null,
      signType: 'UNKNOWN',
      matchedNode: null,
    };
  }
  const completeTrace = traceWithoutTimestamp(matchedNode.text);
  const deliveryAddress = completeTrace.slice(0, 200);
  const courierPhone = deliveryPhoneFromTrace(completeTrace);
  const extractedPickupAddress = pickupAddressFromTrace(completeTrace);
  // Explicit doorstep or personal-receipt evidence is more authoritative than
  // a carrier service-provider suffix that also happens to name a local shop.
  const signed = Boolean(signedNode);
  const deliveredToStation = deliveryStationPattern.test(deliveryAddress)
    && /(?:已)?(?:派送|投递|存放|放置|送达)(?:至|到)|服务由\s*.+?\s*提供/u.test(deliveryAddress);
  const doorstep = signed && doorstepDeliveryPattern.test(deliveryAddress);
  const station = deliveredToStation
    || (signed && deliveryStationPattern.test(deliveryAddress));
  const delivered = signed || station;
  const signType = doorstep ? 'DOORSTEP' : station ? 'STATION' : signed ? 'UNKNOWN' : 'IN_TRANSIT';
  const situationConfirm = doorstep || !delivered ? '快递会联系消费者' : '需要消费者自取';
  const pickupAddress = extractedPickupAddress
    || (situationConfirm === '需要消费者自取' ? deliveryAddress.slice(0, 100) : null);
  const confirmationAddress = (
    station && extractedPickupAddress ? extractedPickupAddress : deliveryAddress
  ).slice(0, 100);
  return {
    status: courierPhone ? 'ready' : 'courier-phone-missing',
    deliveryAddress,
    confirmationAddress,
    courierPhone,
    pickupAddress,
    pickupAddressSource: extractedPickupAddress
      ? 'service-provider-or-station-sentence'
      : pickupAddress
        ? 'complete-trace-fallback'
        : null,
    situationConfirm,
    situationSelectionStrategy: doorstep
      ? 'explicit-doorstep-evidence'
      : !signed
        ? 'in-transit-fallback'
        : station
          ? 'explicit-station-evidence'
          : 'unknown-signed-default-self-pickup',
    signType,
    matchedNode: {
      text: matchedNode.text,
      occurredAt: matchedNode.occurredAt,
    },
  };
};

export const detectConsumerRefusalInterception = (facts = {}) => {
  const timeline = facts.shippingLogisticsTimeline ?? facts.logisticsTimeline ?? [];
  const nodes = latestTimelineNode(timeline);
  const evidenceSources = [
    facts.tmsReplyResult,
    facts.tmsQuickReplyResult,
    facts.tmsCarrierReply,
    facts.tmsMatchedReplyResult,
    facts.tmsMatchedTaskStatus,
    ...nodes.map((node) => node.text),
  ].map(normalizeText).filter(Boolean);
  const evidenceText = evidenceSources.join(' ');
  const successPattern = /(?:拦截|召回)(?:已经|已)?成功|退回寄件网点|已退回(?:发货地|仓库|寄件网点|网点)|退件已签收/u;
  const failurePattern = /拦截失败|召回失败|无法拦截|拒绝拦截|派送中无法拦截/u;
  const explicitOutcome = evidenceSources
    .map((value) => failurePattern.test(value) ? 'failed' : successPattern.test(value) ? 'success' : null)
    .find(Boolean);
  const signed = detectSignedLogistics(timeline).status === 'signed';
  const status = explicitOutcome || (signed ? 'signed' : 'pending');
  return {
    status,
    canAgreeRefund: status !== 'pending' || facts.consumerRefusalConfirmed === true,
    evidenceText,
  };
};

export const isValidPlatformPrefilledPhone = (value) => {
  const phone = normalizeText(value).replace(/^\+?86/u, '').replace(/[\s-]/g, '');
  return /^1[3-9]\d{9}$/u.test(phone) || /^1[3-9]\d\*{4}\d{4}$/u.test(phone);
};

const consumerWaybillPrompt = (facts) => facts.requiresConsumerWaybillConfirmation === true
  || /请(?:(?:主动)?联系|与)消费者确认退货快递单号(?:及快递公司)?/u.test(normalizeText(
    facts.pageText ?? facts.promptText ?? facts.bodyText,
  ));

export const evaluateProactiveLogisticsService = (facts = {}, { now } = {}) => {
  const scenarioCode = ORDINARY_SCENARIO_CODES.PROACTIVE_LOGISTICS_SERVICE;
  const nowMs = resolveNow(now);
  const timeline = facts.returnLogisticsTimeline ?? facts.logisticsTimeline ?? [];
  const nodes = normalizeTimeline(timeline);
  if (consumerWaybillPrompt(facts)) {
    const option = nodes.length ? '快递单号正确' : '无法确认快递单号';
    const customerMessage = nodes.length
      ? '已查到有效退货物流轨迹，退货快递单号与页面物流信息一致。'
      : '当前未查到退货物流轨迹，暂时无法确认消费者退货快递单号。';
    return pddComplete(scenarioCode, {
      reasonCode: nodes.length
        ? 'consumer-return-waybill-confirmed-from-logistics'
        : 'consumer-return-waybill-unconfirmed-without-logistics',
      reason: nodes.length
        ? '已读取到有效退货物流轨迹，确认退货快递单号并完成工单'
        : '仍未查到退货物流轨迹，无法确认退货快递单号，按页面真实状态完成工单',
      pdd: {
        stageCode: 'consumer-waybill-confirmation',
        option,
        optionAliases: nodes.length ? ['快递单号无误'] : ['无法确认退货快递单号'],
        customerMessage,
      },
      evidence: {
        required: [{ source: 'pdd-return-logistics-screenshot', required: true }],
        returnLogisticsNodeCount: nodes.length,
      },
    });
  }
  if (!nodes.length) {
    const timing = extractOrdinaryWorkOrderTiming({ ...facts, logisticsTimeline: timeline, now: nowMs });
    let createdAtMs = timestampMs(timing.workOrderCreatedAt);
    let workOrderAgeSource = 'platform-created-at';
    const firstObservedAtMs = timestampMs(
      facts.workOrderFirstDiscoveredAt ?? facts.firstDiscoveredAt ?? facts.discoveredAt,
    );
    if ((!Number.isFinite(createdAtMs) || createdAtMs > nowMs + 5 * 60_000)
      && Number.isFinite(firstObservedAtMs)
      && firstObservedAtMs <= nowMs + 5 * 60_000) {
      createdAtMs = firstObservedAtMs;
      workOrderAgeSource = 'first-observed-lower-bound';
    }
    if (!Number.isFinite(createdAtMs) || createdAtMs > nowMs + 5 * 60_000) {
      createdAtMs = null;
      workOrderAgeSource = 'unreadable-time-not-required-for-current-option';
    }
    const stale = Number.isFinite(createdAtMs) && nowMs - createdAtMs > 2 * DAY_MS;
    return pddComplete(scenarioCode, {
      reasonCode: stale
        ? 'return-logistics-not-found-over-48-hours'
        : Number.isFinite(createdAtMs)
          ? 'return-logistics-not-found-within-48-hours'
          : 'return-logistics-not-found-with-unreadable-time',
      reason: stale
        ? '工单发起超过 48 小时仍未查到退货物流轨迹'
        : Number.isFinite(createdAtMs)
          ? '未查到有效退货物流轨迹'
          : '未查到有效退货物流轨迹，时间字段不可读但不影响当前处理选项',
      pdd: {
        option: '未收到退货商品',
        resultOption: '未查到退货物流轨迹',
        resultRequiredAfterPrimary: true,
      },
      evidence: {
        required: [{ source: 'pdd-return-logistics-screenshot', required: false }],
        returnLogisticsNodeCount: nodes.length,
        workOrderAgeSource,
      },
    });
  }
  return pddComplete(scenarioCode, {
    reasonCode: 'return-logistics-found',
    reason: '已查到有效退货物流轨迹',
    pdd: {
      option: '未收到退货商品',
      resultOption: '有退货物流轨迹',
      resultRequiredAfterPrimary: true,
    },
    evidence: { returnLogisticsNodeCount: nodes.length },
  });
};

export const matchReverseSignedRefundChangsha = (facts = {}) => {
  const returnNodes = normalizeTimeline(facts.returnLogisticsTimeline ?? []);
  const shippingNodes = normalizeTimeline(facts.shippingLogisticsTimeline ?? []);
  const matchIn = (nodes) => nodes.find((node) => node.text.includes('长沙')) || null;
  const returnMatch = matchIn(returnNodes);
  const shippingMatch = returnNodes.length ? null : matchIn(shippingNodes);
  const matchedNode = returnMatch || shippingMatch;
  return {
    matched: Boolean(matchedNode),
    matchedSource: returnMatch ? 'return' : shippingMatch ? 'shipping' : 'none',
    returnMatched: Boolean(returnMatch),
    shippingMatched: returnNodes.length ? null : Boolean(shippingMatch),
    returnLogisticsHasData: returnNodes.length > 0,
    returnLogisticsNodeCount: returnNodes.length,
    shippingLogisticsNodeCount: returnNodes.length ? 0 : shippingNodes.length,
    matchedNode: matchedNode ? {
      text: matchedNode.text,
      occurredAt: matchedNode.occurredAt,
    } : null,
  };
};

export const evaluateReverseLogisticsSignedRefund = (facts = {}, { now } = {}) => {
  const scenarioCode = ORDINARY_SCENARIO_CODES.REVERSE_LOGISTICS_SIGNED_REFUND;
  const nowMs = resolveNow(now);
  const changsha = matchReverseSignedRefundChangsha(facts);
  if (changsha.matched) {
    return pddComplete(scenarioCode, {
      reasonCode: changsha.matchedSource === 'return'
        ? 'reverse-logistics-changsha-matched'
        : 'shipping-logistics-changsha-fallback-matched',
      reason: changsha.matchedSource === 'return'
        ? '退货物流任一有效轨迹节点包含长沙，同意退款并完成工单'
        : '退货物流无有效数据，发货物流任一有效轨迹节点包含长沙，同意退款并完成工单',
      pdd: {
        stageCode: 'agree-refund',
        option: '同意退款',
        optionAliases: ['同意消费者退款申请', '已同意退货退款'],
      },
      evidence: { changsha },
    });
  }
  const retryAfterMs = 30 * 60_000;
  return waitDecision(scenarioCode, {
    reasonCode: changsha.returnLogisticsHasData
      ? 'reverse-logistics-changsha-not-found'
      : 'shipping-logistics-changsha-not-found-after-return-empty',
    reason: changsha.returnLogisticsHasData
      ? '退货物流已有有效轨迹，但所有节点均不包含长沙；不读取发货物流，等待退货物流更新'
      : '退货物流无有效数据，发货物流所有有效节点也不包含长沙；等待物流更新',
    nextAttemptAt: new Date(nowMs + retryAfterMs).toISOString(),
    requiredSystems: ['PDD'],
    evidence: { changsha },
  });
};

export const evaluateInterceptRecall = (facts = {}, { now } = {}) => {
  const scenarioCode = ORDINARY_SCENARIO_CODES.INTERCEPT_RECALL;
  resolveNow(now);
  const timeline = facts.shippingLogisticsTimeline ?? facts.logisticsTimeline ?? [];
  const detected = detectSignedLogistics(timeline);
  const observedSignedStatus = facts.shippingSigned === true
    ? 'signed'
    : facts.shippingSigned === false ? 'unsigned' : detected.status;
  const unknownTreatedAsUnsigned = observedSignedStatus === 'unknown';
  const signedStatus = unknownTreatedAsUnsigned ? 'unsigned' : observedSignedStatus;
  const signedEvidence = {
    signedDetection: detected,
    observedSignedStatus,
    selectionStrategy: unknownTreatedAsUnsigned
      ? 'unknown-treated-as-unsigned'
      : 'explicit-logistics-sign-status',
  };
  const commonFlowCompleted = facts.omsTmsFlowCompleted === true
    || facts.commonOmsTmsCompleted === true
    || (facts.omsLookupCompleted === true && facts.tmsLookupCompleted === true);
  if (!commonFlowCompleted) {
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'oms-tms-common-flow',
      reasonCode: 'intercept-oms-tms-prerequisite-required',
      reason: '拦截工单的签收与未签收分支都必须先完成现有 OMS+TMS 公共链路',
      requiredSystems: ['OMS', 'TMS'],
      external: { action: 'execute-common-oms-tms-flow' },
      pdd: {
        pendingOption: signedStatus === 'signed' ? '消费者已收到货' : '已进行召回',
      },
      evidence: signedEvidence,
    });
  }
  if (uploadFailed(facts)) {
    return manualDecision(scenarioCode, {
      reasonCode: signedStatus === 'signed'
        ? 'pdd-shipping-evidence-upload-failed'
        : 'pdd-tms-recall-evidence-upload-failed',
      reason: signedStatus === 'signed'
        ? '拼多多最新已签收物流截图上传失败，需要人工完成工单'
        : '拼多多上传 TMS 召回凭证失败（TMS 召回工单和凭证已生成），需要人工完成拼多多工单',
      requiredSystems: ['PDD', 'OMS', 'TMS'],
      evidence: signedEvidence,
    });
  }
  if (signedStatus === 'signed') {
    return pddComplete(scenarioCode, {
      reasonCode: 'consumer-received-shipment',
      reason: '发货物流已明确显示消费者签收',
      requiredSystems: ['OMS', 'TMS'],
      pdd: { option: '消费者已收到货' },
      evidence: {
        required: [{ source: 'pdd-shipping-logistics-screenshot', required: true }],
        ...signedEvidence,
      },
    });
  }

  const recallCompleted = facts.tmsRecallCompleted === true || facts.recallCompleted === true;
  const recallEvidenceReady = facts.tmsEvidenceReady === true
    || Boolean(facts.tmsEvidencePath ?? facts.recallEvidencePath);
  if (recallCompleted && recallEvidenceReady) {
    return pddComplete(scenarioCode, {
      reasonCode: 'unsigned-shipment-recalled',
      reason: '消费者尚未签收，OMS/TMS 召回已完成且凭证已准备',
      requiredSystems: ['OMS', 'TMS'],
      pdd: { option: '已进行召回' },
      evidence: {
        required: [{ source: 'tms-recall-evidence', required: true }],
        ...signedEvidence,
      },
    });
  }
  return decision(scenarioCode, {
    outcome: 'external-action',
    actionCode: 'tms-recall',
    reasonCode: recallCompleted
      ? 'tms-recall-evidence-required'
      : unknownTreatedAsUnsigned
        ? 'unknown-sign-status-recall-required'
        : 'unsigned-shipment-recall-required',
    reason: recallCompleted
      ? '召回已完成，需要获取 TMS 凭证后再提交拼多多'
      : unknownTreatedAsUnsigned
        ? '未识别到可靠签收证据，按未签收兜底并执行 OMS/TMS 召回'
        : '消费者尚未签收，需要按公共 OMS/TMS 链路执行召回',
    requiredSystems: ['OMS', 'TMS'],
    external: {
      action: recallCompleted ? 'capture-tms-recall-evidence' : 'execute-oms-tms-recall',
    },
    pdd: { pendingOption: '已进行召回' },
    evidence: signedEvidence,
  });
};

export const evaluateGoodDeedExpeditedShipping = (facts = {}, { now } = {}) => {
  const scenarioCode = ORDINARY_SCENARIO_CODES.GOOD_DEED_EXPEDITED_SHIPPING;
  const nowMs = resolveNow(now);
  if (facts.omsAllocated !== true && facts.omsAllocated !== false) {
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'oms-allocation-check',
      reasonCode: 'oms-allocation-status-required',
      reason: '处理拼多多前只需在 OMS 核实订单配货状态',
      requiredSystems: ['OMS'],
      external: { action: 'query-allocation-status', system: 'OMS' },
    });
  }

  const timeline = facts.shippingLogisticsTimeline ?? facts.logisticsTimeline ?? [];
  const pickedUp = facts.shippingPickedUp === true
    ? { status: 'picked-up', matched: true, matchedNode: null, validNodeCount: normalizeTimeline(timeline).length }
    : detectPickedUpLogistics(timeline);
  if (pickedUp.status === 'picked-up') {
    return pddComplete(scenarioCode, {
      reasonCode: 'shipping-picked-up',
      reason: '发货物流已明确显示已揽收或已揽件',
      requiredSystems: ['OMS'],
      pdd: { option: '已揽件' },
      evidence: { pickedUpDetection: pickedUp },
    });
  }

  const timing = extractOrdinaryWorkOrderTiming({ ...facts, logisticsTimeline: timeline, now: nowMs });
  const deadlineUnreadable = timing.remainingDurationMs === null;
  if (timing.remainingDurationMs >= 2 * HOUR_MS) {
    return waitDecision(scenarioCode, {
      reasonCode: 'not-picked-up-with-at-least-two-hours-remaining',
      reason: '尚未明确揽件，但工单剩余时长仍有两小时或以上',
      requiredSystems: ['PDD'],
      nextAttemptAt: new Date(
        nowMs + Math.max(60_000, timing.remainingDurationMs - 2 * HOUR_MS + 1_000),
      ).toISOString(),
      evidence: {
        pickedUpDetection: pickedUp,
        remainingDurationMs: timing.remainingDurationMs,
      },
    });
  }
  if (uploadFailed(facts)) {
    return manualDecision(scenarioCode, {
      reasonCode: 'pdd-shipping-evidence-upload-failed',
      reason: '加急发货反馈所需的拼多多发货物流截图上传失败',
      requiredSystems: ['PDD'],
      evidence: { pickedUpDetection: pickedUp },
    });
  }
  const prefilledPhone = facts.platformPrefilledPhone
    ?? facts.prefilledPhone
    ?? facts.consumerPhone
    ?? facts.phone;
  if (!isValidPlatformPrefilledPhone(prefilledPhone)) {
    return manualDecision(scenarioCode, {
      reasonCode: 'platform-prefilled-phone-invalid',
      reason: '反馈前的平台预填手机号为空或格式无效，不能自动提交',
      requiredSystems: ['PDD'],
      evidence: {
        pickedUpDetection: pickedUp,
        prefilledPhonePresent: Boolean(normalizeText(prefilledPhone)),
      },
    });
  }
  return pddComplete(scenarioCode, {
    reasonCode: deadlineUnreadable
      ? 'not-picked-up-with-unreadable-deadline-immediate-feedback'
      : 'not-picked-up-with-under-two-hours-remaining',
    reason: deadlineUnreadable
      ? '未明确揽件且页面倒计时不可读，按保守策略立即反馈，避免状态不同步导致工单停滞'
      : '未明确揽件且工单剩余时长不足两小时，需要立即反馈',
    requiredSystems: ['OMS'],
    pdd: {
      option: '反馈',
      reasonOption: '其他原因',
      problemDescription: '此件快递已正常揽收走件',
    },
    evidence: {
      required: [{ source: 'pdd-shipping-logistics-screenshot', required: true }],
      captureEvenWithoutTrajectory: true,
      pickedUpDetection: pickedUp,
      remainingDurationMs: timing.remainingDurationMs,
      deadlineSelectionStrategy: deadlineUnreadable
        ? 'unreadable-deadline-immediate-feedback'
        : 'under-two-hour-threshold',
    },
  });
};

const commonOmsTmsCompleted = (facts) => facts.omsTmsFlowCompleted === true
  || facts.commonOmsTmsCompleted === true
  || (facts.omsLookupCompleted === true && facts.tmsLookupCompleted === true);

const completedOrdinaryStages = (facts) => new Set(
  Array.isArray(facts.completedPddStages) ? facts.completedPddStages : [],
);

const deliveredNotReceivedStage = (facts) => {
  const completed = completedOrdinaryStages(facts);
  if (completed.has('evidence')) return 'result';
  if (completed.has('confirmation')) return 'evidence';
  const body = normalizeText(facts.bodyText ?? facts.pageText);
  if (/请您填写核实结果|请填写货物真实情况或直接进行处理/u.test(body)) return 'result';
  if (/请您反馈当前的核实进度|请上传联系物流凭证并安抚消费者/u.test(body)) return 'evidence';
  return 'confirmation';
};

export const evaluateDeliveredNotReceived = (facts = {}, { now } = {}) => {
  const scenarioCode = ORDINARY_SCENARIO_CODES.DELIVERED_NOT_RECEIVED;
  resolveNow(now);
  const timeline = facts.shippingLogisticsTimeline ?? facts.logisticsTimeline ?? [];
  const delivery = extractDeliveredNotReceivedLogistics(timeline);
  const stage = deliveredNotReceivedStage(facts);
  if (stage !== 'evidence' && !delivery.matchedNode) {
    return manualDecision(scenarioCode, {
      reasonCode: 'signed-delivery-node-not-found',
      reason: '发货物流中未找到可用轨迹，无法填写真实送达信息',
      requiredSystems: ['PDD'],
      evidence: { delivery },
    });
  }
  if (stage === 'confirmation' && !delivery.courierPhone) {
    return manualDecision(scenarioCode, {
      reasonCode: 'courier-phone-not-found',
      reason: '最新可用物流轨迹未读取到快递员联系电话，无法完整填写第一步必填字段',
      requiredSystems: ['PDD'],
      evidence: { delivery },
    });
  }
  if (!commonOmsTmsCompleted(facts)) {
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'delivered-not-received-oms-tms-flow',
      reasonCode: 'delivered-not-received-common-flow-required',
      reason: '先按公共 OMS/TMS 链路登记签收未收到，再处理拼多多三阶段表单',
      requiredSystems: ['OMS', 'TMS'],
      external: { action: 'execute-delivered-not-received-oms-tms-flow' },
      evidence: { delivery },
    });
  }

  if (stage === 'confirmation') {
    return pddStageSubmit(scenarioCode, {
      reasonCode: 'delivery-address-confirmation-ready',
      reason: '送达信息和快递员电话已从最新可用物流轨迹读取完成',
      requiredSystems: ['OMS', 'TMS'],
      pdd: {
        stageCode: 'confirmation',
        option: '告知送达地址并承诺核实',
        deliveryAddress: delivery.confirmationAddress,
        courierPhone: delivery.courierPhone,
        generatedMessageRequired: true,
        generatedMessageMustInclude: [delivery.confirmationAddress, delivery.courierPhone],
      },
      evidence: { delivery },
    });
  }
  if (stage === 'evidence') {
    return pddStageSubmit(scenarioCode, {
      reasonCode: 'delivery-contact-evidence-ready',
      reason: 'TMS 联系物流凭证已准备，发送凭证并进入核实结果阶段',
      requiredSystems: ['OMS', 'TMS'],
      pdd: {
        stageCode: 'evidence',
        option: '发送凭证',
        generatedMessageRequired: true,
      },
      evidence: {
        delivery,
        required: [{ source: 'tms-delivery-contact-evidence', required: true }],
      },
    });
  }

  const pdd = {
    stageCode: 'result',
    option: '可以送达',
    secondaryOption: delivery.situationConfirm,
    generatedMessageRequired: true,
  };
  if (delivery.situationConfirm === '快递会联系消费者') {
    // The current PDD form renders this date field only after the secondary
    // option is selected. Today reflects an immediate carrier follow-up and
    // remains compatible with older layouts where the field is absent.
    pdd.expectedContactDateOffsetDays = 0;
  }
  if (delivery.situationConfirm === '需要消费者自取') {
    if (!delivery.pickupAddress) {
      return manualDecision(scenarioCode, {
        reasonCode: 'pickup-address-not-found',
        reason: '签收轨迹判断为自取，但未能读取真实驿站或门店名称',
        requiredSystems: ['PDD'],
        evidence: { delivery },
      });
    }
    pdd.pickupAddress = delivery.pickupAddress;
    pdd.generatedMessageMustInclude = [delivery.pickupAddress];
    pdd.generatedMessageFallback = `亲亲，快递已送达${delivery.pickupAddress}，请您前往该地点取件。`;
  }
  return pddComplete(scenarioCode, {
    reasonCode: 'delivered-not-received-result-ready',
    reason: `按最新签收轨迹选择“${delivery.situationConfirm}”并完成工单`,
    requiredSystems: ['OMS', 'TMS'],
    pdd,
    evidence: { delivery },
  });
};

const consumerRefusalStage = (facts) => {
  const completed = completedOrdinaryStages(facts);
  if (completed.has('intercept-request')) return 'result';
  const body = normalizeText(facts.bodyText ?? facts.pageText);
  if (/请反馈快递拦截情况并尽快进行处理/u.test(body)) return 'result';
  return 'intercept-request';
};

export const evaluateConsumerRefusal = (facts = {}, { now } = {}) => {
  const scenarioCode = ORDINARY_SCENARIO_CODES.CONSUMER_REFUSAL;
  const nowMs = resolveNow(now);
  const intercept = detectConsumerRefusalInterception({
    ...facts,
    consumerRefusalConfirmed: facts.consumerRefusalConfirmed !== false,
  });
  if (!commonOmsTmsCompleted(facts)) {
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'consumer-refusal-oms-tms-flow',
      reasonCode: 'consumer-refusal-common-flow-required',
      reason: '先按公共 OMS/TMS 链路登记消费者拒收拦截，再处理拼多多表单',
      requiredSystems: ['OMS', 'TMS'],
      external: { action: 'execute-consumer-refusal-oms-tms-flow' },
      evidence: { intercept },
    });
  }

  const stage = consumerRefusalStage(facts);
  if (stage === 'intercept-request') {
    if (intercept.status === 'success') {
      return pddComplete(scenarioCode, {
        reasonCode: 'existing-intercept-success',
        reason: '物流或 TMS 已明确拦截/退回成功，直接同意退款并完结',
        requiredSystems: ['OMS', 'TMS'],
        pdd: { stageCode: 'intercept-request', option: '拦截成功同意退款' },
        evidence: { intercept },
      });
    }
    return pddStageSubmit(scenarioCode, {
      reasonCode: 'intercept-request-ready',
      reason: '拦截结果尚未明确，先发送拦截进入结果反馈阶段',
      requiredSystems: ['OMS', 'TMS'],
      pdd: { stageCode: 'intercept-request', option: '发送拦截' },
      evidence: { intercept },
    });
  }

  if (intercept.canAgreeRefund) {
    return pddComplete(scenarioCode, {
      reasonCode: `consumer-refusal-refund-${intercept.status}`,
      reason: '消费者已明确拒收，结合物流/TMS 结果同意消费者退款申请',
      requiredSystems: ['OMS', 'TMS'],
      pdd: { stageCode: 'result', option: '同意退款' },
      evidence: { intercept },
    });
  }
  return pddStageSubmit(scenarioCode, {
    reasonCode: 'consumer-refusal-intercept-pending',
    reason: '包裹仍在途中且拦截结果未知，反馈待拦截快递退款后继续跟进',
    requiredSystems: ['OMS', 'TMS'],
    nextAttemptAt: new Date(nowMs + 30 * 60_000).toISOString(),
    pdd: {
      stageCode: 'result-waiting-intercept',
      option: '待拦截快递退款',
      waitAfterSubmitMs: 30 * 60_000,
    },
    evidence: { intercept },
  });
};

const PRODUCT_SHORTAGE_RECHECK_MS = 30 * 60_000;

export const classifyProductShortageTmsResult = (facts = {}) => {
  const candidates = [
    facts.productShortageTmsResultText,
    facts.tmsMatchedReplyResult,
    facts.tmsCarrierReply,
    facts.tmsQuickReplyResult,
    facts.tmsReplyResult,
  ].map((value) => String(value || '').replace(/\s+/gu, ' ').trim()).filter(Boolean);
  const resultText = candidates.find((value) => !/^(?:已完成|完成|已处理|处理完成)$/u.test(value))
    || null;
  const taskStatus = normalizeText(
    facts.productShortageTmsTaskStatus || facts.tmsMatchedTaskStatus,
  ) || null;
  const pending = !resultText || (
    /(?:待处理|处理中|核实中|联系中|未回复|暂无|稍后|等待)/u.test(resultText)
    && !/(?:确认|已核实|少发|漏发|缺少|短少|重量|未少发|没有少发|无少发)/u.test(resultText)
  );
  const completedWithoutResult = !resultText
    && /^(?:已完成|完成|已结案|已关闭)$/u.test(taskStatus || '');
  return {
    status: completedWithoutResult ? 'completed-without-result' : pending ? 'pending' : 'ready',
    resultText,
    taskStatus,
    candidates,
  };
};

const productShortageStage = (facts = {}) => {
  const completed = completedOrdinaryStages(facts);
  const body = normalizeText(facts.bodyText ?? facts.pageText);
  if (/(?:填写核实进度|已联系快递或仓库核实|确认商品少发)/u.test(body)) {
    return 'verification-contact-progress';
  }
  if (completed.has('verification-request')) return 'verification-result';
  if (/已核实[，,]?\s*填写核实结果|填写核实结果/u.test(body)) return 'verification-result';
  return 'verification-request';
};

export const evaluateProductShortage = (facts = {}, { now } = {}) => {
  const scenarioCode = ORDINARY_SCENARIO_CODES.PRODUCT_SHORTAGE;
  const nowMs = resolveNow(now);
  if (!commonOmsTmsCompleted(facts)) {
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'product-shortage-verification-flow',
      reasonCode: 'product-shortage-independent-verification-required',
      reason: '商品少发必须独立联系快递或仓库核实，不能复用其他问题类型的 TMS 记录',
      requiredSystems: ['OMS', 'TMS'],
      external: { action: 'create-product-shortage-verification-ticket' },
    });
  }

  const stage = productShortageStage(facts);
  if (stage === 'verification-request') {
    return pddStageSubmit(scenarioCode, {
      reasonCode: 'product-shortage-verification-request-ready',
      reason: '已独立登记商品少发核实，向平台承诺在 48 小时内反馈真实核实结果',
      requiredSystems: ['OMS', 'TMS'],
      nextAttemptAt: new Date(nowMs + PRODUCT_SHORTAGE_RECHECK_MS).toISOString(),
      pdd: {
        stageCode: 'verification-request',
        option: '去核实，填写核实时间',
        optionAliases: ['去核实填写核实时间', '去核实'],
        verificationDateOffsetDays: 1,
        waitAfterSubmitMs: PRODUCT_SHORTAGE_RECHECK_MS,
      },
    });
  }

  const tmsResult = classifyProductShortageTmsResult(facts);
  const completed = completedOrdinaryStages(facts);
  const resultConfirmsShortage = tmsResult.status === 'ready'
    && /(?:确认.{0,8}(?:少发|漏发|短少|缺少)|(?:少发|漏发|短少|缺少).{0,8}(?:属实|确认|一件|数量))/u
      .test(tmsResult.resultText || '')
    && !/(?:未少发|没有少发|无少发|不存在少发|数量无误)/u.test(tmsResult.resultText || '');
  if (stage === 'verification-contact-progress' && resultConfirmsShortage) {
    return pddComplete(scenarioCode, {
      reasonCode: 'product-shortage-confirmed-by-tms',
      reason: 'TMS 已明确确认商品少发，按当前页面选项确认商品少发',
      requiredSystems: ['OMS', 'TMS'],
      pdd: {
        stageCode: 'verification-contact-result',
        option: '确认商品少发',
      },
      evidence: {
        required: [{ source: 'tms-product-shortage-contact-evidence', required: true }],
        productShortageTmsResult: tmsResult,
      },
    });
  }
  if (tmsResult.status === 'ready') {
    if (stage === 'verification-contact-progress'
      && !completed.has('verification-contact-progress')) {
      return pddStageSubmit(scenarioCode, {
        reasonCode: 'product-shortage-contact-evidence-ready',
        reason: '已联系快递或仓库核实，但现有回复不能确认少发，按页面事实反馈已联系',
        requiredSystems: ['OMS', 'TMS'],
        nextAttemptAt: new Date(nowMs + PRODUCT_SHORTAGE_RECHECK_MS).toISOString(),
        pdd: {
          stageCode: 'verification-contact-progress',
          option: '已联系快递或仓库核实',
          waitAfterSubmitMs: PRODUCT_SHORTAGE_RECHECK_MS,
        },
        evidence: {
          required: [{ source: 'tms-product-shortage-contact-evidence', required: true }],
          productShortageTmsResult: tmsResult,
        },
      });
    }
    return pddComplete(scenarioCode, {
      reasonCode: 'product-shortage-verification-result-ready',
      reason: 'TMS 已返回商品少发的实际核实结果，按真实回复完成拼多多工单',
      requiredSystems: ['OMS', 'TMS'],
      pdd: {
        stageCode: 'verification-result',
        option: '已核实，填写核实结果',
        optionAliases: ['已核实填写核实结果', '已核实'],
        verificationResult: tmsResult.resultText,
      },
      evidence: { productShortageTmsResult: tmsResult },
    });
  }
  if (tmsResult.status === 'completed-without-result') {
    return manualDecision(scenarioCode, {
      reasonCode: 'product-shortage-tms-completed-without-result',
      reason: 'TMS 任务已完成但没有可回填的核实结果，禁止编造“已核实”内容',
      requiredSystems: ['TMS'],
      evidence: { productShortageTmsResult: tmsResult },
    });
  }

  const checkedAtMs = Date.parse(facts.productShortageTmsResultCheckedAt || '');
  if (!Number.isFinite(checkedAtMs) || nowMs - checkedAtMs >= PRODUCT_SHORTAGE_RECHECK_MS) {
    return decision(scenarioCode, {
      outcome: 'external-action',
      actionCode: 'product-shortage-tms-result-check',
      reasonCode: 'product-shortage-tms-result-recheck-required',
      reason: '商品少发核实仍无明确结果，重新只读检查原 TMS 记录',
      requiredSystems: ['TMS'],
      external: { action: 'refresh-product-shortage-verification-result' },
      evidence: { productShortageTmsResult: tmsResult },
    });
  }
  if (stage === 'verification-contact-progress'
    && !completed.has('verification-contact-progress')) {
    return pddStageSubmit(scenarioCode, {
      reasonCode: 'product-shortage-contact-progress-ready',
      reason: '已建立独立核实工单并联系快递或仓库，按当前页面反馈真实联系进度',
      requiredSystems: ['OMS', 'TMS'],
      nextAttemptAt: new Date(nowMs + PRODUCT_SHORTAGE_RECHECK_MS).toISOString(),
      pdd: {
        stageCode: 'verification-contact-progress',
        option: '已联系快递或仓库核实',
        waitAfterSubmitMs: PRODUCT_SHORTAGE_RECHECK_MS,
      },
      evidence: {
        required: [{ source: 'tms-product-shortage-contact-evidence', required: true }],
        productShortageTmsResult: tmsResult,
      },
    });
  }
  const nextAttemptAt = new Date(checkedAtMs + PRODUCT_SHORTAGE_RECHECK_MS).toISOString();
  return waitDecision(scenarioCode, {
    reasonCode: 'product-shortage-verification-pending',
    reason: '快递或仓库仍在核实商品少发情况，等待真实结果后再回填拼多多',
    nextAttemptAt,
    requiredSystems: ['PDD', 'TMS'],
    evidence: { productShortageTmsResult: tmsResult },
  });
};

export const evaluateOrdinaryWorkOrderScenario = (scenarioCode, facts, options) => {
  const evaluators = {
    [ORDINARY_SCENARIO_CODES.DELIVERY_RISK_CONCERN]: evaluateDeliveryRiskConcern,
    [ORDINARY_SCENARIO_CODES.PROACTIVE_LOGISTICS_SERVICE]: evaluateProactiveLogisticsService,
    [ORDINARY_SCENARIO_CODES.REVERSE_LOGISTICS_SIGNED_REFUND]: evaluateReverseLogisticsSignedRefund,
    [ORDINARY_SCENARIO_CODES.INTERCEPT_RECALL]: evaluateInterceptRecall,
    [ORDINARY_SCENARIO_CODES.GOOD_DEED_EXPEDITED_SHIPPING]: evaluateGoodDeedExpeditedShipping,
    [ORDINARY_SCENARIO_CODES.DELIVERED_NOT_RECEIVED]: evaluateDeliveredNotReceived,
    [ORDINARY_SCENARIO_CODES.CONSUMER_REFUSAL]: evaluateConsumerRefusal,
    [ORDINARY_SCENARIO_CODES.PRODUCT_SHORTAGE]: evaluateProductShortage,
  };
  const evaluator = evaluators[scenarioCode];
  if (!evaluator) {
    return manualDecision(String(scenarioCode || 'unknown'), {
      reasonCode: 'unsupported-ordinary-scenario',
      reason: `未实现普通工单场景：${normalizeText(scenarioCode) || 'unknown'}`,
    });
  }
  return evaluator(facts, options);
};
